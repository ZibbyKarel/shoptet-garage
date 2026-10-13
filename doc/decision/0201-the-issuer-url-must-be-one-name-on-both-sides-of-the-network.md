# 0201 – The issuer URL must be one name on both sides of the network

## What

In the containerised stack the OIDC issuer is reached as
`http://garage-oidc:8080/default` and the API as `http://garage-api:3000/api`
— network aliases on the compose network — and the operator adds one line to
the host's `/etc/hosts`:

```
127.0.0.1 garage-api garage-oidc
```

Nothing in the `app` profile depends on the mock issuer's container. It carries
the `dev` profile, and the API discovers JWKS lazily from whatever
`AUTH_OKTA_ISSUER` names.

## Why

- **`mock-oauth2-server` derives every URL it publishes from the Host header of
  the request it is answering** — the authorization endpoint the browser is
  redirected to, the JWKS URI the API reads, and the `iss` claim it mints.
  Measured:

  ```
  $ curl -s http://localhost:8080/default/.well-known/openid-configuration | head -2
    "issuer" : "http://localhost:8080/default",
  $ docker run --rm --network …_default curlimages/curl -s \
      -H "Host: localhost:8080" http://mock-oauth2-server:8080/default/.well-known/openid-configuration
    "issuer" : "http://localhost:8080/default",
  ```

  So reaching it as `localhost:8080` from the browser and as
  `mock-oauth2-server:8080` from the containers produces **two different
  issuers**. Sign-in succeeds and then every API call 401s on a mismatched
  `iss` — a failure that looks like a broken token, not like a DNS choice.
- **The same applies to `NEXT_PUBLIC_API_URL`**, for a less obvious reason: it
  is read by server code (`app/layout.tsx`, `settings/page.tsx`) *and* fetched
  server-side by `app/api/health/route.ts`, and then handed to the browser as a
  prop. One variable, both sides, so one name.
- **`localhost` cannot be that name.** Docker writes `127.0.0.1 localhost` into
  every container's `/etc/hosts` before any `extra_hosts` entry, and the first
  match wins — verified: `--add-host localhost:host-gateway` leaves
  `getent hosts localhost` answering `::1`. `host.docker.internal` fails from
  the other direction: it does not resolve on the macOS host.
- **A shared network namespace (`network_mode: "service:…"`) would remove the
  /etc/hosts line** and was rejected: it makes the app services depend on the
  container that owns the namespace. If that is the mock issuer, the
  *production* path depends on the dev mock, which is exactly what
  `doc/decision/0008-*` forbids.
- **With a real Okta tenant none of this exists.** The issuer is already a
  public name that means the same thing everywhere; the aliases and the hosts
  line are the price of running a fake public IdP on a private network.

## How

- `docker-compose.yml` — `networks.default.aliases` on `mock-oauth2-server`
  (`garage-oidc`) and on `api` (`garage-api`); the mock carries
  `profiles: ['dev']` and appears in no `depends_on`.
- `.env.docker.example` — the URLs, and the /etc/hosts line, at the top.
- `README.md` — the same line in the first-run steps.

The whole flow was then driven by a real Chromium with
`--host-resolver-rules=MAP garage-oidc:8080 …` standing in for the hosts
entry: bounce to `/login`, a real `/authorize` with PKCE and `state`, the
issuer's form, the callback, and `200 POST /api/rpc/me/get` and
`/api/rpc/overview/day` against the API container.

## Risk

- **A host file is a manual step**, and a forgotten one produces a sign-in that
  reaches an unreachable host. It is one line, it is in the first-run steps, and
  it disappears with a real issuer.
- **The alias names are now load-bearing.** Renaming a service is free;
  renaming an alias means editing `.env.docker` and every operator's
  `/etc/hosts`.
