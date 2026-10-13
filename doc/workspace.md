# Workspace – structure, scripts, boundaries

Nx 23 monorepo for Garage. This document describes **how the repo is put
together**, **how the checks are run**, and **how to add a new lib so that it
gets watched by the same boundaries as everything else**.

The binding specification is `plan.md`, broken down into tasks in
`doc/implementation-plan.md`. Decisions that deviate from `plan.md` or refine
it live in `doc/decision/`.

---

## Repo structure

**This workspace hosts more than one application**, so `apps/` and `libs/` are
namespaced by which application owns what. `libs/shared/` is for libs with
more than one consuming application; `libs/<app>/` is for libs only that
application uses. The classification rule is consumer count, not code size —
see `doc/decision/0310-the-workspace-is-namespaced-to-host-two-applications.md`,
which also records why `auth` and `shared-types` sit where they do and what
debt `api-client`'s placement carries.

```
apps/
  garage/
    web/        Next.js 16 (App Router, React 19)   tags: type:app,  scope:web
    web-e2e/    Playwright e2e for web              tags: type:app,  scope:web
    api/        NestJS 11 (API + Socket.io gateway) tags: type:app,  scope:api
    api-e2e/    Jest integration tests against the API tags: type:app,  scope:api
libs/
  shared/       more than one application consumes these
    design-system/
                one project, three layers under src/ (tokens, primitives,
                compounds) + Storybook 10
                                      tags: type:ui,   scope:web
    form/       react-hook-form wrapper              tags: type:util, scope:web
    i18n/       next-intl wrapper + Czech messages   tags: type:util, scope:web
    api-client/ oRPC client typed from the contract  tags: type:util, scope:web
  garage/    only the parking app consumes these
    contract/   Zod schemas + oRPC contract + realtime events
                (two entry points: @garage/contract and @garage/contract/realtime)
                                      tags: type:contract, scope:shared
    database/   Prisma 7 schema, migrations, seed + generated client
                                      tags: type:data,     scope:api
    auth/       next-auth v5 (Auth.js) wrapper
                (two entry points: @garage/auth and @garage/auth/client)
                                      tags: type:util, scope:web
    realtime-client/
                socket.io-client wrapper typed from the contract
                                      tags: type:util, scope:web
    calendar-export/
                ical-generator wrapper – the personal ICS feed
                                      tags: type:util, scope:api
    shared-types/
                domain constants + Europe/Prague date logic. The name predates
                the namespacing and is now misleading — nothing outside this
                application uses it (decision 0310).
                                      tags: type:util,     scope:shared
doc/            documentation, decisions, visual design export
prisma.config.ts  Prisma CLI configuration (schema in libs/garage/database, `.env` from the root)
```

**Nx project names are flat and unprefixed** (`web`, `api`, `contract`, …),
so `npx nx run web:test` still addresses the parking app's web project
regardless of where its directory sits. That is fine while there is one
application and becomes ambiguous with two; prefixing them is a separate
change, deliberately not bundled with the move (decision 0310).

**Paths built from segments do not survive a directory move by text search.**
`join(root, 'libs', 'database')` is invisible to a grep for `libs/database`.
When a project moves, grep for the string literals `'apps'` and `'libs'`
across all tracked code as well — six such sites existed at the last move,
including `prisma.config.ts` and the e2e suite's build-identity guard.

Configuration that applies to the whole workspace:

| file | what it's for |
| --- | --- |
| `nx.json` | plugins, cache, `targetDefaults`, generator defaults |
| `tsconfig.base.json` | shared `compilerOptions` + `@garage/*` path aliases |
| `eslint.config.mjs` | flat config: module boundaries, wrapper layers, `no-console` |
| `.prettierrc`, `.editorconfig` | formatting for TS/TSX/JSON/MD |
| `jest.preset.js`, `jest.config.ts` | shared Jest preset and project aggregation |

A lib can have more than one entry point: `libs/garage/contract` has
`@garage/contract/realtime` alongside `@garage/contract`, so the
Socket.io half of the contract doesn't pull in `@orpc/contract`;
`libs/garage/auth` has `@garage/auth/client`, so a browser component doesn't pull
in Auth.js's server runtime. A second entry point means a second entry in
`paths` in `tsconfig.base.json`, plus **a test that proves the isolation**
(`libs/garage/contract/src/realtime/no-orpc.spec.ts`,
`libs/garage/auth/src/lib/client-boundary.spec.ts`) — see `doc/decision/0023-*` and
`doc/decision/0046-*`.

Packages are named `@garage/<lib>` (see
`doc/decision/0005-npm-scope-lets-park.md`). The scope was derived from the
root `package.json`'s name, which Nx generators read to fill the alias in
automatically.

**That derivation no longer matches what is on disk.** The root package is
now `@shoptet-apps/source` — the repository hosts two applications and is
named after itself rather than after the first one — while every existing
lib keeps `@garage/*`, because renaming the scope touches every import in
the workspace and `doc/decision/0310-*` defers it. So a generator will offer
`@shoptet-apps/<lib>` for a new lib and be inconsistent with its fourteen
neighbours. Choose the alias deliberately rather than accepting the default,
and if you are adding several, do the scope rename first.

---

## Scripts

Everything runs from the repo root via npm. **An unsuffixed script is
workspace-wide** — it covers every project of every application, which is what
CI's `verify` job needs and what "is the tree green" means here. A `:<app>`
suffix scopes a script to one application.

| command | what it does |
| --- | --- |
| `npm run dev:garage` | `serve` + `dev` for that app's `api` and `web` – continuous |
| `npm run lint` | ESLint across every project (`nx run-many -t lint`), **`--max-warnings=0`** |
| `npm run typecheck` | `tsc --noEmit` against every project's tsconfigs |
| `npm run test` | Jest unit tests (`nx run-many -t test`) |
| `npm run build` | production build of every app, plus Storybook |
| `npm run affected` | `nx affected -t lint,test,build` – only what changed (for CI) |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check (fails if anything is unformatted) |

`dev:garage` is the only script that needs scoping today, because serving
two applications' `api` and `web` at once is never what you want. It selects
`-p tag:app:garage`, **not** `-p api,web`: Nx project names are globally
unique, so a second application cannot own a project called `api` and
scaffolding it forces a rename of these. A list of project names breaks then;
the `app:` tag does not. Every project carries one — `app:garage` or
`app:shared` — and `nx show projects -p tag:app:garage` is how you ask what
it covers. Adding `dev:<second-app>` is then one line.

E2e tests aren't part of `npm run test`; they run on demand:

```bash
npx nx run web-e2e:e2e      # Playwright; starts the dev server itself
npx nx run api-e2e:e2e      # Jest; starts api:serve itself
```

**Storybook is part of `npm run build`** (`nx run-many -t build,build-storybook`)
and of `npm run affected`, so a broken story is caught in CI rather than only by
hand. The individual targets for working on the design system:

```bash
npx nx run design-system:storybook         # dev server, port 4400
npx nx run design-system:build-storybook   # static build
```

Useful individual targets:

```bash
npx nx run web:dev          # Next.js dev server
npx nx run api:serve        # NestJS in watch mode
npx nx run-many -t lint --skip-nx-cache   # bypass the cache
npx nx graph                # dependency graph
```

CI has no pipeline file yet – deliberately. The scripts above are designed so
a pipeline just has to call them (`npm ci && npm run affected`).

---

## TypeScript

`tsconfig.base.json` enables, workspace-wide:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `noImplicitOverride: true`
- `exactOptionalPropertyTypes: true`
- `forceConsistentCasingInFileNames: true`

No project may turn any of these off. When new code hits
`exactOptionalPropertyTypes`, the fix is to adjust the type
(`prop?: T | undefined`), not to disable the check.

Every project has its own `typecheck` target (`nx:run-commands` +
`tsc --noEmit`). **A new lib must add one too** – otherwise it never becomes
part of `npm run typecheck`.

---

## Nx tags and module boundaries

Tags are written into `project.json` (`"tags": [...]`) and enforced by the
ESLint rule `@nx/enforce-module-boundaries`. Four independent dimensions are
used; **rules from every dimension must hold simultaneously** (Nx ANDs them —
see `doc/decision/0017-*`).

### The `type:` dimension – what role a lib plays

This dimension **partitions the workspace without remainder** (every project
carries exactly one `type:` tag), which is why the npm allow-list
(`allowedExternalImports`) hangs off it too.

| tag | meaning | may depend on | may use from npm |
| --- | --- | --- | --- |
| `type:app` | an application (`apps/*`) | anything; nothing may depend on an app | `*` |
| `type:feature` | domain composition | `feature`, `ui`, `util`, `contract`, `data` | `tslib` |
| `type:ui` | the design system, domain-free | `ui`, `util` | React, `clsx`, `tailwind-merge`, `class-variance-authority`, TanStack Table, Storybook |
| `type:util` | wrapper layers and helpers | `util`, `contract` | React/Next + the union of packages from `WRAPPED_LIBRARIES` |
| `type:contract` | `libs/garage/contract` – Zod + oRPC | `layer:foundation` | `zod`, `@orpc/contract`, `tslib` |
| `type:data` | data access (`libs/garage/database`) | `data`, `util`, `contract` | Prisma |

### The `layer:` dimension – the bottom of the graph

| tag | may depend on | may use from npm |
| --- | --- | --- |
| `layer:foundation` | **nothing** | **nothing** |

Only one project carries it, `libs/garage/shared-types`. It separates it from the
wrappers, which share the same `type:util` tag but sit **above** the contract,
whereas `shared-types` sits **below** it. Without this, `type:util →
type:contract` and `type:contract → type:util` would form a cycle. The
resulting layering is acyclic: `app → feature → ui → util → contract →
foundation`.

> **Watch the difference between "missing" and "empty":**
> `allowedExternalImports` **left out entirely** restricts nothing (any
> package passes), whereas `allowedExternalImports: []` bans everything. That's
> exactly why every `type:` tag has a list, even if it's just `['tslib']`.
> Details and probe evidence: `doc/decision/0017-*`.

### The `scope:` dimension – which side a lib lives on

| tag | may depend on |
| --- | --- |
| `scope:web` | `scope:web`, `scope:shared` |
| `scope:api` | `scope:api`, `scope:shared` |
| `scope:shared` | `scope:shared` |

This dimension enforces decision `0003`: `apps/garage/api` (`scope:api`) may depend
on `libs/garage/shared-types` (`scope:shared`), but **not** on `libs/shared/i18n`
(`scope:web`), so `next-intl` never reaches the backend.

### The `ds:` dimension – gone, and what replaced it

`ds:tokens` / `ds:primitives` / `ds:compounds` tagged three Nx projects and gave
`@nx/enforce-module-boundaries` a handle on the direction tokens → primitives →
compounds (`doc/decision/0007-*`). The three layers are now three directories of
one project, so there is no project boundary left for the constraints to match
and they were removed rather than left to never fire.

The rule is unchanged and still machine-enforced: path-scoped
`no-restricted-imports` groups in `libs/shared/design-system/eslint.config.mjs`, one
per layer, catching both the workspace alias and a relative escape. See
`doc/decision/0301-the-design-system-is-one-package-and-the-layer-rule-moved-to-lint-paths.md`.

These entries carry **no** `allowedExternalImports`, and that is deliberate.
Task 8's branch put a tighter npm list on the then-existing `ds:tokens` and
`ds:primitives` tags, on
the theory that because Nx ANDs the dimensions a second list must be an
intersection and could only narrow. **That theory was probed at merge and it is
false.** With `clsx` on `type:ui`'s list and absent from a `ds:primitives` list,
an `import clsx from 'clsx'` inside the primitives layer produced no
error at all: one matching constraint that permits a package is enough, so the
second list never narrows anything. Shipping it would have been a rule that
reads as enforcement and enforces nothing – which is the failure mode
`eslint.config.mjs` has already been caught in four times, and the reason this
document tells you to probe a boundary rule rather than read it.

The npm surface therefore stays on the `type:` dimension
(`doc/decision/0017-*`). The design system's genuinely tighter surface – it is
meant to be a closed layer with a near-zero runtime dependency footprint, and
`cx.ts` exists precisely so that no class-name helper has to be installed – is
enforced by `no-restricted-imports` in `libs/shared/design-system/eslint.config.mjs`,
where it does fire. That one file carries the probe that proves it, and every
block in it spreads the wrapper-ban patterns back in: `no-restricted-imports` is a single rule, so a lib-local block
that sets it replaces the root's copy outright, and a lib adding its own bans
without spreading those in would silently switch the wrapper ban off for itself.

---

## Wrapper layers (`no-restricted-imports`)

Application and library code must not import these packages directly. The
only allowed place is the wrapper lib that owns them:

| forbidden package | use instead | only allowed directory |
| --- | --- | --- |
| `react-hook-form` | `@garage/form` | `libs/shared/form` (done) |
| `@tanstack/react-table` | `@garage/design-system/compounds` | `libs/shared/design-system/src/compounds` |
| `@tanstack/react-query` | `@garage/query` | `libs/query` (done) |
| `@orpc/client` | `@garage/api-client` | `libs/shared/api-client` (done) |
| `socket.io-client` | `@garage/realtime-client` | `libs/garage/realtime-client` (done) |
| `next-auth` | `@garage/auth` / `@garage/auth/client` | `libs/garage/auth` (done) |
| `ical-generator` | `@garage/calendar-export` | `libs/garage/calendar-export` (done) |
| `next-intl` | `@garage/i18n` | `libs/shared/i18n` |

The list lives in `eslint.config.mjs` in a single map, `WRAPPED_LIBRARIES`;
the global ban and the per-wrapper exceptions are both generated from it, so
they can't drift apart. The error message always states which wrapper lib the
developer should use instead.

`no-console: error` also applies in `apps/garage/api/**` and `libs/**` – the backend
logs through `nestjs-pino`. Console is allowed only in `tools/**`,
`scripts/**`, `**/scripts/**`, and in configuration files.

`libs/garage/shared-types` is handled specially: it has its own
`no-restricted-imports` block that additionally bans **`zod`** there. The Nx
`type:util` dimension can't express this – the wrapper libs, which must
depend on third parties, share the same tag. Without this block, nothing
would stop `apps/garage/api` from pulling in Zod through `shared-types` (see
`doc/decision/0003-*`).

> **Trap when editing `eslint.config.mjs`:** Nx runs `eslint .` with **cwd set
> to the project's directory**, not the repo root. A config object whose
> `files` are root-relative paths (`apps/**`, `libs/shared/form/**`) must therefore
> set `basePath: workspaceRoot` – otherwise the glob is matched against a
> project-relative path, never matches, and the rule **silently does
> nothing**. After every change to a path-scoped rule, verify it with a
> temporary file, not just by lint passing.

---

## How to add a new lib

1. **Generate it.** The `@garage/<name>` alias is added to
   `tsconfig.base.json` automatically.

   ```bash
   # a pure TypeScript lib (contract, util, backend service)
   npx nx g @nx/js:lib libs/garage/shared-types --name=shared-types \
     --unitTestRunner=jest --bundler=none --linter=eslint --useProjectJson

   # a React lib (design system, frontend wrappers)
   npx nx g @nx/react:lib libs/shared/design-system/primitives --name=design-system-primitives \
     --unitTestRunner=jest --bundler=none --linter=eslint --useProjectJson
   ```

   The design-system command above is **history**, kept because it records how
   the workspace was scaffolded. The three design-system libs it produced were
   later merged into one project, `design-system`, with the layers as
   directories under `libs/shared/design-system/src/` and the `ds:*` tags removed —
   `doc/decision/0301-the-design-system-is-one-package-and-the-layer-rule-moved-to-lint-paths.md`.
   Generating a new design-system layer is not a thing you do any more; you add
   a directory.

2. **Set the tags** in `libs/<name>/project.json`. Planned split:

   | lib | tags |
   | --- | --- |
   | `libs/garage/contract` | `type:contract`, `scope:shared` |
   | `libs/garage/shared-types` | `type:util`, `scope:shared`, `layer:foundation` |
   | `libs/shared/design-system` | `type:ui`, `scope:web` |
   | `libs/shared/form`, `libs/query`, `libs/shared/api-client`, `libs/garage/realtime-client`, `libs/garage/auth`, `libs/shared/i18n` | `type:util`, `scope:web` |
   | `libs/garage/calendar-export` | `type:util`, `scope:api` |
   | `libs/garage/database` | `type:data`, `scope:api` |

   A project with no tags is restricted by nothing – **an untagged lib is a
   hole in the boundaries.** When a lib needs an npm package that isn't in the
   `NPM_ALLOWLIST` for its `type:` tag, lint fails naming it; add it there in
   one line, so the change is visible in review.

3. **Add a `typecheck` target** to `project.json`:

   ```json
   "typecheck": {
     "executor": "nx:run-commands",
     "options": { "command": "tsc --noEmit -p libs/<name>/tsconfig.lib.json" }
   }
   ```

4. **Verify**: `npm run lint && npm run typecheck && npm run test`.

> **Lint fails on warnings too.** `nx.json` adds `--max-warnings=0` to every
> `lint` target. Without it, `nx run-many` exits 0 even if ESLint printed
> warnings, and the summary line "Successfully ran targets" hides them —
> exactly how Task 4 let a warning slip into main. Global constraint 11 wants
> clean output, so let the build enforce it, not a reviewer's attention.

---

## Formatting notes

`npm run format` runs over the source code, not over `doc/` – hand-written
documents and the design export are in `.prettierignore`, so Prettier doesn't
reflow tables and text that aren't its to format.
