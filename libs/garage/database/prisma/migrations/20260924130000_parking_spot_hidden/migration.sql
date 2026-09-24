-- TODO item 3: an admin can hide a spot so that only admins see it
-- (`doc/decision/0316-hidden-spots-are-seen-and-booked-by-admins-only`).
-- Every existing spot stays visible.
ALTER TABLE "ParkingSpot" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
