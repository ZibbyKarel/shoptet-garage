# 0125 – The admin `⋯` opens the same dialog `onOpen` does, on purpose

## What

`lot-screen.tsx` wires `LotGrid`'s `onOpenSpot` and `onAdminOpenSpot` to the
same function (`openDialog`). Clicking a taken tile and clicking its `⋯`
button, for an admin, open the identical `SpotDialog`. This decision records
why that is deliberate rather than an oversight, and what was fixed alongside
it: `spotMenuManage`, an i18n key for a menu entry that was never built, has
been deleted, and the two doc comments that described a real menu
(`lot-grid.tsx`'s `SpotTileProps.onAdminOpen` and the module header) have
been corrected.

## Why

### What the design's `⋯` actually does

`garage-design.dc.html` gives the tile click and the `⋯` click two
different handlers:

```js
// line 578-579, spotView()
onAdmin: e => { e.stopPropagation(); this.setState({ modal: { label: sp.label, admin: true } }); },
onClick: () => { … this.setState({ modal: { label: sp.label, queue: taken && !mine, mine } , … }); }
```

But both end up in the **same** `modal` state shape rendered by the **same**
markup, and the title/body logic (line 744) does not read `modal.admin` for
its headline at all:

```js
modalTitle: modal.info ? "Rezervace uzamčeny"
  : modal.queue ? "Přidat se do fronty"
  : modal.mine  ? "Vaše rezervace"
  : mTaken      ? "Upravit rezervaci"     // ← reached by BOTH a plain click
                                          //   on a taken-by-admin flow and by ⋯
  : "Rezervovat místo",
```

`modal.admin` is read in exactly one place, the **sub**-text, and only to
choose between two admin-appropriate sentences ("Jako admin můžete rezervaci
kdykoliv změnit nebo zrušit" vs. the ordinary holder's "Změňte jméno nebo SPZ
u této rezervace") — not to gate what the modal can do. The design's own
prototype, in other words, already treats `⋯` as a second door into
one room, not a menu with its own contents.

### What this codebase's contract will and will not let the modal do

`SpotDialog`'s title/description (`spot-dialog.tsx:102-128`) already branch on
`isAdmin` alone, regardless of which button opened the dialog: an admin
looking at a taken spot sees `titleEdit` ("Upravit rezervaci") and `subAdmin`
("Jako admin můžete rezervaci kdykoliv zrušit"), and `showCancel` already
grants the cancel button on `isAdmin || spot.isMine` independent of how the
dialog was reached (`:89`). That is the one write the contract actually
supports for someone else's reservation — `libs/garage/contract/src/api/
reservations.ts` exposes `create` (self only) and `cancel`, nothing that lets
an admin rewrite another user's name or plate the way the design's mock
`saveReservation` does by direct state mutation. So "editing" in the brief's
sense (the design's Jméno/SPZ rewrite) has no procedure to call and cannot be
built, contract-first, regardless of which button is clicked.

Given that, a dialog opened by `⋯` and a dialog opened by the tile itself
would render **identically** for an admin — same title, same sub-text, same
cancel button — because every input those branches read (`isAdmin`, `isTaken`,
`isQueued`, `spot.isMine`) is unaffected by which button was pressed. Building
a real, separate one-item dropdown menu (as `spotMenuManage`'s comment
implied) would have meant adding a second UI surface whose only entry
reproduces a click the tile already offers — complexity with no behavioural
difference to show for it.

### What `⋯` is for, then

Discoverability and visual parity with the design (`01-lot-admin.png` draws it
on every taken tile once signed in as an admin), not a distinct capability.
Keeping it as a second, clearly admin-labelled affordance ("Možnosti místa
{label}") costs one extra button and nothing else, and matches what an admin
scanning the lot for a `⋯` (from the screenshot) expects to find.

### What was wrong, and is now fixed

- `libs/shared/i18n/src/lib/messages.ts` declared `spotMenuManage: 'Upravit
  rezervaci'` with the comment "the single entry in that menu" — referenced
  nowhere in `apps/` or `libs/` (confirmed by the task review's `grep`). It
  duplicated `titleEdit`'s own value and implied a menu that was never built.
  Deleted.
- `lot-grid.tsx:73-74`'s doc comment read "Separate so it does not open the
  same modal" — the call site makes it open exactly the same modal. Corrected
  to state the real reason `⋯` exists, with a pointer here.

## Consequences

- No new UI surface, no new contract procedure, no new test surface beyond
  what `spot-dialog.spec.tsx` already covers for `isAdmin` (`showCancel`,
  `titleEdit`/`subAdmin`) — those tests already prove the admin-flavoured
  dialog is correct regardless of trigger, which is exactly the property this
  decision relies on.
- If a future task (the brief's "editing" someone else's reservation, name or
  plate) adds a real admin-edit procedure to the contract, `⋯` and the plain
  tile click should diverge then — `onAdminOpen` should route to whatever new
  affordance that procedure needs, and this ADR should be revisited.
- `lot-grid.spec.tsx`'s tests asserting `⋯` calls `onAdminOpen` and the tile
  click calls `onOpen` (two distinct `jest.fn()`s) remain correct and
  necessary: `LotGrid` itself must still wire the two buttons separately, even
  though `lot-screen.tsx` happens to point them at the same function today.

## Verified by

`grep -rn spotMenuManage apps/ libs/` — no reference outside the (now deleted)
declaration and value, confirmed before removal. `spot-dialog.spec.tsx`'s
existing `isAdmin`/`showCancel`/`titleEdit` coverage; no new test was added
here because no new behaviour was introduced.
