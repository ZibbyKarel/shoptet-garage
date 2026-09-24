-- TODO item 4: an admin can mark a spot as having an EV charger
-- (`doc/decision/0317-the-ev-charger-flag-is-informational-and-shown-to-everyone`).
-- No existing spot has one until an admin says so.
ALTER TABLE "ParkingSpot" ADD COLUMN "evCharger" BOOLEAN NOT NULL DEFAULT false;
