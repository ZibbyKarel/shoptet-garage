# 0313 – The parking application is renamed `garage`

**Date:** 2026-09-17 · **Status:** accepted ·
**Builds on:** `doc/decision/0005-npm-scope-lets-park.md`,
`doc/decision/0310-the-workspace-is-namespaced-to-host-two-applications.md`

## What

The parking application, its libraries, its alias scope, its Nx tag, its
database identifiers and its UI brand string are all named `garage`. Nothing
in the workspace is named `lets-park` any more, with three deliberate
exceptions listed under §"What was not renamed".

Concretely:

| Before | After |
| --- | --- |
| `apps/lets-park/*`, `libs/lets-park/*` | `apps/garage/*`, `libs/garage/*` |
| `@lets-park/*` (all fourteen aliases) | `@garage/*` |
| `app:lets-park` (Nx tag), `dev:lets-park` (npm script) | `app:garage`, `dev:garage` |
| `LETS_PARK_ALLOW_DESTRUCTIVE_RESET`, `LETS_PARK_ORIGINAL_DATABASE_URL` | `GARAGE_ALLOW_DESTRUCTIVE_RESET`, `GARAGE_ORIGINAL_DATABASE_URL` |
| Postgres role/database/password `lets_park`, `lets_park_dev_password`, `lets_park_ci` | `garage`, `garage_dev_password`, `garage_ci` |
| `shell.brand` = `Let’s Park` in `cs.json` and `en.json` | `Garage` |
| Compose aliases `lets-park-api`, `lets-park-oidc`, `lets-park-postgres` | `garage-api`, `garage-oidc`, `garage-postgres` |

The directories moved with `git mv`, so `git log --follow` still crosses the
rename.

## Why the alias scope became `@garage/*` and not something neutral

`doc/decision/0310-*` already recorded that `@lets-park/design-system` is the
wrong scope for a package a second application depends on, and deferred the
fix. The rename was the obvious moment to split app libs from shared ones —
`@garage/*` alongside a neutral `@shared/*` — and that was deliberately **not**
done. The debt 0310 names is not the scope string; it is that
`libs/shared/api-client` imports this application's contract at runtime. A
scope split renames fourteen aliases and every import in the tree without
moving that dependency one line, so it buys a cosmetic improvement at the
price of a second sweep across the same files. The scope is a single
search-and-replace whenever the real fix lands. `libs/shared/*` on disk and
the `app:shared` tag already say which libs are shared; the alias saying
`@garage` is redundant, not wrong-in-a-way-that-breaks-something.

The mismatch the root `package.json` warns about therefore still stands: Nx
generators derive a new lib's scope from the root package name
(`@shoptet-apps/source`, `doc/decision/0006-*`), so a generated lib is offered
`@shoptet-apps/…` while every existing one is `@garage/…`. Pick the alias
deliberately; do not accept the generator's default.

## Why the database identifiers were renamed too

They did not have to be — a Postgres role name is invisible to users, and
renaming it invalidates every existing local volume: the next Prisma call
fails with `P1000` until the developer runs `docker compose --profile dev
down -v`, `prisma migrate deploy` and `prisma db seed`. That cost was accepted
once, deliberately, because the alternative is a permanent `lets_park` in
`.env`, `.env.example`, `.env.docker.example`, `docker-compose.yml`,
`.github/workflows/ci.yml` and the `disposable-database` fixtures — six places
where a reader who has never heard of the old name has to look it up. CI is
unaffected: its Postgres service is created fresh from the workflow's own
environment.

`GARAGE_ALLOW_DESTRUCTIVE_RESET` was renamed on the same reasoning, with one
property worth stating: anybody carrying the old override in a shell profile
now finds the guard **closed**, not open. A renamed destructive-action guard
fails safe.

## What was not renamed

- **`doc/decision/*` prose and filenames.** The records are append-only and
  historical; a record that says the team chose `@lets-park` in Fáze 0 is
  telling the truth about Fáze 0. Only **paths, aliases and identifiers**
  inside them were rewritten, so that a citation like
  `apps/garage/api/src/env.ts` still resolves. `0005-npm-scope-lets-park.md`
  keeps its filename — renaming it would break every citation of a slug that
  `doc/decision/0207-*` requires to be cited in full.
- **Session logs** — `.superpowers/**`, `docs/superpowers/**`,
  `.playwright-mcp/*.yml`. Dated transcripts of work that happened; rewriting
  them would make them lie.
- **`Lets Park.dc.html`** — the artifact's name inside Claude Design, which
  this repository cannot rename. Its local export was originally kept as
  `doc/design/lets-park-design.dc.html`; it was renamed to
  `doc/design/garage-design.dc.html` on 2026-10-13, together with every
  comment that cites it (`doc/decision/0002-visual-design-source-of-truth.md`).

## Consequences

- A developer with an existing local stack must re-provision once:
  `docker compose --profile dev down -v && docker compose --profile dev up -d`,
  then `npx prisma migrate deploy && npx prisma db seed`.
- `.env` is git-ignored and does not travel with a worktree, so every
  worktree's copy carries the old `DATABASE_URL` until it is refreshed from
  the root one.
- The GitHub repository was `shoptet-apps` at the time of this record, so the
  rename needed nothing there; on 2026-10-13 it was renamed to
  `ZibbyKarel/shoptet-garage` (GitHub redirects the old URL). The local
  checkout directory was renamed to
  match (`~/Workspace/lets-park` → `~/Workspace/shoptet-apps`), which is why
  Compose derives the project name `shoptet-apps`: the containers are
  `shoptet-apps-postgres-1` and friends. Their **network aliases**, which is
  what the application resolves, are `garage-*` — the two names answer
  different questions and are not meant to match.
- Renaming the checkout directory is itself a re-provision, for the same
  reason the role rename is: `lets-park_postgres-data` is a different volume
  from `shoptet-apps_postgres-data`. The stack was brought down with `-v`
  before the move and re-seeded after it.
