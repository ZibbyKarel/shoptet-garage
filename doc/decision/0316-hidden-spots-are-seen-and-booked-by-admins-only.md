# 0316 – Hidden spots are seen and booked by admins only

**Date:** 2026-09-24 · **Status:** accepted · **Task:** `TODO.md` item 3

## What

`ParkingSpot.hidden` (default `false`) marks a spot as the admins'. It is set
through `admin.spot.update({ id, hidden })` — the "Skryté" switch on the
Parkovací místa tab — and audited as `SPOT_UPDATED` with `hidden` in the
before/after snapshot.

| path                                | admin                     | normal user                                                  |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `overview.day` (lot, counts)        | every spot, `hidden` set  | visible spots + a hidden one they hold or queue for that day |
| `spot.list` (preferred-spot picker) | visible spots only        | visible spots only                                           |
| `reservation.create`                | allowed, for anybody      | `NOT_FOUND`                                                  |
| `waitlist.join`                     | allowed, for anybody      | `NOT_FOUND`                                                  |
| `admin.timedReservation.create`     | allowed                   | — (admin-only procedure)                                     |
| bulk preview / confirm              | never assigned or queued  | never assigned or queued                                     |
| `me.updateSettings` preferred spot  | `NOT_FOUND`               | `NOT_FOUND`                                                  |
| Slack digest / "spot freed" post    | left out / not sent       | left out / not sent                                          |
| realtime broadcasts about the spot  | delivered                 | not delivered                                                |
| ICS feed, own month list            | own reservations, as ever | own reservations, as ever                                    |

## Why

- **Hiding is not retiring.** A retired spot is out of service; a hidden one
  is in service for whoever an admin puts there. So hiding never runs the
  "still has commitments" check, and existing reservations, queues and guest
  blocks survive it.
- **`NOT_FOUND`, the retired spot's answer**, because to a normal user the
  spot does not exist; a distinct code would confirm that it does.
- **The holder still sees it.** A reservation an admin made for somebody is
  theirs: the lot keeps that one tile for them (so they can cancel it), and
  the ICS feed and month list never filtered by spot at all.
- **No preferred hidden spot**, for admins either: bulk booking never assigns
  one, so storing the preference would be a promise nothing keeps.
- **Realtime is filtered at the gateway.** Every server → client event
  carries `parkingSpotId`, so one check in `emitToDay` covers the domain
  events and the cell lock alike. It needs a synchronous answer, which
  `SpotsService.isHidden` gives from an in-process id set loaded at boot and
  updated by `SpotsService.update`.

## Consequences

- **Single instance only**, twice over: the hidden-id set is per process, and
  the admin-only emit walks the local room. A second instance needs the
  column read per broadcast (or shared) and a role room with
  `.except()` — the same upgrade path `doc/realtime.md` already describes.
- A spot hidden while a normal user has the lot open disappears on their next
  refetch, not live — the same as a retirement; no event announces a spot
  change, whether it is hidden, unhidden, or just changes what a normal user
  can see about it.
- A normal user holding a reservation or a queue entry on a hidden spot gets
  no live update for that cell either — every event about it goes to admin
  sockets only — so their tile is only as fresh as their last fetch, remount
  or reconnect. An admin cancelling that reservation, for instance, leaves
  their tile stale until then.
- The socket's role is the one at handshake time; an admin demoted mid-session
  keeps hearing hidden-spot traffic until they reconnect.
- A non-admin `cell:lock` on a hidden spot is dropped silently, with no
  acknowledgement: `cellLockAckSchema` has no `NOT_FOUND` variant, and
  `HELD_BY_OTHER` would name an admin holder to a caller who is not supposed
  to know the spot exists at all.
- The Slack digest's "waiting" count still counts queues on hidden spots; it
  names no spot, so it was left as it is.
