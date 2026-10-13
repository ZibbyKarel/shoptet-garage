# Visual design – source of truth (downloaded locally)

The link from `plan.md` (§"Vizuální design – zdroj pravdy" / "Visual design –
source of truth") was **successfully opened** (Playwright, a logged-in
claude.ai session) and fully downloaded here, so subagents without browser
access can read it too.

| File | What it is |
| --- | --- |
| `garage-design.dc.html` | The complete design source (Claude Design `.dc.html`). **The binding source of truth for the visuals.** Contains every screen, state, and modal as inline-styled markup + a `DCLogic` class with sample data. |
| `ds/colors_and_type.css` | "Shoptet Design System — Foundations": colors, typography, spacing, radius, shadows, motion, layout as CSS custom properties. **This is the source of truth for `libs/shared/design-system/src/tokens`.** |
| `ds/fonts/*.otf` | Neue Haas Grotesk Display Pro (8 weights) used by the design. |
| `ds/support.js` | The Claude Design runtime (for reference only, not copied into the product). |
| `screens/*.png` | Screenshots of individual screens and states (see the table below). |

## Screenshots

| File | Screen / state |
| --- | --- |
| `screens/canvas-default.png` | Login (signed-out state) – logo, tagline, `Login přes OKTA Verify` ("Log in with OKTA Verify") button |
| `screens/07-lot.png`, `01-lot-admin.png` | Parking lot overview – `admin` role |
| `screens/12-lot-user.png`, `13-lot-user-bottom.png` | Parking lot overview – `user` role |
| `screens/02-avatar-menu.png` | The avatar dropdown (`Nastavení` / `Správa` / `Odhlásit` — "Settings" / "Administration" / "Log out") |
| `screens/08-modal-reserve.png` | The `Rezervovat místo` ("Reserve a spot") modal |
| `screens/09-modal-queue.png` | The `Přidat se do fronty` ("Join the waitlist") modal (current holder + queue position) |
| `screens/10-modal-bulk.png` | The `Hromadná rezervace` ("Bulk reservation") modal |
| `screens/11-settings.png` | The `Nastavení` ("Settings") modal (license plate + preferred spot) |
| `screens/03-admin-users.png` | Administration → Users |
| `screens/04-admin-spots.png` | Administration → Parking spots |
| `screens/05-admin-window.png` | Administration → Reservation window |
| `screens/06-admin-overview.png` | Administration → Parking lot overview |
| `screens/14-lot-user-lockstate-off.png` | The parking lot with no reservation-window status banner |

## Key values from the design (versus the fallback description in `plan.md`)

The design is built on the **Shoptet DS palette** (`ds/colors_and_type.css`) —
that palette is binding for the entire design system. The triple
`#fcaf00` / `#00e25a` / `#3b88ff` from `plan.md` **still applies**, but only as
the `PALETTE` used for the colors of cars on occupied spots (see
`garage-design.dc.html`, the `PALETTE` constant at line 472). Everything
else — UI, buttons, badges, states — uses the Shoptet DS:

- primary blue `#008FFF` (hover `#0070D6`), green `#00DB33`, yellow `#FFBE0E`,
  light blue `#E2F2FF`, dark `#23221F`, text `#15181E`, danger `#E5484D`
- neutrals `#FFFFFF … #23221F` (a 0–950 scale)
- font `NHaasGroteskDS` (fallback Neue Haas Grotesk / Helvetica Neue / Inter / Arial)
- 4px base spacing (`--space-1` … `--space-32`), radius `2/8/12/16/24/32/360px`
- shadows `--shadow-xs … --shadow-lg` + `--shadow-blue` / `--shadow-yellow`

Car colors on the lot are taken cyclically from
`PALETTE = ["#fcaf00", "#00e25a", "#3b88ff"]` (deterministically per user, not
randomly — otherwise a car's color would change on every render).

## Note on fonts

The `.otf` files are downloaded for design fidelity. Verify the Neue Haas
Grotesk Display Pro license before deploying to production.
`libs/shared/design-system/src/tokens` must have a working fallback stack, so the
application still looks reasonable without these files.
