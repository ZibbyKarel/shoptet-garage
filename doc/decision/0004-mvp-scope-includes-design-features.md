# 0004 – MVP scope also includes features that exist only in the design

**Date:** 2026-08-28 · **Status:** accepted (decided by the user) · **Amends:** `plan.md` §Doménový model, §Byznys pravidla

## What

The MVP also includes three features that are present in the finished design but
missing from the `plan.md` domain model. Where they conflict, **the design wins**:

### 1. Reservation window with a lock

A new settings entity (singleton) `ReservationWindowSettings`:

| Field | Type | Default |
| --- | --- | --- |
| `openDaysBefore` | int (1–31) | `7` |
| `lockMode` | `AUTO` \| `FORCE_OPEN` \| `FORCE_LOCKED` | `AUTO` |

Deriving the month state (exactly per `doc/design/garage-design.dc.html`, function
`monthOpen`, lines 546–554):

```
isMonthOpen(targetDate, openDaysBefore, lockMode, today):
  FORCE_OPEN   -> true
  FORCE_LOCKED -> false
  AUTO         -> first = 1st day of month targetDate
                  from  = first - openDaysBefore days
                  return today >= from && today < first
```

Three displayed month states: `Zatím neotevřeno` ("not yet open"; today < from),
`Otevřeno` ("open"; from ≤ today < first), `Uzamčeno` ("locked"; today ≥ first). I.e.
**as soon as a month starts, it is locked** — a regular reservation for the current
month is no longer possible.

Effect on the rules:

- In a locked month a **regular user may not**: create a reservation, join the
  waitlist, leave the waitlist, start a bulk reservation.
- In a locked month a **regular user may**: cancel their own reservation (at any time).
- **The admin is not constrained** by the reservation window at all.
- The check happens on the backend (not only in the UI) and returns a new error code,
  `RESERVATIONS_LOCKED`.

This rule **replaces** the wording in `plan.md`, "at most until the end of the following
month". The horizon is still bounded, but its boundary is the reservation window, not a
fixed "end of next month". Preserved: only today and the future can be reserved
(Europe/Prague).

### 2. Bulk reservation

A two-step flow (`doc/design/screens/10-modal-bulk.png`):

1. **Day selection** – a calendar grid for the month (columns Mon–Sun). Weekends and
   Czech public holidays cannot be selected. Selection happens within a single month.
2. **Schedule proposal** – for each selected day the server proposes: the preferred
   spot (if free) → another free spot → placement on the waitlist with a position. The
   user reviews the proposal and confirms it (`Potvrdit rozvrh`, "confirm schedule"),
   or goes back to selection.

The proposal is a **read-only computation** (it reserves nothing). Confirmation is a
single transaction; days that someone else has taken in the meantime fall onto the
waitlist — the result is returned to the user, not discarded. It respects the rule of
max 1 reservation per user per day.

### 3. Preferred parking spot

A new nullable field, `User.preferredParkingSpotId`. Set in the profile
(`doc/design/screens/11-settings.png`), used **exclusively** as the first choice during
a bulk reservation. It has no effect on a regular single-day reservation.

### 4. ICS stays

The design does **not** have an ICS section in the profile settings, but `plan.md`
requires one — it is added in the same visual style (see Task 26).

## Why

The user was presented with three scope options (`plan.md` only, `plan.md` + the
reservation window, the full design) and explicitly chose **the full design scope**.
The design chat also shows the reservation window was requested deliberately, describing
a real company rule ("spots can typically only be reserved a week before the new month,
for the new month"). The design is therefore newer than `plan.md` and takes precedence
in a conflict.

## How

The features are **not inserted as a separate phase**, but dissolved into the existing
phases so the contract-first order is preserved:

| Where | What is added |
| --- | --- |
| Task 3 (schemas) | `ReservationWindowSettings`, `MonthLockState`, `User.preferredParkingSpotId`, error code `RESERVATIONS_LOCKED`, pure function `isMonthOpen` in `libs/garage/shared-types` |
| Task 4 (oRPC contract) | reading/changing the window settings, an overview of month states, proposing and confirming a bulk reservation, setting the preferred spot |
| Task 9 (Prisma) | settings table (singleton), FK `preferredParkingSpotId` |
| Task 12 (modules) | admin management of the reservation window, preferred spot in user settings |
| Task 13 (reservations) | enforcing the lock on create/join/leave; canceling one's own reservation stays allowed |
| **Task 30 (new)** | backend allocator and transaction for the bulk reservation |
| Task 24 (parking lot) | window-state banner, "reservations locked" tile, explanatory modal |
| **Task 31 (new)** | FE bulk-reservation modal |
| Task 26 (settings) | preferred spot + ICS section |
| Task 27 (admin) | "Reservation window" tab |

## Risk if this is wrong

The biggest uncertainty is the bulk reservation: in the design the allocator is only
sketched with dummy code, so the actual strategy (spot ordering, conflict behavior) is
our own design. If we get it wrong, what changes is one backend service and one FE modal
— the contract and data model stay the same. The reservation window, by contrast, is
described unambiguously in the design, including the calculation, so there is
practically no risk there.
