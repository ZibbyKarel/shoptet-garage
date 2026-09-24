# The administration section (`/admin`)

Task 27. The tabbed "Správa" screen: the lot for a day, the users, the parking
spots, the reservation window, and the reservation limits (`TODO.md` item 2,
`doc/decision/0312-*`).

Designs: `doc/design/screens/03-admin-users.png`, `04-admin-spots.png`,
`05-admin-window.png`, `06-admin-overview.png`, and `01-lot-admin.png` for the
visual identity shared with the rest of the app.

## Where authorization lives

**On the API, and nowhere else.** Every `admin.*` procedure carries
`@Roles('ADMIN')`, and `RolesGuard` (registered after `JwtAuthGuard`) answers
the contract's `FORBIDDEN` with a 403 regardless of what any browser believes.
See `doc/auth.md`.

Two tests hold that up, and they make different claims:

- `apps/garage/api/src/orpc/orpc-route-parity.spec.ts` reads the decorator off Nest's
  metadata: every `admin.*` route has `@Roles('ADMIN')`, and no other route
  does.
- `apps/garage/api/src/orpc/orpc-pipeline.spec.ts` drives **every admin procedure**
  over real HTTP with a real non-admin token and requires a 403 in the RPC
  envelope, with nothing written to the database and nothing in the audit log.
  Metadata being present is not the guard running; this is the one that says
  the guard runs. Its list of procedures is checked against `libs/garage/contract`, so
  an admin procedure added later fails the suite rather than being skipped.

The role gate in `AdminScreen` is a **courtesy** — it stops a non-admin who
typed the URL from staring at a screen where nothing loads — and it fails
closed: an unknown role (profile in flight, or failed) is not an admin.

The same is true of the disabled "Aktivní" switch on an admin's own row
(`doc/decision/0160-*`): `UsersService.adminUpdate` refuses self-deactivation
and refuses removing the last active admin whatever the browser sends.

## Layout

```
apps/garage/web/src/
  app/(app)/admin/page.tsx       wiring: profile + the five connected panels
  shell/admin-screen/admin-screen.tsx  role gate, page chrome, the tab strip
  shell/admin/
    admin-errors.ts              (operation, code) -> Czech sentence
    window-banner.tsx            the month's window, as one sentence
    lock-mode-choice.tsx         the segmented "Režim zámku" control
    admin-day-screen.tsx     / admin-day-panel.tsx
    admin-users-screen.tsx   / admin-users-panel.tsx
    admin-spots-screen.tsx   / admin-spots-panel.tsx
    admin-window-screen.tsx  / admin-window-panel.tsx
    admin-limits-screen.tsx  / admin-limits-panel.tsx
```

The screens have a spec each; the five panels share one
(`admin-panels.spec.tsx`), which runs the real screens and the real
`@garage/query` against a fake `api` object. What only that spec can see is
everything _between_ a screen and the contract: which procedure a control calls,
what input it sends, which `AdminWrite` a failure is attributed to, what is
invalidated afterwards, and that `viewerId` really comes from `me.get` — the
screens take it as a prop, so nothing on their side notices if a panel stops
supplying it and the self-deactivation guard quietly disappears.

Every tab is split into a **screen** (presentational, every value a prop, every
rule testable with nothing but an `IntlProvider`) and a **panel** (wiring: the
queries, the mutations, the router). Same split, and same reason, as
`TopBar`/`AppTopBar` and `SettingsScreen`/`SettingsPage`.

`AdminScreen` takes the five panels as a `panels` prop rather than importing
them, so it stays renderable without a query client. React elements are inert
until rendered, and `Tabs` mounts only the selected panel — an unselected tab
fetches nothing.

## The five tabs

### Přehled parkoviště

`overview.day` for today in Europe/Prague: the date, the free/taken counts, the
window banner, and a `DataTable` of spots with holder and queue length.

It does **not** redraw the painted car grid — that is the lot screen, and
Task 24 owns it. `doc/decision/0161-*` has the reasoning and the upgrade path.
`AdminDayScreen` already takes `date` as a prop, so Task 25's date bar wires in
by changing `admin-day-panel.tsx` alone.

### Uživatelé

`admin.user.list` (unfiltered) into a `DataTable`: name, e-mail, an `Admin`
switch and an `Aktivní` switch, both writing `admin.user.update`.

- The search box filters the loaded list rather than refetching —
  `doc/decision/0162-*`.
- The `Aktivní` column is not in the design; `doc/decision/0160-*` says why it
  is there and why it is drawn as the spots table's switch.
- Both switches on a row are frozen while either is being written: they share
  one procedure, and a second call would race the first.

### Parkovací místa

`admin.spot.list({ includeInactive: true })` joined with today's `overview.day`
for the "Stav dnes" column. Per row: an inline category `Select`, an `Aktivní`
switch, a `Skryté` switch, a `Nabíječka` switch, `Upravit` (a `Modal` form)
and `Smazat` (a `ConfirmDialog`).

- `Smazat` calls `admin.spot.deactivate` — a soft delete, refused while
  somebody holds the spot from today onwards. `doc/decision/0163-*`.
- `Skryté` hides a spot from everybody but admins — it is not a retirement,
  refuses nothing, and a hidden row carries a `Skryté` badge here and on the
  lot. `doc/decision/0316-hidden-spots-are-seen-and-booked-by-admins-only`.
- `Nabíječka` marks an EV charger. It is information only and refuses
  nothing. A spot with a charger carries a green bolt here and, for every
  viewer, on the lot.
  `doc/decision/0317-the-ev-charger-flag-is-informational-and-shown-to-everyone`.
- The category band counts; it does not edit. Categories are a closed enum.
  `doc/decision/0164-*`.
- A spot missing from the day overview (every inactive spot is) shows `—`, not
  "Volné" — a claim about a spot nobody can book would be wrong.
- The design's third value for that column, `Upravuje Jana Dvořáková`, is not
  implemented: it is presence, it lives on the realtime channel, and no admin
  tab subscribes to one. `doc/decision/0168-*`.
- The actions column keeps the accessible name `Akce` but hides it
  (`sr-only`), because the design draws that header blank and a nameless column
  is still nameless to a screen reader.

### Rezervační okno

`admin.window.months` for the current month plus three. One response feeds both
cards: the contract returns `settings` alongside `months` precisely so the form
and the list cannot disagree about the same moment.

- Left: the stepper (1–31, declined into Czech through ICU) and the lock-mode
  segmented control. **No Save button** — both save on change.
  `doc/decision/0166-*`.
- Right: one row per month with its window range and an
  Otevřeno / Uzamčeno / Zatím neotevřeno badge.

### Limity rezervací

`admin.reservationLimits.get` / `.update` — one stepper (1–31), no Save
button, same choice as the window tab's and for the same reason: the control
writes on change, so there is never an unsaved value on screen that disagrees
with the server. Built the same way as `AdminWindowScreen`/`AdminWindowPanel`,
deliberately: a second settings surface rather than a variant, because the
cap is not a window setting (`doc/decision/0312-*`).

Saving invalidates more than its own query: every month summary
(`reservation.myMonth`, `admin.reservation.month`) carries the cap in force,
and the bulk-booking modal's greyed-out days are derived from it, so both are
stale the moment the cap changes. `AdminLimitsPanel`'s `onSuccess` invalidates
`api.reservation.key()` and `api.admin.reservation.key()` alongside its own.

Lowering the cap does not touch reservations that already exist — it binds
new inserts only (`doc/decision/0312-*`).

The cap binds only inside the `AUTO` reservation window; once a month is
running, or under `FORCE_OPEN`, nobody is capped and the month summaries
report `cap: null` (`doc/decision/0315-*`).

## Never printing a date that is not true

`MonthWindowOverview.windowFrom` / `windowTo` are **always** the range the AUTO
rule would produce. When `lockMode !== 'AUTO'` an admin has overridden the
state and those dates describe a hypothetical, not a fact
(`libs/garage/contract/src/schemas/reservation-window.ts`).

Both places that render them read `lockMode` first:

- `WindowBanner` has six sentences, three AUTO (which name a date) and three
  forced (which credit the admin and name none).
- The month list says `otevřeno 25. srpna – 31. srpna` under AUTO and
  `automaticky by bylo otevřeno 25. srpna – 31. srpna` under a forced mode.

`window-banner.spec.tsx` and `admin-window-screen.spec.tsx` each pin the forced
case, including that the date does **not** appear.

## Failure copy

Admin writes do not use the `errors` namespace. `admin-errors.ts` maps
**(operation, code)** to a sentence, because the same code means different
things on different procedures — and because `errors.VALIDATION_FAILED` talks
about weekends and holidays, which is nonsense next to a role switch.
`doc/decision/0165-*`.

A failure is rendered inside whichever dialog is open, and above the table when
none is: a dialog is a modal, so a message printed behind one is a message
nobody reads.

**A failure belongs to one attempt and dies with it.** Changing the open dialog
discards it (`onDiscardFailure` → the panel's `reset()`), and `WRITE_ORIGINS`
refuses to render a sentence on a surface that could not have produced it.
Without the first, a refused `Smazat` greeted the admin inside the next empty
"Přidat místo" form; without the second, forgetting one discard would bring the
same shape back. `doc/decision/0167-*`.

**Colour is copy here.** The month badges take their tone from
`BADGE_STATE_TONE` (`shell/admin/admin-window-screen/admin-window-screen.tsx`) and the window banner
from `BANNER_STATE_TONE` (`shell/admin/window-banner/window-view.ts`), each exported so a spec
can pin the mapping against the design — `Otevřeno` green, `Uzamčeno` yellow,
`Zatím neotevřeno` grey. A locked month drawn green is read as open before a
word of it is. The two maps agree today and are deliberately not one map: they
answer to different design artifacts (`05-admin-window.png`'s pills,
`06-admin-overview.png`'s band) and are pinned separately, so a redesign of one
surface cannot silently repaint the other.

## Czech copy

All of it is in the `admin` namespace of `apps/garage/web/messages/cs.json`, and all
of it is verbatim from the designs where the designs have it. English lives
alongside it in `en.json`, kept in step by the parity guard at
`apps/garage/web/messages/messages.spec.ts`. Three notes:

- **Plurals are ICU, not a hand-written table.** Czech has three integer plural
  categories (`one` = 1, `few` = 2–4, `other` = 5+) and "1 den" / "3 dny" /
  "7 dní" differ in all three.
- **One correction to the design's text.** `05-admin-window.png` reads
  "upravuje je pak může jen admin"; the shipped string says "upravovat je pak
  může jen admin", which is the grammatical form of the same sentence.
- **`dayMonthAndYear`** was added to `libs/shared/i18n` for the month card's
  "dnes je 28. srpna 2026" — day, genitive month, year, no weekday. It is a
  separate `Intl` call rather than `fullDate` with the weekday cut off. Both
  are methods on the object `createDateFormatters(locale)` /
  `useDateFormatters()` returns.
