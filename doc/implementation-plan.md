# Implementation plan – Garage

A breakdown of `plan.md` (the binding specification) into tasks for subagents.
**`plan.md` is the authority** – this document is only its breakdown into
dispatchable pieces. Where they disagree, `plan.md` wins.

- Visual source of truth: `doc/design/` (see `doc/design/README.md`)
- Decisions: `doc/decision/`
- Documentation per area: `doc/<area>.md`

> **Two user decisions amend `plan.md` and apply to the whole project:**
> `doc/decision/0004-mvp-scope-includes-design-features.md` (the reservation
> window with a lock, bulk reservation, and the preferred spot **are part of
> the MVP**; where they conflict with `plan.md`, the design wins) and
> `doc/decision/0005-npm-scope-lets-park.md` (the scope is `@garage/*`;
> wherever `plan.md` writes `@myorg/…`, read `@garage/…`). Read both before
> starting.

> **This file predates the design-system merge.** Tasks 6, 8 and 22 built
> `libs/shared/design-system` as three Nx projects (`design-system-tokens`,
> `-primitives`, `-compounds`); it is one project now, with the layers as
> directories under `libs/shared/design-system/src/`. Their task headings and steps
> below are left as written, because they record how the work was done. The
> two places that state a **rule** rather than a task — points 5/6 of the
> project-wide rules and Task 2's boundary list — are repointed, because a rule
> that names a directory nobody can open enforces nothing. See
> `doc/decision/0301-the-design-system-is-one-package-and-the-layer-rule-moved-to-lint-paths.md`.

### Execution order

Task numbers are not the order. The actual order and parallel branches:

| Wave | Branch A (main tree) | Branch B (worktree) |
| --- | --- | --- |
| 1 | 1 → 2 | – |
| 2 | 3 → 4 → 5 | 6 → 7 → 8 |
| 3 | 9 → 10 → 11 → 12 → 13 → **30** → 14 → 15 → 16 | 17 → 18 → 19 → 20 → 21 → 22 |
| 4 | 23 → 24 → **31** → 25 → 26 → 27 | – |
| 5 | 28 → 29 | – |

## Global Constraints

Apply to **every** task; the reviewer receives them with every dispatch.

1. **Contract-first.** No endpoint, DTO, or realtime event may exist in code
   before it exists in `libs/garage/contract`. Zod schemas are the single source of
   truth; TS types are always `z.infer<...>`, never hand-duplicated on FE and
   BE.
2. **Zod v4 only.** `class-validator` / `class-transformer` are not used in
   NestJS.
3. **Typed errors.** A uniform error shape (`code`, `message`, optionally
   `details`) and a closed enum of domain codes. The backend never returns an
   ad-hoc error shape.
4. **Date-only semantics.** The reservation day is `z.iso.date()`
   (`YYYY-MM-DD`) in the contract and `DATE` in Postgres. Never a timestamp.
   "Today" and day boundaries are always in `Europe/Prague`, with a single
   implementation in `libs/garage/shared-types` (see `doc/decision/0003-*`).
5. **Design-system-first.** tokens → primitives → compounds → domain
   composition (only in `apps/garage/web`). The design system is domain-free: no
   "ParkingSpot"/"Reservation" in `libs/shared/design-system/*`. Compounds may import
   primitives, never the reverse. Hand-written color/spacing values outside
   the tokens are forbidden.
6. **Wrapper layers are mandatory.** Application/feature code never imports
   directly: `react-hook-form` (→ `libs/shared/form`), `@tanstack/react-table`
   (→ `@garage/design-system/compounds`), `@tanstack/react-query`
   (→ `libs/query`), `@orpc/client` (→ `libs/shared/api-client`), `socket.io-client`
   (→ `libs/garage/realtime-client`), `next-auth` (→ `libs/garage/auth`), `ical-generator`
   (→ `libs/garage/calendar-export`), `next-intl` (→ `libs/shared/i18n`). Enforced by ESLint
   (Nx `enforce-module-boundaries` + `no-restricted-imports`).
7. **Operational baseline is part of the MVP** (it is not "monitoring"):
   fail-fast Zod validation of env, `nestjs-pino` (no `console.log`),
   `@nestjs/terminus` health endpoints, graceful shutdown, helmet + a CORS
   allow-list + `@nestjs/throttler`, a global exception filter, secrets only
   from env.
8. **What NOT to do:** Sentry / metrics / APM / alerting; Slack slash commands
   or interactive Block Kit (only outbound `chat.postMessage`); Redis /
   BullMQ / message brokers (only the abstraction + a documented upgrade
   path); test backdoors in auth (both dev and e2e go through
   `mock-oauth2-server` using the same code as production).
9. **Versions are binding:** Nx 23, Next.js 16 (App Router, React 19),
   NestJS 11, Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`,
   `prisma.config.ts`), Tailwind CSS v4 (CSS-first), Storybook 10,
   TanStack Query v5, Socket.io v4, oRPC + Zod v4, next-auth v5,
   PostgreSQL 17. Verify minor versions at install time; do not change majors.
10. **Don't write these libraries' APIs from memory.** oRPC ↔ NestJS,
    Prisma 7, Tailwind v4 CSS-first, and Auth.js v5 are recent – verify the
    current API via context7 / the official documentation (the `prisma:*`,
    `zod:use-zod`, `tanstack-query`, `tanstack-table` skills are available).
11. **Write tests alongside** the code for that phase, not retroactively. Test
    output must be clean (no warnings or noise).
12. **Language:** code, identifiers, and comments in English; documentation
    (`doc/`) in English. **UI copy stays in Czech** — this is a Czech
    company's internal app, and the interface language is a deliberate
    product decision, not a documentation one. Do not translate UI strings
    into English.
13. **Documentation is part of the task.** Every task writes/updates its
    `doc/*.md`. Every non-trivial decision → a new file in `doc/decision/` in
    the "what / why / how / risk" format (see the existing ones).

---

## Task 1 — Nx 23 workspace, applications, lint, format, scripts

**Phase 0, points 1 and 4.** Main tree, no parallel branch.

Create an Nx 23 monorepo **in the existing repository**
(`/Users/zibar/Workspace/shoptet-apps`, branch `feat/garage-mvp`). The
repository already contains `plan.md` (gitignored), `CLAUDE.md`, `README.md`,
`doc/` – delete or overwrite none of it.

1. Initialize an Nx 23 workspace with npm as the package manager, `nx.json`
   with caching and `targetDefaults` for `build`, `lint`, `test`.
2. `apps/garage/web` – a Next.js 16 application (App Router, React 19, TypeScript).
3. `apps/garage/api` – a NestJS 11 application.
4. `apps/garage/web-e2e` – a Playwright project (scaffolding only for now + one smoke
   test that either passes without the stack running or is marked skipped
   with a comment explaining why).
5. `apps/garage/api-e2e` – a project for Jest integration tests against a real
   Postgres (scaffolding + config only for now; tests arrive in Task 13).
6. TypeScript **strict** across the workspace (`strict: true`,
   `noUncheckedIndexedAccess`, `noImplicitOverride`,
   `exactOptionalPropertyTypes` if it doesn't conflict with Nx generators —
   if it does, enable only the ones that pass and explain the gap in the
   report).
7. ESLint flat config with:
   - Nx `@nx/enforce-module-boundaries` and **tags** prepared for the target
     structure: `type:app`, `type:feature`, `type:ui`, `type:util`,
     `type:contract`, `type:data` and scope tags `scope:web`, `scope:api`,
     `scope:shared`.
     Rules: `type:app` may depend on anything; `type:ui` (the design system)
     may not depend on `type:feature` or `type:app`;
     `libs/shared/design-system/src/primitives` must not import
     `libs/shared/design-system/src/compounds` (path-scoped `no-restricted-imports`
     in the lib's own config since `0301`, formerly the `ds:*` tags);
     `type:contract` must not import
     anything besides `zod` and `type:util`.
   - `no-restricted-imports` forbidding direct imports in `apps/**` and in
     feature code of: `react-hook-form`, `@tanstack/react-table`,
     `@tanstack/react-query`, `@orpc/client`, `socket.io-client`,
     `next-auth`, `ical-generator`, `next-intl` (except from the
     corresponding wrapper lib, which is allowed to import them). The error
     message must state which wrapper lib the developer should use.
   - Forbid `console.log` in `apps/garage/api/**` and `libs/**` (allow `console`
     only in scripts).
8. Prettier + `.editorconfig`, a uniform format for TS/TSX/JSON/MD.
9. Scripts in `package.json`: `lint`, `test`, `build`, `typecheck`,
   `affected` (`nx affected -t lint,test,build`), `format`, `format:check`.
   Ready for CI, but **do not create a pipeline file**.
10. Documentation: `doc/workspace.md` – the repo structure, how to run
    lint/test/build, what the Nx tags mean, and how to add a new lib with the
    right tags.

**Verification (must pass and be documented in the report):** `npm run lint`,
`npm run typecheck`, `npm run build` on a clean workspace, plus a
demonstration that ESLint actually rejects a forbidden import (add a
temporary file, show the error, delete the file).

**Scope – what NOT to do:** no domain libs, no Docker (Task 2), no Prisma, no
Tailwind config beyond what the Nx generator for Next creates.

---

## Task 2 — Env validation (Zod), `.env.example`, Docker Compose skeleton

**Phase 0, points 2 and 3.** Follows on from Task 1 (main tree).

1. `apps/garage/api/src/env.ts` and `apps/garage/web/src/env.ts` – a Zod v4 schema for env
   variables, fail-fast at startup with a **readable** error (print which
   variables are missing/invalid, never print their values).
   - API (minimal schema for this phase): `NODE_ENV`, `PORT`, `DATABASE_URL`,
     `AUTH_OKTA_ISSUER`, `AUTH_OKTA_AUDIENCE`, `CORS_ALLOWED_ORIGINS`,
     `LOG_LEVEL`.
   - Web: `NODE_ENV`, `NEXT_PUBLIC_API_URL`, `AUTH_SECRET`,
     `AUTH_OKTA_ISSUER`, `AUTH_OKTA_CLIENT_ID`, `AUTH_OKTA_CLIENT_SECRET`.
   - In NestJS wired through `ConfigModule.forRoot({ validate })`; in Next.js
     validated at build/boot.
   - The schema is prepared to be extended in later phases (Slack, ICS,
     throttler).
2. `.env.example` in the repo with every variable, comments, and dev values
   pointing at `mock-oauth2-server` and a local Postgres. No real secrets.
3. `docker-compose.yml`:
   - `postgres:17` with a healthcheck (`pg_isready`), a named volume, dev
     credentials from `.env`.
   - `ghcr.io/navikt/mock-oauth2-server` configured as the OIDC issuer for
     dev/e2e.
   - `adminer` only in the dev profile (`profiles: [dev]`).
   - **placeholder services** `web` and `api` (build context ready, but the
     real production Dockerfiles only arrive in Task 29 – note this with a
     comment).
4. Documentation: `doc/environment.md` – the list of env variables and what
   they do, how to start the stack (`docker compose up`), how dev/e2e differ
   from production only by env values (no test-only branches in code), how to
   verify the mock OIDC is running.

**Verification:** `npm run build` passes; starting the app with a required
variable missing ends in an immediate crash with a readable message (document
it with output).
`docker compose config` validates the file **with no daemon needed to be
running** – the Docker daemon isn't running on this machine, so don't verify
`docker compose up`; write that in the report.

---

## Task 3 — `libs/garage/shared-types` + entity schemas and the error contract in `libs/garage/contract`

**Phase 1, point 1 (part) and 2–3.** Main tree, runs in parallel with Task 6.

1. `libs/garage/shared-types` (tag `type:util`, `scope:shared`, **no** dependency on
   Zod or next-intl):
   - a date-only type `DateOnly` (a `YYYY-MM-DD` string) + a parser/serializer,
   - `todayInPrague()`, `startOfDayInPrague()`, comparing and shifting days in
     Europe/Prague,
   - Czech public holidays (movable and fixed) for a given year – a pure
     function,
   - domain constants: `ParkingGroup` (`IT` | `SHARED`), `UserRole` (`USER` |
     `ADMIN`).
   - **`isMonthOpen(targetDate, openDaysBefore, lockMode, today)`** – a pure
     function for the reservation window, exactly per `doc/decision/0004-*`
     (`FORCE_OPEN` → true, `FORCE_LOCKED` → false, `AUTO` →
     `today >= firstDayOfMonth - openDaysBefore && today < firstDayOfMonth`),
     and `monthLockState(...)` returning `NOT_YET_OPEN` | `OPEN` | `LOCKED`.
     All in Europe/Prague.
   - Unit tests including the daylight-saving transition, the year boundary,
     and the month boundary (the day before the window, the first day of the
     window, the last day of the window, the first day of the month).
2. `libs/garage/contract/src/schemas` (tag `type:contract`):
   - Zod v4 entity schemas: `User`, `ParkingSpot`, `Reservation`,
     `WaitlistEntry`, `AuditLog` – exactly per the domain model in `plan.md`,
     **plus the additions from `doc/decision/0004-*`**:
     - `User.preferredParkingSpotId` (nullable),
     - `ReservationWindowSettings` = `{ openDaysBefore: int 1–31 (default 7),
       lockMode: 'AUTO' | 'FORCE_OPEN' | 'FORCE_LOCKED' (default 'AUTO') }`,
     - `MonthLockState` = `'NOT_YET_OPEN' | 'OPEN' | 'LOCKED'` + a month
       overview schema (month, window range from–to, state).
   - `dateOnlySchema` = `z.iso.date()`, i.e. **format only**, `YYYY-MM-DD`.
     The schema **must not** validate the reservation horizon (ruling
     `window-2`): the old horizon from `plan.md` ("until the end of the
     following month") was replaced by decision `0004`, and the new horizon
     depends on `ReservationWindowSettings` read from the DB, which a static
     Zod schema can't see. Checking "not in the past" and checking the
     window are **service-level** (Task 13), on top of `isMonthOpen` /
     `monthLockState` from `libs/garage/shared-types`.
   - The error contract: an error shape schema (`code`, `message`,
     `details?`) and a **closed enum** of domain error codes:
     `SPOT_ALREADY_RESERVED`, `RESERVATION_LIMIT_REACHED`, `PAST_DATE`,
     `OUT_OF_HORIZON`, `NOT_FOUND`, `FORBIDDEN`, `ALREADY_IN_WAITLIST`,
     `CANNOT_WAITLIST_OWN_SPOT`, `SPOT_NOT_OCCUPIED`, `VALIDATION_FAILED`,
     `CONFLICT`, **`RESERVATIONS_LOCKED`**.
     Splitting the two "window" codes (ruling `window-3`): `OUT_OF_HORIZON` =
     the target month is `NOT_YET_OPEN` (reservations aren't open yet),
     `RESERVATIONS_LOCKED` = the target month is `LOCKED` (the window has
     already closed). Both are returned by the service layer, never by the
     schema.
   - Types derived exclusively via `z.infer`.
3. Schema unit tests: valid inputs, invalid inputs, edge dates (today,
   yesterday, a leap year, the year boundary). **The horizon is not tested
   here** — it belongs to `isMonthOpen` (point 1) and to the service tests in
   Task 13.
4. Documentation: `doc/contract.md` (established here, extended by Tasks 4
   and 5) – how the contract is structured, how to add a new schema, why
   types are derived.

**Scope:** no oRPC procedures (Task 4), no realtime schema (Task 5), no
endpoint implementation.

---

## Task 4 — oRPC API contract in `libs/garage/contract`

**Phase 1, point 1 (procedures).** Follows on from Task 3.

Entry point `@garage/contract` (`libs/garage/contract/src/api`). Define the oRPC
contract (`@orpc/contract`) with every domain procedure and typed errors:

- **Day overview** – in one query: spots + reservations + waitlist counts for
  a given day.
- **Reservations** – create, cancel.
- **Waitlist** – join, leave.
- **Spot management (admin)** – list, create, update, deactivate.
- **User management (admin)** – list, update (role, active status).
- **User settings** – reading and changing the license plate **and the
  preferred parking spot**.
- **ICS token** – regeneration + a helper/constant for building the ICS URL
  (the ICS feed itself is outside oRPC, see `plan.md` §Contract-first, an
  exception).
- **Reservation window** (see `doc/decision/0004-*`):
  - reading and changing the settings (`openDaysBefore`, `lockMode`) – admin
    only,
  - an overview of month states (month, window range, `MonthLockState`) for
    the admin tab,
  - the window state for a specific day is part of the **day overview**
    response, so the FE doesn't need a second query.
- **Bulk reservation** – two procedures:
  - `previewBulk` (input: a list of days in a single month) → a **read-only
    proposal**: for each day, either an assigned spot (and a flag for whether
    it's the preferred one), or a waitlist position. Writes nothing.
  - `confirmBulk` (input: the same list of days) → performs the write and
    returns the **actual** result (which may differ from the proposal if
    someone took a spot in the meantime).

Every procedure has an input and output schema and declared error codes from
Task 3. Everything via `z.infer`, nothing hand-written.

Unit tests: valid and invalid input for every procedure; a test that the ICS
URL helper builds the correct shape.

Extend `doc/contract.md` with the list of procedures and their semantics.

**Scope:** purely the contract and types – **no implementation**.

---

## Task 5 — Realtime contract (`@garage/contract/realtime`)

**Phase 1, point 4.** Follows on from Task 3 (may run after Task 4).

A separate entry point, `@garage/contract/realtime`
(`libs/garage/contract/src/realtime`), which **pulls in no oRPC dependency**:

- Zod schemas for event payloads: `cell:locked`, `cell:unlocked`,
  `reservation:created`, `reservation:cancelled`, `reservation:reassigned`,
  `waitlist:updated` (settle on and justify the exact names).
- `ServerToClientEvents` / `ClientToServerEvents` derived from them.
- A helper for the per-day room name (`roomForDate(date: DateOnly)`).
- Payloads **reference the shared entity schemas** from `src/schemas` –
  nothing is duplicated.

Schema unit tests + a test that importing `@garage/contract/realtime`
doesn't drag in `@orpc/*` (e.g. by checking dependencies in the build output,
or an explicit test case on the module graph).

Extend `doc/contract.md` with the realtime section and the rule "the server
always validates incoming client→server events".

---

## Task 6 — Design tokens (`libs/shared/design-system/tokens`)

**Phase 2.** Parallel branch (worktree), runs alongside Tasks 3–5.

Source of truth: **`doc/design/ds/colors_and_type.css`** (see
`doc/design/README.md`).

1. TS objects/constants with the whole palette, spacing scale, typography,
   radii, shadows, motion, and breakpoints – 1:1 per `colors_and_type.css`
   (colors, `--fs-*`, `--lh-*`, `--tracking-*`, `--space-*`, `--radius-*`,
   `--shadow-*`, `--dur-*`, `--ease-*`, `--container*`). Breakpoints not
   explicit in the CSS should be derived from the design and marked with a
   comment.
2. A build script generating `tokens.css` with CSS custom properties from
   the TS source.
3. Tailwind v4 setup: `@import "tailwindcss"` + `@theme inline` mapping
   custom properties onto the Tailwind theme. No hand-written duplicates of
   values.
4. `@font-face` declarations for NHaasGroteskDS with a fallback stack; copy
   the fonts from `doc/design/ds/fonts/` into the lib's assets.
5. A **snapshot test** that guards against the generated `tokens.css`
   drifting from the TS tokens (runs in CI and fails if someone changes one
   without the other).
6. Documentation: `doc/design-system.md` – how the tokens work, how to add a
   new token, why the generated CSS is committed (or why it isn't), how it
   wires into Tailwind v4.

---

## Task 7 — Storybook 10 + primitives, batch 1

**Phase 3, points 1–3 (part).** Follows on from Task 6 in the same parallel
branch.

1. Storybook 10 for `libs/shared/design-system/primitives`: `@tailwindcss/vite` in
   `viteFinal`, importing `tokens.css` in `preview.ts`, a light theme per the
   design.
2. Primitives: **Button, Input, Select, Checkbox, Radio, Badge, Avatar,
   Switch, Stepper**. Derive appearance and variants from
   `doc/design/garage-design.dc.html` and the screenshots
   (`doc/design/screens/`) – e.g. the pill radius on the CTA (`--radius-cta`),
   the primary blue `#008FFF`, the secondary "outline" button, the danger
   variant ("Zrušit rezervaci" – "Cancel reservation").
3. Every primitive gets a **story alongside** the component (variants and
   states: default, hover, focus, disabled, error, loading).
4. Unit tests (Jest + Testing Library): interaction, `role`/aria, focus
   management, keyboard.
5. Extend `doc/design-system.md` with the inventory of primitives and their
   API.

**Reminder:** the primitives are **domain-free** – no mention of a parking
spot or a reservation.

---

## Task 8 — Primitives, batch 2 (overlay and navigation)

**Phase 3, completion.** Follows on from Task 7 in the same parallel branch.

Primitives: **Modal/Dialog, Dropdown/Menu, Tabs, Tooltip, Toast/Notification**.
Same rules as Task 7 (story + tests alongside, domain-free).

Special emphasis on accessibility, since these components carry the most
risk: a focus trap and focus return for Modal, `Escape`, `aria-modal`,
keyboard navigation in Dropdown and Tabs (arrows, Home/End),
`aria-describedby` for Tooltip, `role="status"` for Toast.

Verify the modal's visuals against `doc/design/screens/08-modal-reserve.png`,
`09-modal-queue.png`, `11-settings.png`; the dropdown against
`02-avatar-menu.png`; tabs against `05-admin-window.png`.

Extend `doc/design-system.md`.

---

## Task 9 — `libs/garage/database`: Prisma 7 schema, migrations, seed

**Phase 5, point 1.** Main tree, the start of the backend branch.

1. Prisma 7: `prisma.config.ts`, the `prisma-client` generator with its
   **output inside the lib** (not into `node_modules`), the required driver
   adapter `@prisma/adapter-pg`.
2. A schema exactly per `plan.md` §Doménový model – `User`, `ParkingSpot`,
   `Reservation`, `WaitlistEntry`, `AuditLog` – **including every unique
   constraint and index**:
   - `Reservation` unique `(parkingSpotId, date)`
   - `Reservation` unique `(userId, date)`
   - `WaitlistEntry` unique `(parkingSpotId, userId, date)`
   - indexes on `date`
   - `date` is a `DATE`-typed column (`@db.Date`), never a timestamp
   - `AuditLog.payload` is `Json` (JSONB), the table is append-only
   - **`User.preferredParkingSpotId`** – a nullable FK to `ParkingSpot`,
     `onDelete: SetNull`
   - **`ReservationWindowSettings`** – a singleton table (one row, enforced
     by a constraint – justify the chosen approach in `doc/database.md`)
     with `openDaysBefore` and `lockMode`; the seed creates the default `7` /
     `AUTO`
3. Migration + seed script: parking spots per the real layout (IT:
   `E2.92`–`E2.95`; Shared: `E2.96`, `E2.65`, `E2.66`, `E2.61`, `E2.62`) and
   dev users matching the mock OIDC.
4. An exported `PrismaService`-friendly client (the actual Nest module isn't
   until Task 10/12).
5. Documentation: `doc/database.md` – an ERD (text or mermaid), why hard
   delete + AuditLog instead of soft delete, how to run a migration and seed,
   how to back up (`pg_dump`, a few lines).

---

## Task 10 — `apps/garage/api`: operational baseline

**Phase 5, point 2.** Follows on from Task 9.

Implement the whole of principle 4 from `plan.md`:

- extend the env schema from Task 2 with everything the API needs,
- `nestjs-pino` (JSON logs, request-id correlation, log level from env, no
  `console.log`),
- `@nestjs/terminus`: `/health/live` and `/health/ready` (readiness checks the
  DB),
- `app.enableShutdownHooks()` + graceful shutdown (stop accepting
  connections, finish in-flight requests, close the DB pool; Task 15 will add
  closing Socket.io – leave a hook ready for it),
- `helmet`, CORS with an allow-list of origins from env, `@nestjs/throttler`
  (a global limit + a stricter variant ready for endpoints without a
  session),
- payload size limits,
- a **global exception filter** mapping domain exceptions and Prisma errors
  (`P2002` → `SPOT_ALREADY_RESERVED` / 409, `P2025` → `NOT_FOUND`) onto the
  contract error codes from Task 3; the stack trace is logged, never sent to
  the client.

Unit tests for the exception filter (Prisma error mapping) and the health
endpoints.

Documentation: `doc/api-operations.md` – everything that's part of the
operational baseline, how it behaves with a missing env variable, what a log
record looks like, what readiness checks.

---

## Task 11 — Auth: JWKS validation of Okta tokens, guards, JIT provisioning

**Phase 5, point 3.** Follows on from Task 10.

- `passport-jwt` + `jwks-rsa`: validating issuer/audience/expiry, dynamic
  keys from a JWKS URL (configured from env → in dev it points at
  `mock-oauth2-server`, in production at Okta, **with no code change**).
- An `AuthGuard` (the default across the whole API) and a `RolesGuard` for
  `ADMIN`.
- JIT provisioning: on the first request, a user is created/matched by
  `oktaId`, falling back to email; a deactivated user (`active: false`) gets
  `FORBIDDEN`.
- Generating `icsToken` (`crypto.randomBytes`) during provisioning.
- A reusable JWKS validation service, which the Socket.io gateway in Task 15
  reuses too.

Tests: a valid token, an expired token, a wrong issuer, a wrong audience, an
unknown user (JIT), a deactivated user, the role guard.

**Forbidden:** any credentials provider or test-only branch in the code.

Documentation: `doc/auth.md` – the full FE→BE→JWKS flow, how it's tested
against the mock OIDC, what happens on key rotation.

---

## Task 12 — Domain modules: spots, users, settings, AuditLog

**Phase 5, point 4 (part).** Follows on from Task 11.

Implementing the contract from Task 4 via `@orpc/nest` (`@Implement`):

- **ParkingSpots** – admin CRUD (list, create, update, deactivate).
- **Users (admin)** – list, role change, deactivation (never hard delete).
- **User settings** – reading/changing the license plate and preferred spot,
  regenerating the ICS token.
- **Reservation window (admin)** – reading/changing `openDaysBefore` and
  `lockMode`, an overview of month states; a settings change goes into the
  AuditLog. The state is computed by the `isMonthOpen` function from
  `libs/garage/shared-types` (Task 3), **never re-implemented**.
- **Day overview** – one query returning spots + reservations + waitlist
  counts **+ the reservation-window state for that day**.
- **AuditLog service** – an append-only write for every admin action and
  mutation; Task 13 uses it too.

Unit tests for the services (Jest), including that the AuditLog is actually
written.

Documentation: `doc/api-modules.md`.

---

## Task 13 — Reservations, waitlist, and auto-promote in a transaction

**Phase 5, points 4 (reservations/waitlist) and 8.** Follows on from Task 12.
**The highest-risk task.**

Business rules exactly per `plan.md` §Byznys pravidla:

- only today and the future can be reserved (Europe/Prague),
- **the reservation window** (replaces the rule "at most until the end of the
  following month", see `doc/decision/0004-*`): for a regular user, creating
  a reservation, joining the waitlist, and leaving the waitlist are allowed
  **only when the target day's month is open** (`isMonthOpen` from
  `libs/garage/shared-types`); otherwise the contract error `RESERVATIONS_LOCKED`.
  **Cancelling one's own reservation is always allowed.** The admin is not
  constrained by the window at all. The check happens on the backend, not
  only in the UI.
- max 1 reservation per user per day, max 1 reservation per spot per day,
- an admin cancels other people's reservations (→ an AuditLog entry with an
  actor); a user only their own,
- cancellation = hard delete + an AuditLog entry,
- **auto-promote**: a single Prisma interactive transaction, `SELECT ... FOR
  UPDATE` via `$queryRaw` on the waitlist rows for that spot+day ordered by
  `createdAt, id`; the first person waiting **with no other reservation that
  same day** is promoted; their other waitlist entries for the same day are
  deleted; an empty waitlist → the spot stays free,
- the transaction is minimal – **no Slack call or broadcast inside it**;
  notifications and realtime fire only **after the commit** (prepare an
  interface that Tasks 15 and 16 will fill in),
- `P2002` → retry / a consistent contract error,
- joining the waitlist only for an occupied spot; the reservation's owner
  cannot join the waitlist for their own spot.

**Integration tests against a real Postgres** (`apps/garage/api-e2e`, Docker):
concurrent cancellation (parallel transactions), an empty waitlist, multiple
people waiting, someone waiting who has a colliding reservation the same day,
promote + a unique-constraint conflict, **a reservation in a locked month
(user → `RESERVATIONS_LOCKED`, admin → succeeds), cancelling one's own
reservation in a locked month (succeeds)**.

> The Docker daemon on this machine **is not running**. Write the tests so
> they run against `docker compose up postgres`, and state clearly in the
> report that they could not be run locally, if that's the case. Do not try
> to work around it with a mock – that goes against `plan.md`.

Documentation: `doc/waitlist.md` – a sequence diagram of cancel + promote, why
a row lock, what happens under concurrency, what happens after the commit.

---

## Task 14 — ICS feed (`libs/garage/calendar-export` + controller)

**Phase 5, point 5.** Follows on from Task 12.

- `libs/garage/calendar-export` – a service generating ICS from domain data via
  `ical-generator` (the only place `ical-generator` is imported).
- A Nest controller **outside the oRPC contract**:
  `GET /calendar/:icsToken.ics`, per-user auth via a random token in the URL,
  `Content-Type: text/calendar`, cache headers, a **stricter rate limit**
  (`@nestjs/throttler`).
- Token regeneration already exists from Task 12 – verify that the old URL
  stops working.

Tests: a valid token returns valid ICS with the expected events; an invalid
token → 404 (not 401, so tokens can't be enumerated – justify this in
`doc/decision/`); a regenerated token invalidates the old one.

Documentation: `doc/ics.md`.

---

## Task 15 — Socket.io gateway, `LockService`, broadcasts after commit

**Phase 5, point 6.** Follows on from Task 13.

- A native NestJS `@WebSocketGateway` (Socket.io v4), handshake auth: a token
  in `socket.handshake.auth.token` (**never in the query string**), validated
  with the same JWKS logic as the REST guard (the service from Task 11); an
  invalid one → disconnect; re-validated on reconnect.
- The server **validates incoming client→server events** against the Zod
  schemas from Task 5.
- Rooms per day (`roomForDate`).
- `LockService`: an interface + an **in-memory implementation** with a TTL of
  ~30s and extension (a heartbeat). A Redis implementation is **not
  implemented** – only document the upgrade path.
- A custom `IoAdapter` abstraction, so `@socket.io/redis-adapter` can be added
  later without touching the gateway code.
- Broadcasting reservation/waitlist changes **only after** the transaction
  commits (hook into Task 13's hook).
- Extend the graceful shutdown from Task 10 with properly closing Socket.io.

Tests: the lock's TTL and extension, a conflict between two locks, rejecting
an invalid handshake, rejecting an invalid payload, broadcasting only after
commit.

Documentation: `doc/realtime.md` – including an explicit upgrade path to the
Redis adapter and Redis `SET NX PX` locks.

---

## Task 16 — Slack integration and scheduled jobs

**Phase 5, point 7.** Follows on from Task 13.

- An isolated service over `@slack/web-api`: a notification when a spot frees
  up, a DM on a waitlist promotion (matching the user via
  `users.lookupByEmail`), a daily summary.
- The daily summary via `@nestjs/schedule`, a cron in **Europe/Prague**.
  Document the job's limitation with 2+ replicas and the upgrade path
  (BullMQ repeatable jobs / leader election) **in a comment**.
- **A Slack failure never breaks a domain operation**: a timeout, a simple
  retry with backoff, errors are logged. Everything toggleable via
  `SLACK_ENABLED`.

**Forbidden:** any slash commands, any interactive Block Kit – only outbound
`chat.postMessage`.

Tests: Slack fails → the domain operation still succeeds; `SLACK_ENABLED=false`
→ no call is made; retry/backoff; the cron is scheduled in the correct zone.

Documentation: `doc/slack.md`.

---

## Task 17 — `libs/shared/i18n`

**Phase 4, point 6.** Parallel branch (worktree), runs alongside the backend.

- A wrapper over next-intl (the only place next-intl is imported).
- **Re-export** the date logic from `libs/garage/shared-types` (see
  `doc/decision/0003-*`) under a stable API, so feature code imports only
  `@garage/i18n`.
- Czech public holidays + weekends, for highlighting in the date bar.
- Formatting dates in Czech (`pondělí 28. září 2026`, `září`, `2026`) –
  exactly per `doc/design/screens/07-lot.png` and `05-admin-window.png`.
- Translation keys for the contract error codes → readable Czech messages.

Tests: formatting, holidays (both fixed and movable), weekends, error-code
mapping.

Documentation: `doc/i18n.md`.

---

## Task 18 — `libs/shared/form`

**Phase 4, point 1.** Follows on from Task 17 (and the primitives from
Tasks 7–8).

A wrapper over React Hook Form + a Zod resolver (the only place
`react-hook-form` is imported): `useAppForm`, `FormProvider`, `FormField`
rendering DS primitives (`Input`, `Select`, `Checkbox`) with wired-up
validation and error state.

Tests: validation from a Zod schema is reflected in the primitive's error
state; submit; that a form can be built **without** a direct import of
`react-hook-form`.

Documentation: `doc/wrappers.md` (established here, extended by Tasks 19–22).

---

## Task 19 — `libs/shared/api-client` + `libs/query`

**Phase 4, points 2–3.** Follows on from Task 18.

- `libs/shared/api-client`: an oRPC client instance wired to `@garage/contract`,
  the auth header (the access token comes from `libs/garage/auth`, Task 20 – for now
  via an injectable provider), mapping contract errors onto typed error
  codes.
- `libs/query`: TanStack Query v5 client configuration (retry, staleTime,
  error handling on top of the contract codes), wrapper hooks wired to the
  oRPC client (`@orpc/tanstack-query`).

Tests: the wrapper correctly delegates; an error response maps onto a
contract code; retry does **not** repeat for 4xx domain errors.

Extend `doc/wrappers.md`.

---

## Task 20 — `libs/garage/auth`

**Phase 4, point 5.** Follows on from Task 19.

A wrapper over next-auth v5 / Auth.js (the only place `next-auth` is
imported):

- an Okta OIDC provider, configured from env,
- **refresh token rotation in the `jwt` callback** – the access token is
  refreshed before it expires,
- exposing the access token to `libs/shared/api-client` and `libs/garage/realtime-client`
  in a **server-safe way** (never localStorage),
- hooks `useSession`, `useRequireAuth`, and server-side helpers.

Tests: the refresh runs before expiry; a failed refresh leads to sign-out,
not a silent 401; the token never ends up in localStorage.

Extend `doc/wrappers.md` and `doc/auth.md` with the frontend part.

---

## Task 21 — `libs/garage/realtime-client`

**Phase 4, point 4.** Follows on from Task 20.

A wrapper over `socket.io-client` with types from
`@garage/contract/realtime`: `useRealtimeConnection` (the handshake auth
token from `libs/garage/auth`, reconnect logic), `useCellLock` (heartbeat lock
extension, releasing it on unmount/disconnect).

Tests: reconnect resends the token; the heartbeat extends the lock; unmount
releases the lock; an incoming event is validated against its schema.

Extend `doc/wrappers.md` and `doc/realtime.md` with the client-side part.

---

## Task 22 — `libs/shared/design-system/compounds`

**Phase 4, point 7.** Follows on from Task 8 (may run in parallel with 18–21
in the same branch).

- `DataTable` – a wrapper over TanStack Table (the only place
  `@tanstack/react-table` is imported), styled with DS tokens; sorting and
  the empty state per `doc/design/screens/03-admin-users.png` and
  `04-admin-spots.png`.
- `EmptyState`, `ConfirmDialog`.
- A story + tests alongside them; **still domain-free**.

Extend `doc/design-system.md`.

---

## Task 23 — `apps/garage/web`: shell, routing, login, health

**Phase 6, point 1.** Main tree, after both branches merge.

- Next.js 16 App Router structure, a root layout with the DS tokens and
  fonts,
- providers: `libs/query`, `libs/garage/auth`, `libs/shared/i18n`, `libs/garage/realtime-client`,
- a login page for signed-out users: a blank page with one central
  `Login přes OKTA Verify` ("Log in with OKTA Verify") button – visuals per
  `doc/design/screens/canvas-default.png`,
- a top bar: a logo on the left, avatar + dropdown on the right (`Nastavení`
  – "Settings", plus `Správa` – "Administration" for an admin, `Odhlásit se`
  – "Log out") – per `02-avatar-menu.png`,
- an `/api/health` route handler,
- defined loading / empty / error states as shared pieces for later screens.

Documentation: `doc/frontend.md`.

---

## Task 24 — The main parking-lot screen + realtime

**Phase 6, points 2–3.** Follows on from Task 23. **The most demanding FE
task.**

- The parking-lot layout per `doc/design/screens/07-lot.png` and
  `01-lot-admin.png`: an asphalt background, white dividing lines, the `IT`
  and `SHARED` groups visually separated with the count of free spots on the
  right.
- A free spot = an empty box with a `+`; an occupied one = a stylized car
  seen from above in the brand color, with the user's name and license
  plate; a waitlist badge with the count of people waiting; a cell-lock state
  (hatching + an icon + "právě upravuje …" – "currently editing …") per the
  design.
- Modals: `Rezervovat místo` ("Reserve a spot", `08-modal-reserve.png`),
  `Přidat se do fronty` ("Join the waitlist", `09-modal-queue.png` – the
  current holder + waitlist position + `Zrušit rezervaci` – "Cancel
  reservation" – for those authorized).
- **The reservation-window state** (see `doc/decision/0004-*`), exactly per
  the design:
  - a banner above the lot – green, "Rezervace na … jsou otevřené — zapisovat
    lze do …" ("Reservations for … are open — you can book until …"), yellow
    when locked; hidden when the design hides it
    (`14-lot-user-lockstate-off.png`),
  - in a locked month, free spots are shown to a regular user as
    "rezervace uzamčeny" ("reservations locked", the `⊘` symbol) and **are not
    clickable to reserve**; clicking opens an explanatory modal,
  - in the waitlist modal, a locked month shows a yellow note and the
    `Přidat se do fronty` ("Join the waitlist") action is hidden;
    `Zrušit rezervaci` ("Cancel reservation", one's own) stays available,
  - an admin retains full access even after locking, including the `⋯` menu
    on a spot tile (editing/cancelling someone else's reservation).
- A **`Hromadná rezervace`** ("Bulk reservation") button in the header – for
  a regular user in a locked month, hidden and blocked at the action level
  too; the modal is implemented by Task 31.
- Data via `libs/query` + `libs/shared/api-client`; realtime via
  `libs/garage/realtime-client`. **Realtime events invalidate/patch the query
  cache – one consistent mechanism, no ad-hoc local state.**
- Loading / empty / error states; contract error codes → Czech messages via
  `libs/shared/i18n`.

Documentation: extend `doc/frontend.md` with the realtime strategy (when to
invalidate, when to patch).

---

## Task 25 — Bottom date-navigation bar

**Phase 6, point 4.** Follows on from Task 24.

A fixed bottom bar per `doc/design/screens/07-lot.png`: prev/next arrows, the
current date in the center, a month and year selector, a `Dnes` ("Today")
button. Highlighting Czech public holidays (`STÁTNÍ SVÁTEK · DEN ČESKÉ
STÁTNOSTI` – "PUBLIC HOLIDAY · CZECH STATEHOOD DAY", a yellow bar background)
and weekends via `libs/shared/i18n`.

Changing the day changes both the realtime room and the query key – verify
with a test that it unsubscribes from the old room.

---

## Task 26 — Profile settings (license plate + ICS)

**Phase 6, point 5.** Follows on from Task 23.

The `Nastavení` ("Settings") modal per `doc/design/screens/11-settings.png`:

- a form via `libs/shared/form` – license plate **and preferred parking spot** (a
  select over active spots, an empty choice allowed); a label per the
  design: "SPZ se předplní při každé rezervaci místa. Preferované místo
  použijeme přednostně u hromadné rezervace." ("The license plate is
  pre-filled for every spot reservation. The preferred spot is used first for
  a bulk reservation."),
- an **ICS section** (missing from the design, but required by `plan.md`):
  displaying and copying the subscription URL + a token-regeneration button
  with confirmation (`ConfirmDialog`). Keep the design's visual style;
  justify the placement in `doc/decision/`.

---

## Task 27 — Admin section

**Phase 6, point 6.** Follows on from Tasks 25 and 26.

An "Administration" page with tabs per `doc/design/screens/03-admin-users.png`,
`04-admin-spots.png`, `06-admin-overview.png`:

- **Parking lot overview** – an admin's view of the day,
- **Users** – a `DataTable`, deactivation, role change,
- **Parking spots** – a `DataTable`, CRUD,
- **Reservation window** – per `doc/design/screens/05-admin-window.png`: a
  card on the left, "Otevření nového měsíce" ("Opening a new month" – a
  stepper "Otevřít X dní předem" – "Open X days ahead" – + a lock mode
  Automaticky / Vynutit otevřeno / Vynutit uzamčeno – Automatic / Force open
  / Force locked); a card on the right, "Stav měsíců" ("Month states") with a
  list of upcoming months, their window range, and a badge Otevřeno / Uzamčeno
  / Zatím neotevřeno (Open / Locked / Not yet open).

Same visual identity as the rest of the app.

---

## Task 28 — Playwright e2e

**Phase 7, points 1–3.**

- Login flow against `mock-oauth2-server` (a real OIDC redirect flow), the
  session cached via `storageState` (gitignored).
- Scenarios: login; creating a reservation; cancelling a reservation and
  auto-promote from the waitlist; a realtime cell lock between two users (two
  browser contexts); an admin editing someone else's reservation; ICS export
  (downloading the feed via the token URL and validating its contents).
- Filling in missing unit tests per coverage.

Documentation: `doc/testing.md` – what test layers exist, how to run them,
what needs Docker running.

---

## Task 29 — Production Docker, runbook, finalizing the documentation

**Phase 7, points 4–5.**

- Finalize `docker-compose.yml` – a fully functional `docker compose up`
  starting the entire stack, including the mock OIDC.
- Production Dockerfiles for both `web` and `api`: multi-stage, a non-root
  user, `HEALTHCHECK`.
- Update `CLAUDE.md` with the **actual** commands (build, lint, test, e2e).
- `README.md` – a short operational runbook (a few lines, not an essay):
  starting the stack, migrations, seeding, regenerating the ICS token,
  Postgres backups (`pg_dump`), upgrade paths (the Redis adapter and locks,
  BullMQ).
- Verify that `doc/` is complete and consistent; an index, `doc/README.md`.

---

## Task 30 — Bulk reservation: backend allocator and transaction

**An extension per `doc/decision/0004-*`.** Runs between Tasks 13 and 14
(main tree).

Implementing the `previewBulk` and `confirmBulk` procedures from Task 4.

**The allocator** (for each selected day, days are processed in ascending
order):

1. If the user has a `preferredParkingSpotId` and that spot is free that day
   → assign it and mark the result as `preferred`.
2. Otherwise take the first free active spot by a deterministic ordering
   (group `IT` before `SHARED`, within a group by `label`) – **no
   randomness**, so the preview and the confirmation stay consistent.
3. If no spot is free that day → place it on the waitlist for the spot with
   the **shortest waitlist** (a tiebreak by `label`) and return the resulting
   position.
4. A day the user already has a reservation on is skipped with an
   explanation (the rule of 1 reservation per user per day).
5. Weekends and Czech public holidays are rejected already by input
   validation.

**The difference between preview and confirm:**

- `previewBulk` is **read-only** – it must write and lock nothing.
- `confirmBulk` runs in **a single interactive transaction** and must be
  resilient to the state having changed between the preview and the
  confirmation: a collision (`P2002`) doesn't fail the whole batch, but that
  day falls onto the waitlist instead. The result is returned to the user, so
  they see what actually happened.
- The reservation window is checked for the whole target month; a regular
  user in a locked month gets `RESERVATIONS_LOCKED` (an admin succeeds).
- An AuditLog entry for every reservation created and every waitlist entry
  created.
- Broadcasts and Slack notifications **only after the commit** (the same hook
  as Task 13).

Tests: preview writes nothing; deterministic ordering (the same input twice →
the same output); the preferred spot takes priority; a full day → the
waitlist with the correct position; a day with an existing reservation is
skipped; **an integration test against a real Postgres**: two users running
`confirmBulk` concurrently for the same days doesn't violate the unique
constraints, and both get a consistent result.

Documentation: extend `doc/waitlist.md` (or a new
`doc/bulk-reservation.md`) with the allocator's strategy and why the preview
is read-only.

---

## Task 31 — Bulk reservation: FE modal

**An extension per `doc/decision/0004-*`.** Runs after Task 24 (main tree).

A modal per `doc/design/screens/10-modal-bulk.png`, two steps:

1. **Day selection** – a calendar grid for the month, columns
   `PO ÚT ST ČT PÁ SO NE` (Mon Tue Wed Thu Fri Sat Sun; weekends visually set
   back on the right). Weekends and Czech public holidays are
   **unselectable** (`libs/shared/i18n`). Below the grid, the text
   "Víkendy a svátky nelze vybrat." ("Weekends and holidays cannot be
   selected.") and "Preferované místo: `<label>`" ("Preferred spot:
   `<label>`"). CTA: "Vyberte dny" ("Select days") → "Vygenerovat rozvrh (N
   dní)" ("Generate a schedule (N days)").
2. **Schedule proposal** – a list of rows `date · day of week` + the
   assigned spot + a badge `Rezervováno · preferované` ("Reserved ·
   preferred", green), `Rezervováno` ("Reserved", blue), or `N. ve frontě`
   ("Nth in the waitlist", yellow). A summary, "X dní s místem, Y dní ve
   frontě." ("X days with a spot, Y days on the waitlist."). CTA
   "Potvrdit rozvrh" ("Confirm schedule"), or back to selection.

After confirmation, the result is compared against the proposal – if they
differ, the user must see it (not a silent difference). Invalidate the query
cache for the affected days.

For a regular user in a locked month, entry into the modal is both hidden
and blocked.
