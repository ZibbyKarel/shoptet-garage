# `doc/`

Everything written about this project that is not `plan.md`. Two kinds of
document, and the difference matters when you are deciding where to write
something new:

- **Topic documents** (`doc/*.md`) describe **how a part of the system works
  right now**. They are rewritten as the system changes; they carry no history.
- **Decision records** (`doc/decision/*.md`) describe **one choice, once** —
  what was decided, why, how it is implemented, and what it costs. They are
  append-only: a superseded record is not deleted, it is superseded by a new
  one that says so.

`plan.md` (Czech, git-ignored) is the binding specification and outranks
everything here. `doc/implementation-plan.md` is its breakdown into tasks.

This index is generated from the filesystem and accounts for every file under
`doc/`: 22 topic documents, 201 decision records, and `doc/design/`.

---

## Topic documents

| Document                                                 | What it is for                                                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`admin.md`](admin.md)                                   | The `/admin` section: the five admin tabs — day lot, users, spots, reservation window, reservation limits — and what each one may change.                                                                                                     |
| [`api-modules.md`](api-modules.md)                       | How `apps/garage/api` serves the contract: the oRPC transport, the domain modules behind it, and the rule each module owns.                                                                                                                   |
| [`api-operations.md`](api-operations.md)                 | The API's operational baseline: startup, structured logging, the `/health/*` probes, graceful shutdown, throttling and input limits.                                                                                                          |
| [`auth.md`](auth.md)                                     | How a person becomes an identified caller — Okta sign-in in `apps/garage/web`, JWKS validation in `apps/garage/api`, JIT provisioning, refresh, and what is public.                                                                           |
| [`bulk-reservation.md`](bulk-reservation.md)             | The bulk allocator: `reservation.previewBulk` / `confirmBulk`, how a month's days are assigned, and the transaction that confirms them.                                                                                                       |
| [`bulk-reservation-modal.md`](bulk-reservation-modal.md) | The front end of that allocator — the `Hromadná rezervace` modal in `apps/garage/web/src/lot/`.                                                                                                                                               |
| [`contract.md`](contract.md)                             | `libs/garage/contract`, the single source of truth for every FE↔BE shape, and how to add a schema, a procedure or an error to it.                                                                                                            |
| [`database.md`](database.md)                             | The PostgreSQL schema, Prisma 7 setup, migrations, the development seed, and backups.                                                                                                                                                         |
| [`design-system.md`](design-system.md)                   | All three layers of the one `design-system` package: what a token is, how the CSS is generated, and what a primitive and a compound may and may not know.                                                                                     |
| [`environment.md`](environment.md)                       | Every environment variable the two apps need, how the local Docker stack is started, and how dev, e2e and production differ (values only, never code).                                                                                        |
| [`frontend.md`](frontend.md)                             | `apps/garage/web`: the route tree, the single client boundary, provider order, the sign-in flow, the screen states and the `ScreenData<T>` union that selects one, and the `*-view.ts` split between what a screen decides and what it draws. |
| [`i18n.md`](i18n.md)                                     | `libs/shared/i18n` — the only place allowed to import `next-intl` — the two message catalogs in `apps/garage/web/messages`, how a request's locale is chosen, and the English glossary.                                                       |
| [`open-items.md`](open-items.md)                         | Everything the build deliberately left undone: deferred minors, parked findings, and the two gaps where an enforcement mechanism does not actually enforce.                                                                                   |
| [`ics.md`](ics.md)                                       | The personal calendar subscription: what the feed serves, how its URL is authenticated, and what has been verified about it.                                                                                                                  |
| [`implementation-plan.md`](implementation-plan.md)       | `plan.md` broken into dispatchable tasks. The plan of record for what is built when.                                                                                                                                                          |
| [`realtime.md`](realtime.md)                             | The Socket.io connection: the rooms, the events, the cell lock, and what the client does with each broadcast.                                                                                                                                 |
| [`rulings.md`](rulings.md)                               | The 103 judgment calls the implementation run made where `plan.md` was silent — what was decided, why, and what each costs if it is wrong.                                                                                                    |
| [`slack.md`](slack.md)                                   | The outbound-only Slack notifications and the scheduled jobs that carry them: what the API tells Slack, when, and what happens when Slack is broken, off, or scaled.                                                                          |
| [`testing.md`](testing.md)                               | The four test layers, what each is for, how to run it, and what must be running first.                                                                                                                                                        |
| [`waitlist.md`](waitlist.md)                             | Reservations, the queue, and the auto-promotion that hands a cancelled spot to the next person in the same transaction.                                                                                                                       |
| [`workspace.md`](workspace.md)                           | The Nx monorepo: project layout, the checks, the module boundaries, and how to add a lib that is governed by them.                                                                                                                            |
| [`wrappers.md`](wrappers.md)                             | The mandatory wrapper libs — form, api-client, query, auth, realtime-client, calendar-export — and why app code may never import their dependencies directly.                                                                                 |

## `doc/design/`

The finished visual design, downloaded locally so it does not depend on a link
staying alive (`doc/decision/0002-visual-design-source-of-truth`).

| Path                                                    | What it is                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`design/README.md`](design/README.md)                  | What was exported, from where, and how to read it.                                                   |
| `design/lets-park-design.dc.html`                       | The design canvas itself.                                                                            |
| `design/ds/colors_and_type.css`, `design/ds/support.js` | The source palette and type scale the tokens were derived from.                                      |
| `design/ds/fonts/*.otf`                                 | Eight Neue Haas Grotesk faces (`doc/decision/0012-otf-fonts-committed-without-verified-license`).    |
| `design/screens/*.png`                                  | 14 numbered screen exports plus two canvas overviews — the reference every screen was built against. |

## Decision records

Indexed in their own directory: [`doc/decision/README.md`](decision/README.md)
lists all 201 records, one line each, in the same format as the topic-document
table above.
