# Garage

Company parking-reservation app. Nx monorepo: `apps/garage/api` (NestJS 11) and
`apps/garage/web` (Next.js 16), sharing a contract-first Zod contract over oRPC, with
Socket.io realtime, Okta sign-in, a personal ICS feed and PostgreSQL 17 behind
Prisma 7.

**The documentation map is [`doc/README.md`](doc/README.md).** This file is the
runbook: how to start it, migrate it, back it up, and what to do when it grows.

---

## First run — development on the host

Requires Docker and the Node version in [`.nvmrc`](.nvmrc).

```bash
npm ci
cp .env.example .env                  # git-ignored; edit if you like
cp .env.example apps/garage/web/.env         # Next.js reads env files from its own directory
docker compose --profile dev up -d    # PostgreSQL 17, mock OIDC issuer, adminer
npx prisma migrate deploy
npx prisma db seed                    # development fixture: 9 spots, 4 users
npm run dev:garage                 # api on :3000, web on :4200
```

Then open <http://localhost:4200> and sign in — see **How to log in on dev**,
below.

|             |                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| web         | <http://localhost:4200>                                                                                                 |
| API         | <http://localhost:3000/api> — oRPC at `/api/rpc/…`, probes at `/health/live` and `/health/ready` (**not** under `/api`) |
| adminer     | <http://localhost:8081>                                                                                                 |
| OIDC issuer | <http://localhost:8080/default>                                                                                         |

`.env` is git-ignored and **does not travel with a git worktree**; a missing
`DATABASE_URL` is the usual cause of a mysterious `P1000`.

## How to log in on dev

`mock-oauth2-server` asks for a subject and accepts anything; the API matches
the seeded account by **email**, so it has to be given as an optional claim.
On the sign-in screen, click the Okta button, then in the mock issuer's form
enter a subject and put the JSON below in its _Optional claims JSON_ box
(`doc/decision/0180-the-e2e-login-types-the-claims-the-mock-issuer-does-not-mint`).
Leaving the claims box empty signs you in without an `email`, which the API
does not recognise.

| Persona      | Subject        | Optional claims JSON                                     | Role  |
| ------------ | -------------- | -------------------------------------------------------- | ----- |
| Dev Admin    | `dev-admin`    | `{"email":"admin@example.com","name":"Dev Admin"}`       | ADMIN |
| Dev User     | `dev-user`     | `{"email":"user@example.com","name":"Dev User"}`         | USER  |
| Dev User 2   | `dev-user2`    | `{"email":"user2@example.com","name":"Dev User Two"}`    | USER  |
| Dev Inactive | `dev-inactive` | `{"email":"inactive@example.com","name":"Dev Inactive"}` | USER  |

These four come from the seed fixture (`libs/garage/database/src/lib/seed-data.ts`)
and only exist after `npx prisma db seed`. Open a second browser (or a private
window) as `dev-user2` to see the realtime cell-lock and booking broadcasts
land in another tab.

## Everyday commands

```bash
npm run dev:garage  # serve this app's api and web (continuous)
npm run lint           # every project in the workspace, both applications
npm run typecheck
npm test               # unit suites; excludes *.db.spec.ts, which need Postgres
npm run build          # every app plus Storybook
npm run format:check   # add --all to check the whole tree, as CI does

npx nx run api:test-db                     # the database suites (needs Postgres)
npx nx run web:test -- lot-view            # one file, by name pattern
npx nx run api-e2e:e2e                     # the API over real HTTP
npx nx run web-e2e:e2e                     # the eight Playwright journeys
```

`doc/testing.md` explains what each layer covers and what has to be running.
All of these run in CI, in four jobs — including the two e2e targets, which
until recently ran only when somebody remembered
(`doc/decision/0286-*`).

Free port 4200 before the browser suite. It starts its own server and refuses
to adopt one, so anything already listening there — a `nx run web:dev`, a
leftover `next start` — stops the run with _"is already used"_ rather than
letting it test the wrong app (`doc/decision/0285-*`).

## The containerised stack

The production images, the migration job and the infrastructure, all in
containers. This is how the deployable artifacts are exercised.

```bash
cp .env.docker.example .env.docker     # git-ignored; put real values here
docker compose --env-file .env.docker --profile dev --profile app up -d --build
```

One host-side prerequisite, once, and only while the **mock** issuer is in use —
add to `/etc/hosts`:

```
127.0.0.1 garage-api garage-oidc
```

Both names have to mean the same server from the browser and from inside the
containers, because `mock-oauth2-server` builds the `iss` it mints from the Host
header it was asked on
(`doc/decision/0201-the-issuer-url-must-be-one-name-on-both-sides-of-the-network`).
With a real Okta tenant the issuer is already a public name.

The web app is published on <http://localhost:4200> and the API on
<http://garage-api:3000>. Startup order is enforced: Postgres becomes
healthy, `migrate` applies pending migrations and exits 0, `api` starts and its
`/health/ready` goes green, then `web`.

```bash
docker compose --env-file .env.docker --profile dev --profile app ps
docker compose --env-file .env.docker --profile app logs -f api
docker compose --env-file .env.docker --profile dev --profile app down     # add -v to drop the volume
```

### Which profile

Every service carries one, so a bare `docker compose up` starts nothing and you
have to say what you want. Pick by what is _not_ yours to run:

| You are running                      | Command                       |
| ------------------------------------ | ----------------------------- |
| the apps on the host (everyday dev)  | `--profile dev`               |
| everything, mock issuer (the above)  | `--profile dev --profile app` |
| containers + local DB, **real** Okta | `--profile db --profile app`  |
| containers only, managed DB and Okta | `--profile app`               |

Nothing in the `app` profile depends on the mock issuer, and `postgres` is a
`required: false` dependency, so the last row starts cleanly with `DATABASE_URL`
pointed at RDS or Cloud SQL. The database is a choice rather than a default on
purpose, and so is the issuer: this is why the brief's literal `docker compose
up` is not what shipped
(`doc/decision/0208-every-service-carries-a-profile-and-the-database-is-a-choice`).

## Migrations

```bash
npx prisma migrate dev --name <name>   # author one, in development
npx prisma migrate deploy              # apply pending ones — the only production verb
```

In the containerised stack `migrate deploy` is the `migrate` service and runs
by itself. **`prisma migrate reset` destroys the database**; it is not part of
any routine here — if the schema is behind, `migrate deploy` is the command.
Details and the "where storage differs from the contract" table are in
`doc/database.md`.

## Seeding

```bash
npx prisma db seed
```

A **development** fixture — 9 parking spots, 4 users, the reservation window
settings — idempotent, and never run against production.
`npx nx run web-e2e:e2e` leaves the reservation window at 31 days; re-running
the seed puts it back to 7.

## Regenerating an ICS token

A person does it themselves: **Nastavení → the calendar section → regenerate**.
It is `me.regenerateIcsToken`, it invalidates the old URL immediately (the old
one becomes a 404 like any unknown token), and it does not touch their
reservations. There is no administrative override, on purpose — the token is
the credential, and it is theirs. `doc/ics.md`.

## Backups

Single-instance deployment, no managed backups: the backup is `pg_dump`.

```bash
docker compose --env-file .env.docker exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > garage-$(date +%F).dump
```

The `sh -c '…'` is load-bearing, and the single quotes with it. `--env-file`
puts `POSTGRES_USER` and `POSTGRES_DB` inside the **container**; it does not put
them in your shell. Written without the wrapper, your shell expands them first,
they are almost certainly empty, and `pg_dump` falls back to the container's
own user: `FATAL: role "root" does not exist`, exit 1, a zero-byte file, and a
backup you do not discover is empty until you need it. `$(date +%F)` is outside
the quotes on purpose — that one _is_ yours to expand.

Restore, `--data-only` restores, and the `ReservationWindowSettings` row that
has to be deleted first are all in `doc/database.md` §Backups.

## Okta

Two things nothing in this repository can enforce, and both bite silently:

- **Point `AUTH_OKTA_ISSUER` at a Custom Authorization Server**
  (`https://<tenant>.okta.com/oauth2/default`), not the Org one. With an Org AS
  sign-in succeeds and then _every_ API call and Socket.io handshake 401s,
  because the token it mints carries no audience the API can agree on.
  `AUTH_OKTA_AUDIENCE` is that server's audience — typically `api://default`,
  and `default` for the dev mock. `doc/auth.md`.
- **Leave refresh-token rotation off.** Concurrent refreshes are coalesced
  in-process only (`doc/decision/0051-concurrent-refreshes-are-coalesced-in-process-only`),
  so with rotation on, two tabs refreshing at once can invalidate each other's
  token. Whoever provisions the Okta application has to be told; the code cannot
  detect it.

Also set `AUTH_URL` to the origin a browser reaches the web app on. Without it
a successful sign-in redirects to the address the server bound to
(`doc/decision/0202-auth-url-is-required-in-a-container-because-the-request-url-is-the-bind-address`).

## When one instance is no longer enough

The MVP targets a single instance, and there is no Redis, no BullMQ and no
broker. The seams for adding them exist and are documented; none of them is
built:

| What                       | Where the seam is                                                                                                                         | The upgrade                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socket.io across instances | `configureRealtime` in `apps/garage/api/src/realtime/realtime-io.adapter.ts`                                                              | Give the adapter `@socket.io/redis-adapter` so a broadcast from one instance reaches sockets held by another. Nothing above the adapter changes.                    |
| Cell locks                 | `LockService` (`apps/garage/api/src/realtime/`) — an interface over an in-process map with a TTL                                          | Back it with Redis `SET NX PX`. The TTL is already the contract (`REALTIME_LOCK_TTL_MS`, `doc/decision/0110-the-cell-lock-ttl-is-thirty-seconds-and-configurable`). |
| Scheduled work             | `ScheduledJobRunner` (`apps/garage/api/src/scheduling/`) — today the daily Slack summary in `apps/garage/api/src/slack/` (`doc/slack.md`) | An in-process schedule fires once per instance, so N instances post N summaries. BullMQ with a repeatable job, or a single elected leader, is the fix.              |

Until then: **run one instance.** `doc/realtime.md` and `doc/api-operations.md`
describe what each seam guarantees today.
