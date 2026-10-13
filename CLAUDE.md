# CLAUDE.md

## Language

Everything will be written in EN by default — code, identifiers, comments,
and documentation (`doc/`, this file). The two deliberate exceptions:
`plan.md` (the binding spec, written in Czech — see below) stays as-is, and
**UI copy** is **written** in Czech, because this is a Czech company's internal
app and the interface language is a product decision, not a documentation one.
Czech remains the source of truth: `apps/garage/web/messages/cs.json` is where copy
is written, and its keys define what exists. English is a translation that
sits alongside it (`en.json`), kept in step by the parity guard at
`apps/garage/web/messages/messages.spec.ts`. New copy is written in Czech first and
then translated — never English-first, and never by replacing a Czech string
with an English one. See `doc/i18n.md` for details.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

**This workspace is built to host more than one application**, though the
parking app is currently the only one (a `wishlist` scaffold was removed). `apps/` and `libs/` are
namespaced by owner: `apps/garage/*` and `libs/garage/*` belong to the
parking app, `libs/shared/*` holds the four libs a second application also
consumes (`design-system`, `form`, `i18n`, `api-client`). A lib's namespace
is decided by **how many applications consume it**, not by how much code it
holds — `doc/decision/0310-*` states the rule, records why `auth` and
`shared-types` sit under `garage/` despite looking generic, and names the
one piece of debt the split exposed (`libs/shared/api-client` still imports
this app's contract at runtime; that must be resolved before a second
contract exists).

**Nx project names are flat**: `web`, `api`, `contract` and the rest are
unprefixed, so `npx nx run web:test` still works from anywhere and the
commands below are unaffected by the directory layout. They will not stay
that way — project names are globally unique, so a second application cannot
own a project called `api` either, and scaffolding it forces the rename.

Every project therefore also carries an **`app:` tag** — `app:garage` or
`app:shared` — and that is what a per-application command selects on:
`nx run-many -t lint -p tag:app:garage`, never `-p api,web`. The tag
survives the rename; a list of project names does not. In `package.json`,
an unsuffixed script is workspace-wide and a `:<app>` suffix scopes it
(`npm run dev:garage`).

The parking app is scaffolded and all of Fáze 0–7 is written:
`apps/garage/api` (NestJS 11), `apps/garage/web` (Next.js 16),
`apps/garage/api-e2e`, `apps/garage/web-e2e`, and ten libs.
`npm ci` first — several agents have skipped it in a fresh worktree and spent
the next hour on spurious `Module not found` errors in `api:build`.

**When you move a project, grep for the string literals `'apps'` and `'libs'`
too**, not only for slash-separated paths. `join(root, 'libs', 'database')`
survives a search-and-replace of `libs/database` untouched and then fails
somewhere far away — that is how `prisma.config.ts`, the database suites'
migrations directory and the e2e build-identity guard each broke once.

**The documentation map is `doc/README.md`**; it indexes every topic document
and all 192 decision records. `README.md` is the operational runbook.

Before reading a specific topic document or decision record, check its
index first — `doc/README.md` for topic documents, `doc/decision/README.md`
for decision records — rather than opening files by guessing a name or
grepping the whole directory. The indexes are one-line-per-entry, so a scan
of one is far cheaper than opening several candidate files to find the right
one.

### Commands

Every command below was run in this repository and exited 0, with one stated
exception (`web-e2e:e2e`, below). When you add one here, run it first — a
command that was true when it was written and is false now is worse than an
absent one, because a reader trusts it.

```bash
npm ci                 # always, in a fresh worktree, before anything else

npm run dev:garage  # serve,dev for this app's api and web — continuous
npm run lint           # nx run-many -t lint
npm run typecheck      # nx run-many -t typecheck
npm test               # nx run-many -t test
npm run build          # nx run-many -t build,build-storybook
npm run format:check   # nx format:check   (CI adds --all; see below)
npm run format         # nx format:write
```

Per project and per file:

```bash
npx nx run web:test                      # one project
npx nx run web:test -- lot-view          # one file, by name pattern
npx nx run api:build
npx nx serve api                         # continuous, port 3000
npx nx run web:dev                       # continuous, port 4200 (pinned; see below)
npx nx show project api --json           # what targets a project actually has
```

Layers that need infrastructure — see `doc/testing.md` for what each covers:

```bash
docker compose --profile dev up -d       # PostgreSQL 17, mock OIDC issuer, adminer
npx prisma migrate deploy
npx prisma db seed
npx nx run api:test-db                   # the eight *.db.spec.ts suites (needs DATABASE_URL)
npx nx run api-e2e:e2e
npx nx run web-e2e:e2e                   # documented in doc/testing.md, not re-measured here
```

**`api:test-db` needs `DATABASE_URL` in the environment**, and in the repository
root Nx supplies it from `.env`. In a **worktree** it does not — `.env` is
git-ignored and does not travel — so the target fails before it reaches a test:
`DATABASE_URL is not set. … It does not skip itself, on purpose.` (measured from
a stripped shell: exit 1 without it, exit 0 and **8 suites / 94 tests** with it).
Either copy `.env` in, or pass it for the one command:

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' /path/to/shoptet-apps/.env | sed 's/^DATABASE_URL=//') \
  npx nx run api:test-db
```

`web-e2e:e2e` is **48 passed, exit 0** — the fifteen spec files, the three
persona sign-ins in `support/auth.setup.ts`, and `support/build-identity.setup.ts`.
In a worktree it needs the whole `.env` copied in, not just `DATABASE_URL`;
without it the API exits on its own env schema before a test runs. Measured in
both configurations, because they are not the same suite: `nxE2EPreset` sets
`workers: process.env.CI ? 1 : undefined`, so a local run is parallel and CI's
is serial. `CI=true npx nx run web-e2e:e2e --skip-nx-cache` is the one command
that reproduces what CI actually runs — **48 passed, exit 0, 27.6 s**, against
18 s parallel. Four things are worth knowing before you run it yourself:

- **Free port 4200 first, and expect a loud failure if you forget.** The suite
  no longer adopts whatever is listening: `reuseExistingServer` is `false` for
  the web server, so an occupied 4200 stops the run with _"is already used"_.
  It used to be `!process.env['CI']` — `true` on every path that existed —
  while the suite leaked its own `next start` past Playwright's teardown, so
  the _next_ run adopted the previous one's server, reported 20 passed, and
  ran no build at all. Both mechanisms are fixed and
  `build-identity.setup.ts` asserts the outcome;
  `doc/decision/0285-the-browser-suite-starts-a-server-it-can-kill-and-refuses-to-adopt-one`.
- **A run leaves both ports free.** If 4200 is still held after one, that is a
  regression in the above, not housekeeping.
- **A new spec file needs a day of its own.** `support/dates.ts`'s
  `SPEC_DAY_SLOTS` gives each spec file one business day of the target month,
  because a reservation is unique per `(spot, date)` _and_ per `(user, date)`:
  two files booking the same persona on the same day fail each other
  intermittently. Add an entry there rather than reusing one. The same file
  is where the suite's date arithmetic lives — never a literal date, which
  rots into a Saturday or a public holiday.
- **Exit 1 after a passing summary line is not a test failure.** Nx writes its task history
  to a SQLite database under `.nx/`, and concurrent runs from several worktrees
  corrupt the write; the same thing has been seen here as exit 1 after 509
  passing tests. Read the suite's own summary line, not just `$?`.

**`npm test` does not run the database suites.** `apps/garage/api/jest.config.cts`
excludes `*.db.spec.ts` because they need a live PostgreSQL; they run under
`api:test-db`, and in CI in their own job. A change to `SELECT … FOR UPDATE`,
to transaction isolation, or to waitlist promotion is untested until you have
run that target.

### Things that are the way they are on purpose

- **Ports.** The API is on 3000, the web app on 4200. `web:dev` is pinned to
  `--port 4200` because the workspace-root `.env` carries `PORT=3000` (the
  API's) and Nx injects it into every target; `next dev` would otherwise read
  it and collide. `web:start` deliberately still honours `PORT`, for
  containers — do not "fix" it.
- **The API's probes are at `/health/live` and `/health/ready`**, not under
  `/api`: `configureApp()` passes them to `setGlobalPrefix`'s `exclude`. The
  web app has its own `/api/health`, which is a genuine Next.js route.
- **The oRPC transport is at `/api/rpc/…`**, not `/api/…`. Measured:
  `POST /api/rpc/me/get` → 401 (the route exists and the guard ran),
  `POST /api/me/get` → 404.
- **`.env` is git-ignored and does not travel with a worktree.** Copy it in.
  `P1000` from anything Prisma means `DATABASE_URL` is missing or wrong.
- **`prisma migrate reset` destroys the database** and is not part of any
  routine here. If the schema is behind, `prisma migrate deploy` is the
  command.
- **`nx format:check` with no base ref checks nothing** and passes vacuously,
  which is why CI runs `nx format:check --all`.

### CI

`.github/workflows/ci.yml` — four jobs: `verify` (format, lint, typecheck,
test, build, build-storybook), `database` (`api:test-db` against a `postgres:17`
service), `e2e` (`api-e2e:e2e` and `web-e2e:e2e` against a `postgres:17` service
and a `mock-oauth2-server` container), and `images` (both production images
build). `doc/decision/0206-ci-runs-the-database-suites-against-a-real-postgres`
and `doc/decision/0286-ci-runs-the-e2e-suites-because-nothing-else-does`.

`e2e` was missing until that record: neither browser journey nor the API over
HTTP was gated by anything, so sign-in, sign-out durability, the cell-lock
broadcast, waitlist promotion through the UI and the ICS feed ran only when a
developer remembered. It also means `CI` is now genuinely set for the browser
suite, which several config comments had been assuming for a while.

## Authoritative spec

`plan.md` (in Czech) is the full, binding build spec for this project — a company parking-reservation app (Nx monorepo, Next.js + NestJS, oRPC/Zod contract-first, tokenized design system, realtime via Socket.io, Slack + ICS integrations). Key technology choices (oRPC over ts-rest, Zod v4, Tailwind v4 CSS-first tokens, Auth.js v5 + Okta JWKS validation in NestJS, Prisma 7, mock OIDC server for dev/e2e) were researched and fixed in `plan.md` (§"Klíčová technologická rozhodnutí") — do not swap them without the user's approval. It is intentionally strict about **architecture and the order of work**: each phase (Fáze 0–7, listed in the file) must build and pass its tests before the next phase begins. Read `plan.md` in full before starting or continuing implementation — do not summarize/rebuild its rules from memory, and do not skip ahead in phase order.

Non-negotiable architectural rules from `plan.md` that apply to every phase (see the file for full detail):

- **Contract-first**: all FE↔BE data shapes are defined once as Zod schemas in the single `libs/garage/contract` lib — shared entity schemas plus two entry points: `@garage/contract` (API, via oRPC) and `@garage/contract/realtime` (Socket.io events — Zod payload schemas, validated server-side). TS types are always derived (`z.infer`), never hand-duplicated. No endpoint/DTO/event may exist in code before it exists in the contract. Errors are typed contract errors; reservation dates are date-only (`YYYY-MM-DD`) in Europe/Prague.
- **Design-system-first**: tokens (`libs/shared/design-system/src/tokens`) → primitives (`libs/shared/design-system/src/primitives`) → compounds (`libs/shared/design-system/src/compounds`, e.g. DataTable) → domain-specific composition, which lives only in app feature code. The three layers are directories of one Nx project, `design-system`, with one entry point each. Primitives and compounds each get a Storybook story written alongside them and must stay presentation-only with no domain data; compounds may import primitives, never the reverse — enforced by path-scoped `no-restricted-imports` rules in `libs/shared/design-system/eslint.config.mjs` (`doc/decision/0301-the-design-system-is-one-package-and-the-layer-rule-moved-to-lint-paths.md`).
- **Mandatory wrapper layers**: app/feature code must never import react-hook-form, TanStack Query/Table, socket.io-client, next-auth, next-intl, or ical-generator directly — always through the corresponding `libs/*` wrapper (table in `plan.md`). ESLint (Nx module boundaries / `no-restricted-imports`) must enforce this. A one-off, non-recurring third-party import elsewhere in app code is acceptable only with a comment explaining why no wrapper was created — but this exception does not apply to the libraries listed above.
- Validation is Zod-only; `class-validator`/`class-transformer` are not used in NestJS.
- No Sentry/metrics/APM/alerting (next phase), no Slack slash commands or interactive Block Kit — Slack integration is outbound `chat.postMessage` notifications only. Note: structured logging (nestjs-pino), health endpoints and graceful shutdown are baseline hygiene required by `plan.md` (§"Provozní základ") and are **not** covered by the no-monitoring rule.
- Single-instance deployment is the stated target: no Redis/BullMQ/message brokers in the MVP — build the documented abstractions (`LockService`, IoAdapter) and leave the upgrade paths described in `plan.md`.

## Visual design source of truth

A finished visual design exists at the Claude Design link in `plan.md` (§"Vizuální design – zdroj pravdy"). Try to open it before inventing token/visual values for the design system (Fáze 2–3); if it's inaccessible, stop at the start of Fáze 2 and ask the user for an exported version rather than guessing, per the fallback procedure described there.

## Working style expected in this repo

- Follow the phase order in `plan.md` exactly; after each phase, report what was created and confirm the project builds (and tests pass, where relevant) before moving to the next phase.
- Write tests alongside the phase that introduces the code (Jest for units on both FE/BE, Playwright for e2e in Fáze 7), not retroactively.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
