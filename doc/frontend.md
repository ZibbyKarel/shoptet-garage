# The web application

`apps/garage/web` is the Next.js 16 App Router front end. This document describes the
shell that Task 23 established: the route tree, the single client boundary and
the order its providers nest in, the sign-in flow, the three screen states that
feature screens compose and the `ScreenData<T>` union that says which of them a
screen is in, the `*-view.ts` split that keeps a screen's decisions out of the
component drawing them, the health route, and how Tailwind is wired to the
design system's tokens.

User-visible copy is Czech; identifiers — including URLs — are English, along
with everything else: comments, this file (`doc/decision/0029-*` for the
copy/prose split, `doc/decision/0298-*` for why a URL falls on the identifier
side of it). No UI string is written in a component: they all come from
`libs/shared/i18n`.

## What a screen may import

The wrapper rule from `plan.md` applies here more than anywhere, because this
is the code most tempted to reach past it. App code imports the wrapper, never
the library:

| Instead of                     | Import                                          |
| ------------------------------ | ----------------------------------------------- |
| `next-auth`, `next-auth/react` | `@garage/auth`, `@garage/auth/client`           |
| `@tanstack/react-query`        | `@garage/query`                                 |
| `@tanstack/react-table`        | `@garage/design-system/compounds` (`DataTable`) |
| `socket.io-client`             | `@garage/realtime-client`                       |
| `next-intl`                    | `@garage/i18n`                                  |
| `react-hook-form`              | `@garage/form`                                  |
| `@orpc/client`                 | `@garage/api-client`                            |

`no-restricted-imports` in `eslint.config.mjs` enforces this and `web:lint`
runs with `--max-warnings=0`, so a direct import is a build failure rather than
a review comment. It has been probed rather than assumed — a file importing
`next-auth/react`, `@tanstack/react-query` and `socket.io-client` produced
three errors and exit code 1, including for the `next-auth/react` _subpath_.

## Route tree

```
src/app/
  layout.tsx                    root: <html lang="cs">, tokens, fonts, <Providers>
  global.css                    Tailwind entry, imports the token theme
  providers.tsx                 the one 'use client' boundary
  error.tsx                     React error boundary  -> <ScreenError onRetry={reset}>
  not-found.tsx                 404
  login/page.tsx                login (server component + Server Action)
  api/auth/[...nextauth]/route.ts   Auth.js handlers
  api/health/route.ts           readiness probe
  (app)/
    layout.tsx                  <AppTopBar> + centred <main>
    loading.tsx                 route-level <ScreenLoading>
    page.tsx                    /          parking overview
    settings/page.tsx           /settings  settings
    admin/page.tsx              /admin     administration (admin only)
```

`shell/admin/` holds the administration section's own components — one
screen/panel pair per tab, plus the shared failure-copy table, the window
banner and the lock-mode control. See `doc/admin.md`.

Every route is declared once, in
`src/routes.ts` — `LOT_ROUTE`, `LOGIN_ROUTE`, `SETTINGS_ROUTE`, `ADMIN_ROUTE`,
`AUTH_API_ROUTE_PREFIX`, `HEALTH_ROUTE`. `auth.ts` and `proxy.ts` both read
`LOGIN_ROUTE` from there, which is what makes a redirect loop unconstructible:
the path Auth.js redirects _to_ and the path the proxy exempts cannot drift
apart.

The `(app)` route group exists so the top bar and the page container wrap every
signed-in screen without appearing in a URL. The login page sits outside it —
it is a blank page by design.

## The client boundary

`app/providers.tsx` is the **only** `'use client'` boundary in the app shell.
Every wrapper lib ships its provider without a `'use client'` directive of its
own, precisely so the app marks the boundary once and composes them in one
place.

```
AuthProvider            session (server-rendered, so no signed-out flash)
└── IntlProvider        Czech copy + Europe/Prague formatting
    └── QueryProvider   one QueryClient per mount
        └── ApiProvider oRPC client built from the session's token
            └── RealtimeBoundary   socket, opened only once signed in
```

The order is load-bearing, not stylistic:

1. **`AuthProvider` outermost** — everything below reads the session. The API
   client takes its bearer token from it; the socket takes its handshake token
   from it.
2. **`IntlProvider`** above the data layers, so a failure rendered by any
   screen already has Czech copy available.
3. **`QueryProvider` then `ApiProvider`** — the client is built from the token
   provider (so it must be inside `AuthProvider`), and the query utilities are
   built from the client.
4. **`RealtimeBoundary` innermost** — the only one needing both a session
   _status_ and a token, and it holds the socket closed until there is one.

The `QueryClient` is created in `useState`'s initialiser, so it survives
re-renders (a client built in the render body would throw its cache away every
time) and is per-request on the server, which is what SSR needs. It comes from
`createQueryClient()`, never `new QueryClient` — the retry and caching policy
is a product decision owned by `libs/query`, and the class is exported
type-only so this cannot be bypassed.

`layout.tsx` reads the session on the server with `await auth()` and passes it
down. Passing `null` states "there is no session, I checked"; omitting it would
start Auth.js in `loading` and render every visitor as signed-out for a frame.

## The three URLs derived from `NEXT_PUBLIC_API_URL`

`src/api-url.ts`. The configured value (`http://localhost:3000/api`) is the
API's base URL and is **not itself** any of the endpoints the app calls:

| Consumer     | Function               | Result                                                                  |
| ------------ | ---------------------- | ----------------------------------------------------------------------- |
| oRPC client  | `apiRpcUrl(url)`       | `…/api/rpc` — the RPC transport is a controller under the global prefix |
| health route | `apiReadinessUrl(url)` | `…/health/ready` — the API's probes are excluded from `setGlobalPrefix` |
| Socket.io    | `apiOriginOf(url)`     | origin only — `io()` reads a path as a **namespace**                    |

Each has a silent failure mode, so each is a named function with specs. Full
reasoning and the measurements behind it: `doc/decision/0101-*`.

## Sign-in

There is no test path and no bypass. Development, e2e and production all run
the same code and differ only in environment values.

1. An unauthenticated request to any protected path hits `src/proxy.ts`, which
   re-exports Auth.js's `auth` as Next 16's request interceptor. It redirects
   to `/login?callbackUrl=…`. See `doc/decision/0100-*` for the matcher
   and why the file is `proxy.ts` rather than `middleware.ts`.
2. `login/page.tsx` is a **server** component. If a session already
   exists it redirects to `/`; otherwise it renders `LoginScreen` with a
   Server Action:

   ```ts
   async function signInWithOkta() {
     "use server";
     await signIn(OKTA_PROVIDER_ID, { redirectTo: LOT_ROUTE });
   }
   ```

   The screen is a blank page with the brand, two lines of Czech copy and one
   pill button, `Login přes OKTA Verify` — per the design. Because the action
   is a form submission, the page needs no client JavaScript to work.

3. Auth.js redirects to Okta (the mock OIDC server in development) with
   `response_type=code`, `scope=openid profile email offline_access` and PKCE
   `S256`.
4. The provider redirects back to `/api/auth/callback/okta`, handled by
   `app/api/auth/[...nextauth]/route.ts`, which is `libs/garage/auth`'s `handlers`
   and nothing else.
5. The session cookie is set and the user lands on `/`.

**Signing out** goes through `signOut({ redirectTo: LOGIN_ROUTE })` from the
avatar menu.

**Tokens.** The access token lives in the encrypted session cookie. It is never
written to `localStorage` or `sessionStorage`, never rendered, and never
logged. The browser gets it only as a `Authorization: Bearer` header added by
`libs/shared/api-client`, and as `socket.handshake.auth.token` — never a query string
(`doc/decision/0060-*`). `AUTH_SECRET` and the OAuth client secret are read
from `process.env` on the server; neither carries a `NEXT_PUBLIC_` prefix,
which would publish it to every visitor.

### Dev environment notes, measured

- The mock OIDC server issues **no `email` claim by default**. The API refuses
  such a token (`The token does not identify a provisionable user.`). Supply
  `{"email":"…","name":"…"}` in the mock login form's _Optional claims JSON_
  field, or configure the mock server with a user that has them.
- The mock server's access token carries `aud: "default"`. The API's
  `AUTH_OKTA_AUDIENCE` has to match it, or every request is a plain 401.

## The top bar

`shell/top-bar/top-bar.tsx` is **presentational** — props in, callbacks out, no data
fetching — and `shell/app-top-bar.tsx` is the connected wrapper. Left: the
brand, wrapped in a link to `/`. Right: an `Admin` badge for administrators,
then the avatar with the user's initials, their name, and a dropdown holding
their name and email, `Nastavení (SPZ auta)`, `Správa` (administrators only)
and `Odhlásit se`.

The role comes from the contract's `me.get` (`shell/use-current-user.ts`), not
from the session — Auth.js's session carries only the access token. The
consequence is that while the profile is loading or has failed, `role` is
`undefined` and `isAdmin` is `role === 'ADMIN'`, which is **false**. The badge
and the `Správa` entry are absent rather than present-and-broken. This is a
convenience, not a control: the API's `RolesGuard` is what actually enforces
the role, and `/admin` renders a `FORBIDDEN` empty state for a non-admin who
navigates there directly.

`initialsOf()` (`shell/initials.ts`) takes the first letter of the first two
words, uppercased with `cs-CZ` rules, iterating code points so a name outside
the BMP is not cut in half.

## Settings (`/settings`)

`shell/settings-screen/settings-screen.tsx` is **presentational** — profile, spots, and the
mutation state around them in as props, callbacks out — and
`shell/settings-page.tsx` is the connected wrapper, following the same split
as `TopBar`/`AppTopBar` and `AdminScreen`/`admin/page.tsx`.

The screen renders as the design system's `Modal` (`doc/decision/0150-*`)
rather than a bespoke dialog, with its × hidden and `closeOnScrimClick={false}`
(the design draws no ×, and this dialog holds unsaved input — fix-round note
in `doc/decision/0150-*`): a licence-plate/preferred-spot form built with
`useAppForm`/`FormField` (`@garage/form`), submitted through
`me.updateSettings`'s three-valued input (absent = leave alone, `null` =
clear, a value = set — `toUpdateInput` turns an empty string into `null` for
both fields). The fields sit inside a real `<form id="settings-form">`; the
Save button lives in `Modal`'s `footer` (outside that `<form>`'s own DOM
subtree) and is linked to it with the standard `form="settings-form"`
attribute, which is also what makes pressing Enter in a field submit natively.
The ICS section is deliberately **outside** that `<form>`, so pressing Enter
while focused on the read-only feed-URL input cannot trigger a save.

The form is seeded from the profile exactly **once**, in an effect guarded by
a `useRef`, so a background refetch (e.g. after the ICS token regenerates and
invalidates `me.get`) never overwrites an edit in progress. A second effect
reconciles the seeded preferred-spot id against `spot.list`'s actual result
once it has resolved (`!spotsPending && !spotsError`): if the stored id is not
among the active spots — the spot was retired after being chosen,
`spot.deactivate` never clears anyone's `preferredParkingSpotId` — the form
value is set to "no preference" to match what a real `<select>` already shows
in that situation, rather than silently resubmitting an id nobody can see
selected (Task 26 review, I1). `spotsPending`/`spotsError`, passed down from
`SettingsPage`'s `spot.list` query, also drive a loading hint and an inline
error under the picker, so a failed spot list is not silently indistinguishable
from "no active spots" (review, M8).

See `doc/admin.md` for the administration section (`/admin`), which follows
the same screen/panel split, one pair per tab.

Below the form, a second section — `IcsSection` — shows the caller's ICS feed
URL (`buildIcsFeedUrl(apiOrigin, icsToken)`), a copy-to-clipboard button, and
a "Vygenerovat nový odkaz" button behind `ConfirmDialog`, since the old link
stops resolving the moment a new token is issued. This section has no design
to copy from; `doc/decision/0151-*` records why it lives in this modal rather
than its own screen. `apiOrigin` comes from the route's server component
(`app/(app)/settings/page.tsx`, reading `NEXT_PUBLIC_API_URL` the same way
`app/layout.tsx` does) — an empty string means it could not be derived, and
the section renders its "unavailable" copy instead of a broken link.

The ICS token is a bearer credential and is never logged from this screen: a
failed clipboard write only flips a `copyState` flag, and neither mutation's
variables or result are serialised anywhere in `SettingsPage`.

## Bulk reservation (the lot screen's modal)

The "Hromadná rezervace" button on the lot header opens a three-step modal that
lives in `src/lot/bulk-modal/bulk-modal.tsx`, with every decision it makes as a
pure function in `src/lot/bulk-modal/bulk-view.ts` (the calendar table and the
schedule-preview step are their own files beside it — `doc/decision/0299-*`).
It has its own document: `doc/bulk-reservation-modal.md`.

Three things about it are worth knowing from here rather than from there. Its
third step is **not** optional: the confirmation is compared with the proposal
the user was shown, and a difference is rendered rather than swallowed
(`doc/decision/0170-*`), so this is the one modal on the site that does not
close itself on a successful write. Its failures are rendered from the
`bulk` message namespace rather than the shared `errors` one, because the
shared sentences describe a single-day reservation
(`doc/decision/0171-*`).

And it is the one screen whose subject is a **month**, so it is the one that
reads `day.canReserveMonth` rather than `day.canReserve`. The two differ by the
day's own rules — a past date, a weekend, a Czech public holiday — which are
facts about the anchor day and say nothing about the window;
`doc/decision/0175-*` records why that had to become a contract field instead of
a client-side inference. Its locked-month refusal is deliberately ordered
_after_ the result step, so a window that closes between a successful
confirmation and its refetch cannot replace a finished comparison with a
sentence saying nothing was created (`doc/decision/0176-*`).

## The spot dialog: reserve, queue, cancel, or a guest half-hour block

`lot/spot-dialog/spot-dialog.tsx` is the dialog behind a bay, presentational
throughout — every decision arrives as a prop on `SpotDialogProps`, and each
of its actions (`onReserve`, `onJoinWaitlist`, `onLeaveWaitlist`,
`onCancelReservation`, `onReserveTimed`, `onCancelTimedReservation`) is a
callback `lot-screen.tsx` wires to a procedure. `toSpotView` (`lot-view.ts`)
decides which of the dialog's modes a bay is in before the dialog ever
renders.

An admin's holder form (`HolderFields`) gained a fourth mode alongside the
existing user/guest full-day choice: a guest holder may additionally pick
`duration: 'TIMED'`, which swaps the plain confirmation for a start/end time
pair on the half-hour grid. Submitting routes to `onReserveTimed` instead of
`onReserve` — `holder-input.ts`'s `toReservationRequest` makes that decision
once, flatly, rather than have the dialog re-derive "is this a timed booking"
from the same fields the form already validated. A user holder can never
reach `'TIMED'`: `toReservationRequest` falls back to `'FULL_DAY'` for one
regardless of what `duration` says, because a user's own reservation is
always the whole day (`plan.md`).

A bay that already carries one or more guest blocks gets its own appearance,
`'timed'` (`toSpotView`'s precedence: lock > full-day holder > guest blocks >
free / window-locked) — mutually exclusive with `'taken'`, since the
database refuses a full-day `Reservation` and any `TimedReservation` on the
same cell at once (`doc/decision/0314-*`). Its dialog renders the list of
existing blocks (time range, guest name, plate) above the holder form rather
than instead of it: an admin may still add another non-overlapping block to
a spot that already has some, and the holder form there defaults to a fixed
guest with `duration: 'TIMED'` (`HolderFields`'s `timedOnly`), so it needs
neither a role selector nor the admin's user list to have loaded first — the
one case where the holder form appears without waiting on
`holderOptions.length > 0`. Each existing block gets its own cancel button,
visible only to an admin, wired to `onCancelTimedReservation`.

A spot with blocks has no queue UI: the waitlist section only ever renders
for `isTaken`, and a `'timed'` appearance is never `isTaken`.

## Loading, empty and error

`shell/screen-state/screen-state.tsx` holds the three states themselves _and_ the type that
says which of them a screen is in, so a screen imports both from a single
place. The three renderers first:

- **`ScreenLoading`** — `role="status"` with the default polite live region, so
  a screen reader announces the wait; label defaults to `Načítá se…`.
- **`EmptyState`** — re-exported from `@garage/design-system/compounds`
  rather than reimplemented.
- **`ScreenError`** — takes whatever the failing call threw, reads it through
  `toContractError`, and renders a Czech sentence **keyed off the error's
  code**. The error's own `message` is never shown: a contract error's message
  is developer-facing English by design, and a transport failure's message is a
  stack-adjacent string. An unrecognised code and a transport failure both fall
  back to one generic sentence. An optional `onRetry` renders a secondary
  button; without it there is no control.

Two places wire these up for free: `(app)/loading.tsx` gives every route a
suspense fallback, and `app/error.tsx` renders `ScreenError` with `reset` as
the retry.

These live in app code rather than in the design system on purpose. Composing
primitives and compounds into domain UI is app work; `EmptyState` is the
design-system piece, and `ScreenError` is this application's opinion about how
a contract error becomes a sentence.

### `ScreenData<T>`: the state as one value, not four props

The same module exports `ScreenData<T>`, `ScreenQueryLike<T>`, `screenDataOf`
and `ScreenDataGuard`, and the four admin screens
(`admin-day-screen.tsx`, `admin-spots-screen.tsx`, `admin-users-screen.tsx`,
`admin-window-screen.tsx`) take a `ScreenData<T>` as a prop rather than the
four that used to stand for it.

Six screens used to take `data | undefined`, `isPending`, `isError` and `error`
side by side, and five of the six prop interfaces then spelled the correlation
out in prose: "`undefined` exactly when `isPending || isError`". A fact an
interface has to state in a comment is a fact its types are failing to carry.
Nothing stopped a caller from writing `{ isPending: false, isError: false,
data: undefined }`, and a screen that reached its ready branch with no data
drew an empty table asserting _there are no parking spots_ — a claim, where the
truth was an absence.

```ts
export type ScreenData<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "ready"; readonly data: T };
```

As a discriminated union that combination cannot be written down: `data` exists
only on the branch that has it, so the ready branch is unreachable without it,
and the prose correlation is replaced by a compile error. "Loading with data"
and "error with no data" stop being states anyone has to remember not to
produce. `onRetry` stays a sibling prop, because retrying is the caller's
capability rather than a property of the data, and it is the same function in
all three states.

Three details are worth knowing before using it:

- **`screenDataOf(query)`** does the narrowing, and its precedence is the one
  the hand-written guards had, so the move was behaviour-preserving: pending
  wins over error, and a result that is neither pending nor failed yet carries
  no data is treated as a **failure** — that is the branch a screen must never
  render as "empty".
- **`ScreenQueryLike<T>`** — `{ isPending, isError, error, data }` — is written
  out here rather than imported as TanStack's `UseQueryResult`, so the seam
  names no transport. A screen fed from `useQueries`, from a Storybook story or
  from a parent's own state is adapted by the same function, and
  `@garage/query` stays the thin wrapper it is meant to be.
- **`ScreenDataGuard`** is the two-branch guard every screen had copied into
  it, written once, and it takes a render prop rather than returning early: a
  screen whose states belong _inside_ something it has already opened — a modal
  that keeps its header and footer while its body loads — cannot use an early
  return without losing the frame.

## `*-view.ts`: what a screen decides, beside what it draws

Five screens split their decisions out of the component that renders them, into
a sibling module with no React, no hooks and no network in it:
`lot/lot-view.ts`, `lot/bulk-modal/bulk-view.ts`,
`shell/settings-screen/settings-view.ts`,
`shell/admin/admin-spots-screen/spots-view.ts` and
`shell/admin/window-banner/window-view.ts`. Each has a
`*-view.spec.ts` beside it.

The reason is the same in all five, and `lot/lot-view.ts` states it first:
conditional rendering is the part of a UI that is cheapest to get wrong and
most expensive to test through the DOM. A decision spread over a lookup table,
a type and a nested conditional inside a component body can only be exercised
by rendering the component and reading what came out; the same decision as a
named function has a name, a type and a spec that states it directly. The
components take the result and draw it.

Two conventions hold across the five:

- **A union, not a nullable pair.** These modules are where the app's small
  discriminated unions live — `IcsFeedView`, `SpotDialog`, `PreferredSpotView`,
  `BulkBadgeView` — for the same reason `ScreenData<T>` above is one: the
  combinations that mean nothing should not be writable.
- **Keys are structure, sentences are copy.** A view function returns a message
  _key_ — which case are we in — and never a formatted string: formatting
  belongs to `@garage/i18n` and the sentence to the component. That also
  keeps each union enumerated once, in the module that produced it; re-switching
  on one in the component would enumerate its variants twice, and adding a
  variant would then fail to compile in the wrong file.

## The bottom date-navigation bar

`DayBar` (Task 25) is the sticky bar at the bottom of the parking overview
(`doc/design/screens/07-lot.png`, `13-lot-user-bottom.png`): prev/next arrows
either side of the current date, a month and year select, and a "Dnes"
button. It is pure presentation — every decision it draws arrives as a prop,
and every interaction it reports goes back out through a callback, same as
`WindowBanner` beside it. `doc/decision/0140-*` split it into its own
`date-nav-bar.tsx`; it was later folded back into `LotHeader`
(`apps/garage/web/src/lot/lot-header/lot-header.tsx`'s module comment says so), so it
no longer has a file or spec of its own — its behaviour below is covered by
`lot-header.spec.tsx`.

The Czech public-holiday and weekend highlighting the design calls for
("STÁTNÍ SVÁTEK · DEN ČESKÉ STÁTNOSTI" on a yellow bar, "Víkend" on a
Saturday/Sunday, "Pracovní den" — not highlighted — otherwise) is not decided
in `DayBar` at all: `LotScreen` computes a `DayNoteView` via
`toDayNoteView(date)` (`./lot-view.ts`), which reads `@garage/i18n`'s
Czech holiday calendar (`czechPublicHolidayOn`) and weekend check
(`isWeekend`), and `DayBar` only maps `note.highlighted` to a class and
`note.key`/`note.name` to translated copy. The uppercase rendering is CSS
(`uppercase`), not the message text — same pattern as the section eyebrow
above the heading — so `apps/garage/web/messages/cs.json` stores
`'Státní svátek · {name}'`, not shouted text.

Changing the day — the arrows, the month/year selects, or "Dnes" — moves
`LotScreen`'s `date` state, and that one state drives everything downstream:
`overview.day`'s query key (`api.overview.day.queryOptions({ input: { date
} })`) refetches for the new day, and `useLotRealtime`'s `useDayRoom(date)`
leaves the old day's realtime room and joins the new one. Both derive from
the same `date` argument on purpose — there is no second place either could
drift out of sync with the day actually on screen. `doc/decision/0141-*`
covers where and how that "leaves the old room" guarantee is tested, on top
of the socket-level proof already in `libs/garage/realtime-client`'s own suite
(`doc/realtime.md`).

## Realtime: what a broadcast is allowed to change

Added by Task 24 (the parking screen), and the rule every future screen with a
day room follows. `plan.md` (Fáze 6) asks for _one_ mechanism — "realtime events
invalidate/patch the query cache, no ad-hoc local state". That mechanism has two
halves, and which half applies is decided by the **contract**, not by taste:

> **Patch the shared fields the payload determines. Additionally invalidate when
> the event could move a viewer-relative field the broadcast is forbidden to
> carry.**

A day room is shared by everyone looking at that day, so a payload may not say
anything viewer-relative. `waitlistUpdatedEventSchema` states the constraint and
the reason: "there is no way to broadcast 'your position is now 2' to a room
without telling everyone else who is in the queue". `dayOverviewOutputSchema`
has exactly five such fields — `canReserve`, `canReserveMonth`,
`viewerReservationId`, `viewerWaitlistEntryId`, `viewerWaitlistPosition` — and
none of them can be patched from an event. `canReserveMonth` joined the list
with Task 31: it carries the admin exemption, so it too is an answer about the
caller and not about the day. Asking for the day again is the only honest way to learn
their new values.

| event                           | patched                       | also refetched when                                         |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `reservation:created`           | `spots[i].reservation`        | the caller is the new holder                                |
| `reservation:cancelled`         | `spots[i].reservation = null` | it was the caller's own reservation                         |
| `reservation:reassigned`        | `spots[i].reservation`        | the caller was promoted, lost the spot, or is queued for it |
| `waitlist:updated`              | `spots[i].waitlistCount`      | the caller is in that queue                                 |
| `cell:locked` / `cell:unlocked` | _nothing_                     | _never_ — see below                                         |

Doing both is not redundant work. The patch repaints on the tick the event
arrived; the refetch corrects the four viewer fields a moment later, and only
for the callers whose fields moved. Invalidating alone would leave every tile
stale for a round trip and fire nine requests for one reservation; patching
alone would leave "you are 2nd in the queue" wrong indefinitely.

Three rules that make this safe to copy:

1. **The patches are pure and identity-preserving.** They live in a module with
   no React in it and return the _same object reference_ when nothing changed —
   wrong day, unknown spot, redelivered event, unchanged count. A client is
   normally in several day rooms and Socket.io does not tell a handler which one
   a message arrived through, so the day guard is load-bearing.
2. **The query key is never written down.** The hook and its tests both derive
   it from `createApiQueryUtils`, because a key that differs by one character
   produces a patch nothing renders — indistinguishable from a broadcast that
   never arrived.
3. **`cell:locked` is the documented exception**, and it is component state
   _because the contract says so_: no procedure returns the current holds, so
   there is no cache entry to patch and minting a key no endpoint backs would
   invert the contract-first rule. A hold lives about thirty seconds, is swept
   locally on its own `expiresAt` (the contract requires this: "a lost
   `cell:unlocked` … must not freeze a tile forever"), and is dropped wholesale
   when the socket disconnects, since no `cell:unlocked` can arrive while it is
   down.

Full reasoning: `doc/decision/0123-*` (the two halves) and `doc/decision/0124-*`
(why cell locks are the exception).

## `/api/health`

A readiness probe for the _pair_. It calls the API's `/health/ready` with a
4-second timeout and answers `200` `{"status":"ok",…}` or `503`
`{"status":"error","checks":{"api":{"status":"down","reason":…}}}` where the
reason is one of `unreachable | timeout | not-ready | not-configured` — a fixed
enum, never upstream text, so nothing internal can leak through a probe. Both
directions carry `cache-control: no-store`. It is exempt from the session
check, because an orchestrator carries no cookie. See `doc/decision/0103-*`.

Note the upstream path: the API's probes are **`/health/ready`**, not
`/api/health/ready` — `configureApp()` excludes them from the global prefix.

## Styling

`app/global.css` is the Tailwind v4 entry point. It imports the design
system's theme (which is itself `@import 'tailwindcss'` plus the token file and
an `@theme inline` block), then declares the three source trees Tailwind should
scan for class names:

```css
@import "../../../../libs/shared/design-system/assets/theme.css";
@source '../../src';
@source '../../../../libs/shared/design-system/src/primitives';
@source '../../../../libs/shared/design-system/src/compounds';
```

The `@source` lines are required: Tailwind v4 scans the importing project by
default, and without them every class used _inside_ a primitive or compound
would be absent from the app's stylesheet.

`apps/garage/web/postcss.config.mjs` loads `@tailwindcss/postcss`, which is Next's
side of the same wiring (Storybook uses `@tailwindcss/vite`).

Tokens are used through their Tailwind names (`text-fg-3`, `border-border`,
`rounded-cta`) or as CSS variables where no utility exists
(`h-16 z-[var(--z-sticky)]`, `max-w-[var(--container)]`). No raw hex value,
radius or spacing number is written in `apps/garage/web`.

## Environment

`src/env.ts` holds the Zod schema; `instrumentation.ts` → `register()`
validates it once at boot and `instrumentation-node.ts` calls
`process.exit(1)` on failure, so no request is ever served by a misconfigured
process. Keys may be added, never loosened, and durations are milliseconds with
an `_MS` suffix.

The one exception is `src/auth.ts`, which reads raw `process.env`. It is
imported during page-data collection, and calling the validator there would
make `next build` require production secrets — which `doc/decision/0008-*`
recorded as something the build does not do. The reasoning, and the check that
a build still passes with no environment at all, is in `doc/decision/0102-*`.

## Tests

`nx run web:test`. Jest with `next/jest`, jsdom plus Node's fetch/stream
globals (`jest-environment-web.cjs`), and `@testing-library/jest-dom`.

Two details worth knowing before adding a suite:

- **`transformIgnorePatterns` has to be overwritten on the _resolved_ config.**
  `next/jest` _appends_ a custom `transformIgnorePatterns` after its own
  entries, and discards one coming from a preset entirely. Appending is no use:
  the array is a union — Jest skips a file that matches _any_ entry — and
  Next's own `/node_modules/(?!.pnpm)(?!(geist)/)` already matches everything in
  `node_modules` but `geist`. So the ESM-only exemption is applied to the
  resolved object at the bottom of `jest.config.cts`, after `createJestConfig`
  has run. Adding a dependency that ships ESM-only means adding it to
  `esmOnlyPackages` there.
- **`FormData`, `Blob` and `File` are deliberately jsdom's**, unlike in
  `libs/query`'s otherwise identical environment. React 19 implements a form
  `action` by calling `new FormData(formElement)`, and Node's `FormData`
  rejects an element.

`ScreenError`'s suite builds its errors by driving a **real** `RPCLink` with a
stubbed `fetch`, rather than constructing an oRPC error by hand: a hand-built
error asserts the test's idea of the wire shape instead of the transport's.
