# 0122 – The window banner is always rendered; `showLockState` is not a hiding rule

## What

`WindowBanner` is rendered unconditionally on the parking screen. There is no
prop, setting or data condition under which the screen shows no banner.

The Task 24 brief asks for a banner "hidden when the design hides it
(`14-lot-user-lockstate-off.png`)". This decision records why that screenshot
does not describe a hidden banner, and why no hiding rule was built.

## Why

### The screenshot shows no such thing — measured

`doc/design/README.md` captions `14-lot-user-lockstate-off.png` as "The parking
lot with no reservation-window status banner". Compared against
`12-lot-user.png`, the same screen at the same viewport:

```
$ python3 - <<'PY'
from PIL import Image, ImageChops
a = Image.open('12-lot-user.png').convert('RGB')
b = Image.open('14-lot-user-lockstate-off.png').convert('RGB')
print(a.size, b.size)          # (873, 837) (873, 837)
print(ImageChops.difference(a, b).getbbox())
PY
(1, 719, 872, 836)
```

The **only** differing pixels are the bottom 117 rows — the sticky day bar.
Cropping that strip out of both and viewing them at 2× shows two visually
identical bars; the difference is sub-pixel antialiasing. Everything above it —
the header, the green banner, the IT band, and the hatched "právě upravuje"
tile E2.95 — is byte-identical between the two files.

So the screenshot captioned "no banner" contains the banner, in the same place,
with the same text.

### The design source says the prop toggles something else entirely

`garage-design.dc.html` declares `showLockState` as a prototype prop and uses
it in exactly one place:

```js
// line 547
const showLock = this.props.showLockState ?? true;
// line 563, inside spotView()
const locked = !!sp.lockedBy && showLock;
```

It never reaches `bannerText`, `bannerBg`, `bannerBorder`, `bannerIcon`,
`bannerIconBg` or `bannerIconFg`. It is a switch for the **cell-lock** overlay
— the hatched tile — so a designer can screenshot the lot with and without one.
Both screenshots were taken at its default (`true`), which is why both show the
hatched tile and neither shows a hidden banner.

The README's caption is therefore wrong about its own file, and the brief
inherited it.

### There is no state in which the screen has nothing to say

`overview.day` always carries a `window`, and `MonthLockState` is a closed enum
of three members, each with exactly one true sentence (`doc/decision/0121-*`).
A banner that could be absent would need a fourth state meaning "the window is
unknown", which the contract does not have and could not have — the window
travels with the payload precisely so "the frontend never needs a second round
trip and can never render a day's grid against a stale window"
(`overview.ts`).

Building a hiding rule would therefore have meant inventing a product feature
from a mis-captioned screenshot.

## Consequences

- One less conditional on the screen's most-read element.
- The cell-lock overlay — the thing `showLockState` actually toggles — is
  driven by live `cell:locked` broadcasts, so the "off" state the prop
  simulates is simply what the screen shows when nobody is editing. Nothing
  needed to be built for it.
- **This is a deviation from the brief's literal wording** and is flagged as
  such in the task report. If the intent really was a dismissible banner, that
  is a small addition on top of this and needs a product decision, not a
  screenshot.

## Verified by

The measurement above (reproducible from `doc/design/screens/`), and the two
`grep`-able lines of the design source. `apps/garage/web/src/lot/lot-view.spec.ts`
covers the six banner variants; no test asserts absence, because there is no
absent case.
