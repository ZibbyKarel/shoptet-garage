# 0205 – The app profile names every variable it passes, and has its own env file

## What

The `api`, `web` and `migrate` services carry no `env_file:`. Each names the
variables it passes, in **list** form, and the values are interpolated from
`.env.docker` (git-ignored, with `.env.docker.example` committed):

```
docker compose --env-file .env.docker --profile dev --profile app up -d --build
```

Every entry is bare — the name alone, no `=` — except the three that are
properties of the container rather than of the deployment (`NODE_ENV`, `PORT`,
`LOG_LEVEL`).

## Why

- **A blanket `env_file` puts whatever happens to be in the file inside the
  container.** On a developer's machine `.env` accumulates: another project's
  token, a personal `DATABASE_URL`, an experiment. None of it belongs in a
  process that has no use for it, and a container's environment is readable by
  anything that can `docker inspect` it. The named list is the contract; the
  result is auditable in one command:

  ```
  $ docker exec …-api-1 sh -c 'env | cut -d= -f1 | sort'
  AUTH_OKTA_AUDIENCE AUTH_OKTA_ISSUER CORS_ALLOWED_ORIGINS DATABASE_URL HOME
  HOSTNAME LOG_LEVEL NODE_ENV NODE_VERSION PATH PORT PWD SHLVL YARN_VERSION
  ```

- **List form, not map, and the difference is not cosmetic.** An entry with no
  `=` is forwarded only when the variable is set and is absent otherwise;
  `KEY: ${KEY:-}` sets it to the **empty string**. Every optional key in
  `apps/garage/api/src/env.ts` has a default that an empty string does not satisfy —
  `SLACK_BOT_TOKEN` is `z.string().min(1).optional()`, so an empty value is a
  *present* value that fails the schema and crashes the boot. Verified with
  `docker compose config`: an unset bare key resolves to `null` and never
  reaches the container.
- **`${VAR:?…}` for required values was tried and had to be removed.** It reads
  well — a missing value becomes a named error before anything starts — but
  **Compose interpolates every service in the file regardless of which profiles
  are active**, so a single `:?` on `web` broke the everyday
  `docker compose --profile dev up -d`:

  ```
  $ docker compose --profile dev up --dry-run
  error while interpolating services.web.environment.[]:
    required variable AUTH_URL is missing a value
  ```

  That is the command `doc/testing.md` opens with and the one every e2e run
  depends on. Splitting the app services into a second compose file would have
  kept `:?`, at the cost of a two-`-f` command for the stack the brief asks to
  be startable in one. Bare entries keep one file and lose little: a missing
  *required* value is caught where it always was, by the app's own fail-fast
  schema at boot (`apps/garage/api/src/env.ts`,
  `apps/garage/web/src/instrumentation-node.ts`), which names the variable and exits.
  The one value not covered by a schema is `AUTH_URL` — see
  `doc/decision/0202-auth-url-is-required-in-a-container-because-the-request-url-is-the-bind-address`.
- **`.env.docker` is a second file because it describes a second topology, not
  a second application.** On the host the API is `localhost:3000` and Postgres
  `localhost:5432`; inside the network they are `garage-api:3000` and
  `postgres:5432` (`doc/decision/0201-*`). Same code, same schemas, different
  addresses. Overloading `.env` with both would make `nx serve api` and
  `docker compose` disagree about which one it meant.

## How

- `docker-compose.yml` — `environment:` lists on `api`, `web` and `migrate`.
- `.env.docker.example` — committed, obviously-fake values, no secrets.
- `.gitignore` — `.env.docker`.
- `.dockerignore` — `**/.env`, so no env file can reach a build context at all.

The Slack variables (`SLACK_ENABLED`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, …)
are listed as bare pass-throughs even though `apps/garage/api/src/slack` does not exist
on this branch's base: it lands with `feat/lets-park-mvp`, `SLACK_ENABLED`
already defaults to `false` (`doc/decision/0130-slack-is-off-by-default-and-there-is-no-dev-only-branch`
there), and an unset bare key
is not forwarded — so the list is correct both before and after that merge.
`SLACK_BOT_TOKEN` appears there and in no other file: not in
`.env.docker.example`, not in an image layer.

> **Updated after the merge (Task 34).** `apps/garage/api/src/slack` **exists** — it
> merged with `feat/lets-park-mvp`, and this record's own prediction is the part
> that has come true: the bare list needed no change to accommodate it, which
> was the claim being made. Read the paragraph above as the reasoning, not as a
> present-tense fact about the tree.
>
> One line of it is now literally false and is corrected here rather than left
> to mislead. `.env.docker.example` carries a `SLACK_*` block — `SLACK_ENABLED=false`
> and **commented, empty** placeholders for the token and the channel — so that
> the containerised stack says about a live outbound integration what
> `.env.example` already said. The property that matters is unchanged and is
> about the **value**, not the name: `SLACK_BOT_TOKEN` has no value in any
> committed file. A commented name with nothing after the `=` is documentation;
> a token is a secret. Only the second is forbidden here.
>
> Note while re-reading this: `.dockerignore` excludes `**/.env` and `**/.env.*`
> but **re-includes** `!**/.env.docker.example`, so this file does enter the
> build context and is picked up by the builder stage's `COPY . .`. It reaches
> no *shipped* layer — both Dockerfiles' final stages copy named build artifacts
> only, never the context — and it carries no value to leak in either case. The
> exclusion that protects real secrets is the unqualified `**/.env` /
> `**/.env.*` pair above it, and it is untouched.

## Risk

- **A new variable has to be added here by hand**, and forgetting it means the
  container runs on a default. That is the cost of the list, and it is paid
  once per variable; the alternative pays it every time someone's `.env` grows
  something private.
- **Two example files to keep in step** (`.env.example`, `.env.docker.example`).
  They are deliberately not generated from each other: the values differ on
  purpose, and a generator would hide exactly the differences that matter.
