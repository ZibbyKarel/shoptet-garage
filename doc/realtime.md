# Realtime

How the browser holds a Socket.io connection to the API, what it may say over
it, and what it does with what comes back.

**Scope of this document.** Task 21 built the **client** half
(`libs/garage/realtime-client`) and Task 15 built the **gateway**
(`apps/garage/api/src/realtime`). Both halves are described here: the client sections
come first because they are what a feature author touches, and §"The gateway"
below is the server side of every claim they make.

The vocabulary — event names, payload shapes, room naming, which direction an
event travels — is not defined here. It is defined once, as Zod schemas, in
`@garage/contract/realtime`, and `doc/contract.md` §Realtime describes it.
Nothing in this document introduces an event; if you need a new one, add it to
the contract first (`doc/contract.md`, "Adding a realtime event").

---

## The shape of it

```
apps/garage/web ── @garage/realtime-client ── socket.io-client ~~~ socket.io ── apps/garage/api/src/realtime
                      │                                                              │
                      └──────────── @garage/contract/realtime ────────────────────┘
                                    (event names, payload schemas, roomForDate)
```

One socket per browser tab, created by `useRealtimeConnection` inside
`RealtimeProvider`, which `apps/garage/web` renders once in its provider boundary
alongside `QueryProvider`, `AuthProvider` and `IntlProvider` (Task 23 wires this
up for real).

```tsx
"use client";

export function Providers({ children }: { children: ReactNode }) {
  const getAccessToken = useAccessTokenProvider(); // @garage/auth/client
  const { status } = useSession();

  return (
    <RealtimeProvider
      url={apiOriginOf(process.env.NEXT_PUBLIC_API_URL)} // the ORIGIN, not the base URL
      getAccessToken={getAccessToken}
      enabled={status === "authenticated"}
      onInvalidPayload={(report) => logger.warn(report, "realtime payload rejected")}
    >
      {children}
    </RealtimeProvider>
  );
}
```

`url` is the API's **origin**, never `NEXT_PUBLIC_API_URL` itself. `io(url)`
reads a path in the URL as a **namespace**, not as a mount point, so
`http://localhost:3000/api` dials the `/api` namespace — which the gateway does
not register, and the refusal looks like an auth failure. The Socket.io mount
point is the separate `path` option (`DEFAULT_SOCKET_PATH`). `apiOriginOf` lives
in `apps/garage/web/src/api-url.ts` alongside the other two derivations; see
`doc/decision/0101-*`.

`enabled` holds the connection closed until there is a session: connecting
before one exists just spends a handshake the gateway is going to refuse.

No feature file imports `socket.io-client`. That is enforced, not requested —
see `doc/wrappers.md`.

---

## The handshake token

The access token travels in **`socket.handshake.auth.token`**, and nowhere else.
Not the query string, not `extraHeaders`.

```ts
io(url, {
  path,
  auth: (cb) => {
    void Promise.resolve(getAccessToken()).then(
      (token) => cb(toHandshakeAuth(token)),
      () => cb({})
    );
  },
});
```

Three properties follow from `auth` being a **function** rather than an object,
and all three are load-bearing:

| property                                     | why                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| re-read on **every** engine open             | Socket.io calls `auth` from `Socket.onopen`, which is bound to the manager's `open` event for the socket's whole life. An object is read once, at construction, so a socket that outlives a token rotation would spend the rest of its life re-presenting an expired credential. |
| the CONNECT packet waits for the callback    | `libs/garage/auth`'s provider is async while a refresh is in flight. Nothing is sent until it settles.                                                                                                                                                                           |
| no session, or a failed provider, sends `{}` | An empty handshake is refused by the gateway. Swallowing a refresh failure into a _successful_ anonymous connect would be a silent downgrade.                                                                                                                                    |

A query string is written verbatim into nginx's `$request_uri`, load-balancer
access logs, CDN logs and `engine.io`'s debug output, none of which redact — it
would turn a credential with a lifetime of minutes into one with the retention
period of a log bucket. `extraHeaders` would not have worked either: the browser
`WebSocket` API cannot set request headers, so Socket.io applies them to the
polling transport only, and a socket that upgraded would silently stop
presenting its credential. Full reasoning, and the tests: `doc/decision/0060-*`.

Nothing about the token is logged — not by this lib, and not on the failure
paths. `connect_error` deliberately carries nothing onward: for an auth failure
it is the gateway's rejection of the token that just travelled.

### Reconnecting

**A connection can fail in two ways, and they are not the same failure.**
`connect_error` fires for both, so the handler branches on `socket.active` —
the library's own `!!socket.subs`, which is the exact field it clears when it
gives up on a socket.

|                                        | `socket.active` | status       | who retries                        |
| -------------------------------------- | --------------- | ------------ | ---------------------------------- |
| the transport could not be established | `true`          | `connecting` | Socket.io's own loop               |
| the gateway **refused the handshake**  | `false`         | `rejected`   | this lib, by building a new socket |

For a **transport** failure, Socket.io's reconnection settings are left at their
defaults — unlimited attempts, 1 s growing to 5 s, 0.5 jitter
(`doc/decision/0063-*`). They are exponential backoff with jitter already;
restating them would be a second place to keep in sync. The part this project
has an opinion about is _what a reconnect re-sends_, which is the `auth`
callback above.

A **refused handshake** is different, and it is the one this lib has to handle
itself. Socket.io sends a CONNECT_ERROR packet and `Socket.onpacket` calls
`destroy()` **before** emitting `connect_error`: the socket loses its manager
subscriptions and will never present a token again. Nothing retries it, so
reporting `connecting` would pin the UI on a connection that is not coming —
the grid silently stops updating, `useCellLock` never leaves `requesting`, and
only a page reload fixes it.

So a refusal is terminal for _that socket_, and the recovery is a **new** one,
which re-runs the `auth` callback and therefore presents whatever token the
provider has now — a stale token after a backgrounded tab is exactly the case
this covers. Three automatic attempts, at 1 s / 5 s / 30 s
(`REJECTED_RETRY_DELAYS_MS`), the counter resetting on any successful connect.
After that the status stays `rejected` until somebody asks again:

```tsx
const { status, reconnect } = useRealtime();
// status === 'rejected' → offer the user a control that calls reconnect()
```

The cap is deliberate where the transport's is not. A refusal is the gateway
_answering_, and re-presenting a credential it has just rejected — a revoked
account, a session signed out elsewhere — is a request that cannot succeed.
`doc/decision/0061-*` has the full reasoning.

`RealtimeStatus` is therefore `connecting | connected | disconnected |
rejected`. `connecting` still covers both the first attempt and every transport
retry: a UI distinguishing "still connecting" from "retrying after a dropped
transport" would be showing the user a difference they cannot act on. `rejected`
is the one they can.

---

## Rooms: one per day

```tsx
useDayRoom(date); // or useDayRoom(null) while there is no day to watch
```

Emits `day:subscribe` once the connection is up, and `day:unsubscribe` when the
day changes or the component goes away. **Rejoining after a reconnect is not
extra logic** — the effect depends on `status`, so a new connection re-runs it.
That matters: a dropped socket loses its server-side room membership, and a
client that did not re-subscribe would go quietly deaf.

The subscribe is gated on `connected` rather than emitted eagerly. Socket.io
would happily buffer an emit made while disconnected and flush it on the next
connection, which looks identical until the buffer was cleared by the
disconnect — at which point the client is deaf and nothing said so. For the same
reason, `day:unsubscribe` is only sent while the socket is still up: once it is
down the room is gone anyway, and a buffered unsubscribe delivered on the _next_
connection means something else entirely.

---

## Everything inbound is parsed

`ServerToClientEvents` is a compile-time map. At runtime, `socket.on('cell:locked',
handler)` hands `handler` whatever bytes arrived, cast. A server one deploy
ahead, a mangled frame, or simply a bug produces a value TypeScript swears is a
`CellLockedEvent` and is not.

So `useRealtimeEvent` parses first:

```tsx
useRealtimeEvent("reservation:created", (payload) => {
  // payload has been through reservationCreatedEventSchema
});
```

- The schema comes from `SERVER_TO_CLIENT_EVENT_SCHEMAS` **by lookup**, not from
  a `switch`. An event added to the contract is validated here the moment it is
  added; there is no second list to forget.
- A payload that fails is **dropped, not thrown** — one malformed broadcast must
  not take down a page that is otherwise working — and reported through
  `onInvalidPayload`.
- The handler receives the **parsed** value, so keys the contract does not
  declare are gone rather than forwarded.
- `InvalidRealtimePayload` is `{ event, issues }` where `issues` is Zod's
  path/message list and nothing else. Deliberately not the payload: these
  payloads name users, and a report that is safe to hand straight to a logger is
  worth more than a verbose one that is not.

This is the mirror of the rule the gateway implements in the other direction —
Task 15 validates every inbound command against
`CLIENT_TO_SERVER_EVENT_SCHEMAS` and drops what fails
(`libs/garage/contract/src/realtime/commands.ts`).

Acknowledgements are inbound data too, and are parsed the same way
(`parseAck`). An unparsed `cell:lock` ack is a `setTimeout(NaN)` waiting to
happen.

---

## The cell lock

A **hold, not a reservation.** Acquiring it books nothing; the reservation is
still created over the API, which re-checks everything. A client that skips the
lock gets a `CONFLICT` from `reservation.create` instead of a nicer message. What
the hold buys is the "právě upravuje …" state on everybody else's tile while one
user has a form open.

```tsx
const { status, expiresAt, lockedBy } = useCellLock({
  date,
  parkingSpotId,
  enabled: isFormOpen,
});
```

| `status`        | meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `idle`          | not asked for — disabled, or no connection                                                             |
| `requesting`    | asked, no answer yet                                                                                   |
| `held`          | this client holds it and is renewing it                                                                |
| `held-by-other` | somebody else has it; `lockedBy` says who, `expiresAt` says until when. **Not terminal** — see 4 below |

Four things have to be true for the "právě upravuje" state not to get stuck,
and the hook makes all four automatic by putting the whole lifecycle in **one
effect** — so every way of leaving a cell is the same cleanup and every way of
arriving at one is the same setup.

### 1. The hold is renewed

There is **no separate heartbeat command.** Re-sending `cell:lock` for a cell
you already hold extends its TTL (`libs/garage/contract/src/realtime/commands.ts`) —
one command fewer on the inbound surface, and an idempotent one, so a client
that loses track of its own state cannot corrupt the server's.

The renewal is scheduled from the server's `expiresAt`, at
`CELL_LOCK_RENEW_FRACTION` (0.5) of the remaining time, floored at
`MIN_CELL_LOCK_RENEW_DELAY_MS` (1 s):

- **from `expiresAt`, not from a TTL constant copied onto the client** — the
  client is then correct for whatever TTL the gateway is configured with, and
  there is no second number for two tasks to keep in sync;
- **half**, so a renewal lost in flight still leaves a second attempt inside the
  same TTL — see below for what makes that second attempt exist;
- **the floor** turns clock skew or an already-past `expiresAt` into one request
  per second instead of a busy loop. `Date.parse('soon')` is `NaN`, and
  `setTimeout(NaN)` fires immediately, forever.

Renewing does not drop the component out of `held` and back to `requesting`:
the hold was never lost.

**The renewal is sent with an acknowledgement timeout, and that is load-bearing.**
`socket.emit(event, payload, cb)` has no timeout in Socket.io: a callback whose
ack never arrives is simply never called. Since the next renewal is scheduled
from _inside_ that callback, one dropped ack would end the heartbeat for good —
silently, with the form still showing `held` while the server's TTL lapsed and
somebody else took the cell. So `cell:lock` goes out through
`socket.timeout(CELL_LOCK_ACK_TIMEOUT_MS)`, which calls the callback with an
error instead of never calling it:

- one retry (`CELL_LOCK_ACK_ATTEMPTS` = 2 sends), which is the "second attempt
  inside the same TTL" the half-fraction leaves room for — 5 s + 5 s resolves by
  ~25 s of a 30 s TTL;
- a second loss drops the hook to **`idle`**, not a frozen `held`. A UI
  asserting a hold the server has stopped confirming is the defect, not the
  mitigation;
- any acknowledgement resets the budget.

`doc/decision/0062-*`.

### 2. The hold is given back

`cell:unlock` on unmount, on `enabled` going false, and on the cell changing.
All three are the same effect cleanup, so there is no path that closes a form
without releasing.

**One measured exception, which is React's rather than the hook's.** When the
_whole provider tree_ is deleted at once, React runs a deletion's cleanups
parent-first, so `useRealtimeConnection` has already disconnected the socket by
the time `useCellLock`'s cleanup runs, and there is nothing left to say
`cell:unlock` on. That is not a leak: a dropped socket is exactly how the
gateway learns to free a hold, and it is the same path a closed tab takes. It
does mean the emit is _guaranteed_ for the case that matters — a form closing on
a live page — and _redundant_ for the case it is not.

A hold this client never acquired is never released: a `HELD_BY_OTHER` answer
leaves nothing to give back, and emitting `cell:unlock` for it would ask the
server to drop somebody else's lock.

**One case is not fully closed, and it is a product question rather than a bug:**
when the same person has the same bay open in **two tabs**, closing the second
tab's dialog still drops the hold the first tab is showing. What that costs, how
long it lasts (~15 s) and why closing it means changing how a hold is _acquired_
are in ["Known residual: one user, two tabs, one bay"](#known-residual-one-user-two-tabs-one-bay)
under The gateway.

### 3. The hold is re-taken after a reconnect

A dropped socket drops the server's lock with it, so the hook re-requests on the
new connection rather than believing the state it had. No `cell:unlock` is sent
across the gap — the socket was already gone.

### 4. A cell somebody else holds becomes askable again

`held-by-other` is the one status a form can sit in indefinitely, and it is the
one the hook cannot resolve on its own: the cell becomes free because of
something that happens on _another_ client. Two independent things end it, and
the hook is wired to both:

- **the gateway's `cell:unlocked` broadcast** for this cell, which arrives on all
  four ways a hold can end (`doc/decision/0111-*`) — the ordinary case, and the
  fast one;
- **the ack's own `expiresAt` passing** with no broadcast having arrived.

Either alone would do. Both are here because `doc/decision/0111-*` says in as
many words that neither side should assume the other did it: the server's
expiry broadcast is not redundancy for a client that only believes broadcasts,
and a client timer is not redundancy for a server that never fires one.

Asking again clears `lockedBy` and `expiresAt` back to `requesting` rather than
keeping the previous holder on screen: whoever answers next may be somebody
else, or nobody.

### What the hook deliberately does not do

**It does not poll a contended cell.** Nothing is sent while the other client's
hold is still valid — the retry timer waits the **whole** remaining TTL, not
half of it (`contendedRetryDelayMs`, against `renewDelayMs`'s half), and the
broadcast handler fires once per broadcast, only for this cell, and only out of
`held-by-other`. Polling from every open tab is exactly the traffic the
broadcast exists to avoid.

**It does not react to a broadcast about a cell it holds itself.** A gateway may
echo a room broadcast to its own sender, and a supersession elsewhere can
produce one; tearing down a live hold on that would turn somebody else's event
into this form's problem.

---

## What is tested, and what is not

Tests live beside the code: `socket.spec.ts`, `connection.spec.tsx`,
`cell-lock.spec.tsx`, `validation.spec.ts` (78 tests, measured
`npx nx run realtime-client:test`).

The socket in those tests is a **real** `socket.io-client` socket. Only the
transport is replaced — `manager.open()` becomes a no-op and `manager._packet()`
captures what would have gone on the wire — while `Socket.onopen`,
`Socket.onpacket`, `Socket.onclose`, `emit`'s buffering and the acknowledgement
registry are the library's own code, driven through the manager's real
`open` / `close` / `packet` events. A reconnect in those tests is the same event
the reconnect timer fires in production. Even socket.io-parser's numeric packet
type codes are _discovered_ from the installed client rather than written down —
including CONNECT_ERROR, which the client never sends and which is therefore
identified by the pair of effects only it has (it emits `connect_error` **and**
leaves the socket inactive).

`src/__fixtures__/offline-transport.ts` explains why in more detail. The short
version: a double may stand in for a dependency's behaviour, never for the shape
of its protocol.

**Not verified in `libs/garage/realtime-client`, and where it is now:**

| claim                                                                             | settled by                                                                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| the gateway reads the token from `handshake.auth.token`                           | ✅ `realtime-handshake.spec.ts`                                                                                                                       |
| a real refused handshake arrives as CONNECT_ERROR and not as a plain disconnect   | ✅ `realtime-handshake.spec.ts`                                                                                                                       |
| the server's lock TTL and this client's renewal actually interleave               | ✅ `doc/decision/0110-*` (arithmetic) + `lock.service.spec.ts`; a real round trip is still Fáze 7                                                     |
| broadcasts arrive only in the day room a client joined                            | ✅ `realtime.gateway.spec.ts`                                                                                                                         |
| a lapsed hold is broadcast, so `held-by-other` cannot stick                       | ✅ `doc/decision/0111-*` — and, independently of the broadcast, `cell-lock.spec.tsx` "asks again when the other hold lapses and no broadcast arrives" |
| three attempts over ~36 s is long enough for `libs/garage/auth` to rotate a token | Fáze 7 e2e                                                                                                                                            |
| a real reconnect against a real server re-authenticates                           | Fáze 7 e2e                                                                                                                                            |

---

## The gateway

`apps/garage/api/src/realtime` — a NestJS `@WebSocketGateway` over Socket.io v4.

| file                     | what it owns                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `realtime.gateway.ts`    | the four commands, the day rooms, the broadcast path — and installing the handshake as middleware                                |
| `realtime-handshake.ts`  | who may connect: the credential, the verification, the rejection taxonomy, and the `UserSummary` an authenticated socket carries |
| `lock.service.ts`        | the editing holds, their TTL and their expiry                                                                                    |
| `realtime-io.adapter.ts` | how the Socket.io server is constructed; the cluster seam                                                                        |
| `realtime.publisher.ts`  | the after-commit `DomainEventPublisher`                                                                                          |

### The handshake

`server.use(...)` — namespace middleware, and it has to be: a middleware that
calls `next(err)` makes socket.io send a **CONNECT_ERROR**, which is the packet
`libs/garage/realtime-client` branches on. Accepting the connection and then
disconnecting would look identical from the gateway and completely different in
a browser. Full reasoning, the source seams it was read from, and what a refusal
says to the client and to the log: `doc/decision/0112-*`.

The token is verified by **`JwksVerifierService.verifyToken`** — the same single
`JwksClient` and the same `JwtVerificationRules` the HTTP guard reaches through
`passport-jwt` (`doc/decision/0042-*`) — and resolved to a user by the same
`AuthUserService`, so a socket goes through the same just-in-time provisioning
and the same deactivated-user refusal an HTTP request does. There is no
`NODE_ENV` branch anywhere under `apps/garage/api/src/realtime`;
`realtime-no-backdoor.spec.ts` asserts it.

The `UserSummary` a broadcast carries is resolved **once**, during the
handshake, and kept on `socket.data`. A licence plate changes about as often as
somebody buys a car; re-reading it on every renewal would be a query per
heartbeat.

### Every inbound payload is validated

`CLIENT_TO_SERVER_EVENT_SCHEMAS` is the gateway's validation table. Every
handler reaches it through one `accept()` call — there is no second path from a
socket frame to a handler body — and the schema is fetched **by lookup**, not by
a `switch`, so a command added to the contract is validated the moment it is
added. `realtime.gateway.spec.ts` walks the registry and asserts a
`@SubscribeMessage` handler exists for every key, because the one thing a lookup
cannot catch is a command with no handler at all.

A payload that fails is **dropped**: no state changes, and no acknowledgement is
sent. That last part is deliberate. `cellLockAckSchema` has no error variant, so
there is nothing honest to answer with — and Nest's adapter only calls a
client's ack callback for a non-nullish return
(`@nestjs/platform-socket.io/adapters/io-adapter.js`), so returning nothing
_is_ the silence. On the client that resolves through
`socket.timeout(CELL_LOCK_ACK_TIMEOUT_MS)` as a lost ack — one retry, then
`idle` — rather than a form stuck at `requesting` forever.

The failure is logged at `debug` with Zod's path/message list and **not** the
payload: these payloads name users and dates, and they are attacker-controlled
input on its way into a log.

### Everything outbound is validated too

Both a broadcast and the `cell:lock` acknowledgement are `safeParse`d against
the contract's own schema before they leave, in every environment. It costs a
parse of a five-key object, and Zod strips what the schema does not declare — so
`lockedBy` leaves the server as `userSummarySchema`'s three-field pick and
nothing else, whatever shape the object behind it had.

That is not theoretical. The acknowledgement path originally lacked this gate,
and a spec caught it carrying the whole user row — `email`, `oktaId` and
`icsToken`, the secret in a personal calendar-feed URL — to _another user's_
browser. The broadcast on the same path was already safe, which is what made the
asymmetry visible.

A payload the contract refuses is dropped and logged at `error`. It is never
thrown: broadcasting runs on the request's way out, after `COMMIT`, and a
failure to broadcast must not turn a successful cancellation into an error the
user sees.

### Rooms

`day:subscribe` / `day:unsubscribe` join and leave `roomForDate(date)`, and a
socket may be in at most `MAX_DAY_ROOMS_PER_SOCKET` (64) of them. The cap exists
because `dateOnlySchema` accepts any calendar-valid date and the websocket path
has no `ThrottlerGuard` in front of it, so without one an authenticated socket
could ask to join millions of rooms.

An event about a **hidden** spot (`SpotsService.isHidden`) goes only to the
admin sockets in the day room — `emitToAdminsIn` walks the room and checks
`socket.data.role`, which the handshake now writes next to `user`. That walk
is local to the process; see "Single instance, and what changes when that
stops being true". `doc/decision/0316-hidden-spots-are-seen-and-booked-by-admins-only`.

### The editing hold

`LockService` is an abstract class with one in-memory implementation. Ownership
is by **user**, with the socket id carried alongside it — not by socket. That is
what makes a reconnect a renewal rather than a `HELD_BY_OTHER` against yourself,
and it is what makes the _late_ disconnect of a dead socket free nothing when
its user has already re-taken the hold on a new one.

**Giving a hold back is keyed by both**, though: `release` frees the cell only
for the `(user, socketId)` pair currently recorded, exactly as `releaseSocket`
matches. A user really can have two live connections on one cell — a second tab,
or a page that reloaded before this server noticed the old socket — and a
release keyed by user alone let either of them drop the other's hold, which
shows up as a bay reading `Volné` to everybody while a form is still open.
`doc/decision/0220-*`.

#### Known residual: one user, two tabs, one bay

**This is a product decision waiting to be made, not an oversight.** Ownership
is by user, so if the same person opens the same bay in two tabs, _both_ forms
show `held` and their renewal heartbeats hand the recorded socket back and forth.
Keying the release by connection fixed half of what that costs and could not fix
the other half:

| what happens                         | before                                   | now                           |
| ------------------------------------ | ---------------------------------------- | ----------------------------- |
| the **first** tab closes its dialog  | drops the hold the second tab is showing | nothing happens — refused     |
| the **second** tab closes its dialog | drops the hold the first tab is showing  | **unchanged: still drops it** |

In the remaining case the first tab's form stays open over a bay that reads
`Volné` to everyone else, and somebody else can take the editing hold, until
that tab's next heartbeat re-takes it — at most half a TTL, so **~15 s** at the
shipped `REALTIME_LOCK_TTL_MS` of 30 s. Nothing can be double-booked by it: a
cell lock books nothing, and `reservation.create` re-checks everything against
the unique indexes.

Closing it means changing how a hold is **acquired** — for example, letting one
user hold a cell on only one connection at a time. That would also change what a
_reconnect_ means, since a reconnect is a renewal by exactly the same rule, so it
is a decision about the product ("what should a second tab of mine see?") rather
than a bug fix. It is deliberately left open. Exercised over real sockets by
`realtime.gateway.spec.ts`, "still lets the newest connection of a user drop a
hold their older tab is showing".

- **TTL** — `REALTIME_LOCK_TTL_MS`, 30 s. The client's renewal budget fits
  inside it with 5 s to spare; the arithmetic is `doc/decision/0110-*`.
- **Renewal** — there is no heartbeat command. A second `cell:lock` from the
  current holder extends the hold, which is the contract's design.
- **Expiry** — one timer per hold, rescheduled on renewal, cleared on release.
  When it fires, `cell:unlocked` is broadcast. This is the mechanism, not
  bookkeeping: it is what clears "právě upravuje …" from every other tile
  (`apps/garage/web`'s `useCellLocks` prunes on it, and `useCellLock` asks again on
  it). `useCellLock` also carries its own `expiresAt` timer as a backstop, so
  the two are independent — `doc/decision/0111-*` asked for exactly that, and
  `doc/decision/0295-*` is where it was built.
- **A dropped socket** frees its holds and broadcasts each one, which is why
  `useCellLock` sends no `cell:unlock` across a connection gap.
- **`cell:locked` excludes the asker.** It already knows — that is what the
  acknowledgement is — and a client that heard its own hold as a broadcast would
  render "somebody else is editing" over its own open form. A _second tab_ of
  the same user is a different socket and does hear it, which is correct.

### Broadcasting after commit

`RealtimeDomainEventPublisher` implements the seam Task 13 left
(`reservations/reservation-events.ts`) — one of two implementations, reached
through `CompositeDomainEventPublisher`, which also forwards to Task 16's Slack
publisher and keeps the two out of a shared `try` (`doc/decision/0135-*`).
**When** an event is published is not up to it: `ReservationsService.cancel` computes events inside the transaction,
returns them, and publishes past the `await` — outside the retry loop, so a
cancellation that lost two races publishes once, not three times.
`reservations.db.spec.ts` §"the after-commit seam" proves the ordering by having
the publisher read the database on a **second connection**.

`publish` swallows and logs, per that file's stated requirement: a user whose
reservation _is_ cancelled, told it failed because a socket write threw, would
cancel it again — against a row that no longer exists. The loop is per event, so
one failing does not silently take the other with it.

`notifyPromotions` is still a no-op; the Slack half is Task 16. When it lands,
two things will want this one token, and the shape that keeps them honest is a
publisher that fans out to a list of implementations rather than a Slack call
bolted onto this class — a realtime broadcast and an outbound HTTP call have
different failure modes and must not share a `try`.

### Shutdown

The gateway registers `GracefulShutdownService.registerCloser('socket.io', …)`.
Socket.io does not close itself: a live WebSocket is not an "in-flight request",
so Nest's HTTP shutdown never touches it and the process would hang until the
orchestrator's kill timeout. `LockService.onModuleDestroy` clears every pending
expiry timer in the same window, so none fires into a closing server.

### How the gateway is tested

Over **real WebSockets**, against the assembled `AppModule`, with a real
in-process OIDC issuer signing real RS256 tokens. The client peer is not
`socket.io-client` — that is a wrapped library owned by `libs/garage/realtime-client`,
and the ban covers `apps/**` including specs. It is built instead on the
protocol's own reference implementation: `engine.io-parser` for the transport
frames and `socket.io-parser`'s `Encoder`/`Decoder`/`PacketType` for the
protocol, both direct dependencies of the `socket.io` server under test. So
CONNECT_ERROR is identified by the parser's own constant rather than by a number
a fixture believes in — the standard `libs/garage/realtime-client`'s
`offline-transport.ts` set for the other direction.

---

## Single instance, and what changes when that stops being true

The MVP targets one API instance, so Socket.io needs no adapter and no Redis
(global constraint 8). **Nothing in `libs/garage/realtime-client` changes when that
stops being true** — rooms, event names and payloads are the contract's, and the
client already assumes it may be talking to a server that has been redeployed
under it, which is why every inbound payload is parsed.

Two things on the server do, and both already have a named place to land.

**Broadcasting** breaks first: each process would only reach the sockets
connected to _it_, so half the browsers watching a day would never hear that a
spot was taken. The fix is a Socket.io adapter, inside
`RealtimeIoAdapter.installClusterAdapter` — a no-op today, named rather than
left as a comment so the change has one call site:

```ts
// npm i @socket.io/redis-adapter redis
const pub = createClient({ url: REDIS_URL });
const sub = pub.duplicate();
await Promise.all([pub.connect(), sub.connect()]);
server.adapter(createAdapter(pub, sub));
```

**The editing hold** breaks in a quieter way: two users on two instances would
both be granted the same cell, because each process's `Map` is a different
truth. `LockService` is an abstract class for this reason, and every method
already has its Redis equivalent — the table is in its own doc comment:

| `LockService`       | Redis                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `acquire` (new)     | `SET cell <holder> NX PX <ttl>`                                               |
| `acquire` (renewal) | the same `SET` with `XX`, guarded by a Lua compare on the holder              |
| `release`           | Lua: `GET` the cell, `DEL` only if the holder **and its socket** match        |
| `releaseSocket`     | a `SET` of cell keys per socket id, walked on disconnect                      |
| `onExpired`         | keyspace notifications (`Ex`) on the lock key prefix, **paired with a sweep** |

`SET NX PX` is what makes the compare-and-set atomic across instances, and the
Lua guard on release is what stops one instance dropping another's hold after a
TTL lapse and a re-acquisition in between. Neither is needed here: a single Node
process runs those methods to completion without interleaving, so the in-memory
implementation is not "the Redis one without the network" — it is a genuinely
simpler thing.

The expiry listener is the part that needs the most care under Redis, because
keyspace notifications are best-effort and `doc/decision/0111-*` explains why a
missed expiry is user-visible.

**Neither is implemented, deliberately.** An unused implementation is an
untested one, and the two would have to land together to be worth anything.

---

## Related

- `doc/contract.md` §Realtime — the events themselves, and how to add one
- `doc/wrappers.md` §`libs/garage/realtime-client` — the wrapper ban and its probes
- `doc/decision/0022-*` — event naming, one transaction → one event
- `doc/decision/0023-*` — realtime is a separate entry point; the maps are derived
- `doc/decision/0047-*` — the access token crosses to the browser; the refresh token does not
- `doc/decision/0060-*` — the websocket token is a handshake callback, not a query string
- `doc/decision/0061-*` — a refused handshake is a terminal status, recovered by a new socket
- `doc/decision/0062-*` — the cell-lock heartbeat uses Socket.io's ack timeout
- `doc/decision/0063-*` — transport reconnection stays unlimited; only refusals have a ceiling
- `doc/decision/0110-*` — the cell-lock TTL is 30 s, configurable, and the client's budget fits inside it
- `doc/decision/0111-*` — a lapsed hold is broadcast, because the client deliberately does not poll
- `doc/decision/0112-*` — the handshake is namespace middleware, so a refusal is a CONNECT_ERROR
- `doc/decision/0314-*` — `timed-reservations:updated` replaces the whole list on a cell rather than diffing it, and why that self-heals against out-of-order broadcasts
- `doc/api-modules.md` — where `apps/garage/api/src/realtime` sits among the API's modules
