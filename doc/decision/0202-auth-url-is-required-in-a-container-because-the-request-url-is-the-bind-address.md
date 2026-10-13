# 0202 – `AUTH_URL` is required in a container, because the request URL is the bind address

## What

The `web` service passes `AUTH_URL` — the app's **public** origin —
and `.env.docker.example` sets it. It is not needed for host-run development,
where the bound address and the browser's address happen to be the same, and is
not in `.env.example`.

## Why

Next.js's request interceptor (`apps/garage/web/src/proxy.ts`, Node runtime) sees a
request URL built from the address the server bound, not from the Host header.
Auth.js writes that origin into the `callbackUrl` it appends when it redirects
an unauthenticated visitor to the sign-in page, and after a successful sign-in
it sends the browser there.

On a developer's machine the two addresses are the same (`next dev --port 4200`
binds `localhost:4200`, which is also what the browser typed), so the bug is
invisible. In a container they are not, and the symptom is spectacularly
misleading — measured, in this order:

```
1. bounce to /login?callbackUrl=http%3A%2F%2F0.0.0.0%3A3000%2F
2. authorize:  redirect_uri=http://garage-web:4200/api/auth/callback/okta   ← correct
3. issuer 302: → http://garage-web:4200/api/auth/callback/okta?code=…       ← correct
4. callback 302: → http://0.0.0.0:3000                                        ← wrong
5. chrome-error://chromewebdata/
```

The `redirect_uri` is right, the code exchange happens, the session cookie is
set — and then the browser is sent to an address that does not exist. Nothing
about it points at the environment variable that fixes it. With `AUTH_URL` set,
step 1 reads `callbackUrl=http%3A%2F%2Fgarage-web%3A4200%2F` and step 4 lands
on `/`.

This does mean Auth.js reads one variable out of the environment on its own,
which `apps/garage/web/src/auth.ts` otherwise deliberately prevents — it passes the
issuer, both client credentials and the secret in as arguments so that Auth.js's
implicit `AUTH_SECRET`/`AUTH_OKTA_ID`/`AUTH_OKTA_SECRET` inference cannot pick
anything up behind `webEnvSchema`'s back. `AUTH_URL` is a different kind of
value: **not a secret**, and one that no code in this repository could compute,
because only the deployment knows what address a browser reaches it on.

## How

- `docker-compose.yml`, service `web` — a bare `AUTH_URL` entry, forwarded when
  set (`doc/decision/0205-the-app-profile-names-every-variable-it-passes`).
- `.env.docker.example` — set to `http://localhost:4200`, the published host
  port, with the reason next to it.
- `libs/garage/auth` and `apps/garage/web/src/auth.ts` are unchanged. `trustHost` was already
  stated as `true` in `libs/garage/auth/src/lib/config.ts` and is not affected by this
  variable's presence.

## Risk

- **It is not in `webEnvSchema`, so a wrong value is not caught at boot.** It
  could not usefully be: the schema cannot know the deployment's public origin,
  and requiring the key would break host-run development, where it is
  meaningless. A wrong value shows up as a bad post-login redirect, on the first
  sign-in, loudly.
- **A future reverse proxy in front of the app** makes `AUTH_URL` the external
  URL, not the container's. That is the same variable doing the same job, and it
  is why it is a variable.
