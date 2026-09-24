-- A guest booked into a half-hour-granular block of one day, on one spot.
-- Storage is minutes since local midnight, not the contract's `HH:MM`
-- strings — see `doc/database.md` (§"Where storage differs from the
-- contract") and `doc/decision/0314-*`.
CREATE TABLE "TimedReservation" (
    "id" UUID NOT NULL,
    "parkingSpotId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" SMALLINT NOT NULL,
    "endMinute" SMALLINT NOT NULL,
    "guestName" TEXT NOT NULL,
    "licensePlate" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimedReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimedReservation_parkingSpotId_date_idx" ON "TimedReservation"("parkingSpotId", "date");

-- CreateIndex
CREATE INDEX "TimedReservation_date_idx" ON "TimedReservation"("date");

-- AddForeignKey
ALTER TABLE "TimedReservation" ADD CONSTRAINT "TimedReservation_parkingSpotId_fkey" FOREIGN KEY ("parkingSpotId") REFERENCES "ParkingSpot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Half-open [startMinute, endMinute) on the half-hour grid, within one day.
ALTER TABLE "TimedReservation" ADD CONSTRAINT "TimedReservation_range_check"
  CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute"
         AND "startMinute" % 30 = 0 AND "endMinute" % 30 = 0);

-- One (spot, day) is either one full-day "Reservation" or any number of
-- non-overlapping "TimedReservation" blocks — never both. Two tables cannot
-- share a unique index, so the rule is two triggers serialised by one
-- transaction-scoped advisory lock per (spot, day) — BEFORE on
-- "TimedReservation", AFTER on "Reservation" (why, below). READ COMMITTED gives every
-- statement inside the function a fresh snapshot, so the EXISTS below runs
-- after the lock is granted and sees whatever the previous holder committed.
--
-- The error is raised as `unique_violation` with a named constraint on
-- purpose: `@prisma/adapter-pg` turns it into an ordinary P2002 whose
-- `constraint.index` is that name, so every writer's existing unique-violation
-- handling applies and `mapUniqueConstraintViolation` answers
-- SPOT_ALREADY_RESERVED. See doc/decision/0314-*.
--
-- The lock key's text prefix keeps it apart from the monthly cap's
-- `<userId>:<YYYY-MM>` keys (monthly-reservation-cap.ts).
CREATE FUNCTION "lock_spot_day"(spot UUID, day DATE) RETURNS VOID AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('spot-day:' || spot::text || ':' || day::text, 0));
$$ LANGUAGE sql VOLATILE;

CREATE FUNCTION "timed_reservation_reject_conflict"() RETURNS TRIGGER AS $$
BEGIN
  PERFORM "lock_spot_day"(NEW."parkingSpotId", NEW."date");
  IF EXISTS (
    SELECT 1 FROM "Reservation"
    WHERE "parkingSpotId" = NEW."parkingSpotId" AND "date" = NEW."date"
  ) OR EXISTS (
    SELECT 1 FROM "TimedReservation"
    WHERE "parkingSpotId" = NEW."parkingSpotId" AND "date" = NEW."date"
      AND "id" <> NEW."id"
      AND "startMinute" < NEW."endMinute" AND NEW."startMinute" < "endMinute"
  ) THEN
    RAISE EXCEPTION 'Spot % is already taken on % for that time', NEW."parkingSpotId", NEW."date"
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'TimedReservation_spot_day_conflict';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "timed_reservation_reject_conflict"
  BEFORE INSERT OR UPDATE OF "parkingSpotId", "date", "startMinute", "endMinute" ON "TimedReservation"
  FOR EACH ROW EXECUTE FUNCTION "timed_reservation_reject_conflict"();

CREATE FUNCTION "reservation_reject_timed_conflict"() RETURNS TRIGGER AS $$
BEGIN
  PERFORM "lock_spot_day"(NEW."parkingSpotId", NEW."date");
  IF EXISTS (
    SELECT 1 FROM "TimedReservation"
    WHERE "parkingSpotId" = NEW."parkingSpotId" AND "date" = NEW."date"
  ) THEN
    RAISE EXCEPTION 'Spot % has timed guest reservations on %', NEW."parkingSpotId", NEW."date"
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'Reservation_timed_reservation_conflict';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- AFTER, not BEFORE, on purpose: a "Reservation" writer must meet the unique
-- index `(parkingSpotId, date)` *before* it takes the spot-day lock, so the
-- lock order is always row-then-advisory — the order a cancellation already
-- has, since its DELETE holds the old row's index entry when its promotion's
-- INSERT reaches this trigger. As BEFORE, a create racing a cancellation took
-- the lock, then waited on the cancellation's deleted-but-uncommitted index
-- entry, while the promotion inside that cancellation waited on the lock:
-- `40P01` and `CONFLICT` instead of the SPOT_ALREADY_RESERVED it answered
-- before this migration (`waitlist-concurrency.db.spec.ts`). As AFTER, the
-- create waits on the index exactly as it did before, and a Reservation writer
-- only ever takes the lock once its cell is uncontended by other Reservations.
-- Correctness is unchanged: the row is already inserted (uncommitted) when the
-- lock is taken, and the TimedReservation side — which does not see that row —
-- must wait for this lock before its EXISTS, so it sees the committed row. An
-- `INSERT … ON CONFLICT DO NOTHING` also no longer takes locks for rows it skips.
CREATE TRIGGER "reservation_reject_timed_conflict"
  AFTER INSERT OR UPDATE OF "parkingSpotId", "date" ON "Reservation"
  FOR EACH ROW EXECUTE FUNCTION "reservation_reject_timed_conflict"();

-- Two new audit actions (Task 2's contract addition). `ADD VALUE IF NOT
-- EXISTS` rather than a recreate, for the reason
-- `20260902090000_audit_reservation_window_updated` gives at length:
-- rewriting the type would mean dropping and re-adding "AuditLog"."action",
-- and an UPDATE against that append-only table is rejected by the database.
ALTER TYPE "AuditLogAction" ADD VALUE IF NOT EXISTS 'TIMED_RESERVATION_CREATED';
ALTER TYPE "AuditLogAction" ADD VALUE IF NOT EXISTS 'TIMED_RESERVATION_CANCELLED';
