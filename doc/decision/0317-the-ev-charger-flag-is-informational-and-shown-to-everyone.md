# 0317 – The EV charger flag is informational and shown to everyone

**Date:** 2026-09-24 · **Status:** accepted · **Task:** `TODO.md` item 4

## What

`ParkingSpot.evCharger` (default `false`) marks a spot as having a charger
for electric cars. It is set through `admin.spot.update({ id, evCharger })` —
the same mutation that sets `hidden` and the plain fields — and audited as
`SPOT_UPDATED` with `evCharger` in the before/after snapshot.

Unlike `hidden`, the flag carries no access rule at all: `parkingSpotSchema`
includes it for every spot the reader can see (`spot.list`, `overview.day`, the
admin spots table, for admins and normal users alike) — hidden spots stay
filtered per 0316, independently of this flag. A green lightning-bolt
glyph renders it wherever a spot tile is shown, with the accessible name
"Nabíječka pro elektromobily".

## Why

- **The spec says informational only.** It does not change reservation, bulk,
  waitlist or cap rules, so `SpotsService.update` writes it with no side
  effect — no hidden-id set, no "still has commitments" check, nothing that
  runs for `active` or `hidden`. Setting it on a spot someone holds today, or
  on a hidden spot, always succeeds.
- **Shown to everyone, deliberately not gated on `isAdmin`.** `hidden` exists
  to keep a spot's existence itself a secret from normal users; a charger
  is a physical fact about a bay everybody can already see, so gating it the
  same way would be copying a rule that does not apply here.
- **One glyph, one primitive.** The bolt is a `libs/shared/design-system`
  primitive, not app code, and reuses `--brand-green` / `--brand-dark` token
  values already in the palette rather than adding an icon library.

## Consequences

- No gateway filtering, no Slack digest change, no realtime event: other
  viewers pick it up on their next `overview.day` fetch, as with every
  other spot field.
- A spot can be both hidden and charged; the two flags are independent and
  both render in the tile's corner without one hiding the other.
