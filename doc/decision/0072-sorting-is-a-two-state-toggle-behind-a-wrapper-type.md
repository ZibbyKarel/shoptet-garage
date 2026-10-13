# 0072 – Sorting is a two-state toggle, and no TanStack type crosses the wrapper

## What

`DataTable` is the workspace's only importer of `@tanstack/react-table`
(`WRAPPED_LIBRARIES` in `eslint.config.mjs` names this lib as its owner). Two
decisions about that boundary:

1. **Nothing a caller passes in or receives back is a TanStack type.** Sorting
   crosses as `DataTableSort` — `{ columnId, direction: 'asc' | 'desc' }` — and
   a column's sortability is expressed by whether `sortValue` is present, not by
   a TanStack `ColumnDef`.
2. **A header press toggles between exactly two states.** First press on a new
   column sorts ascending; a press on the sorted column flips it. There is no
   third "unsorted" press.

## Why

### The wrapper type

- **A wrapper that re-exports the wrapped library's types is not a wrapper.** If
  a screen had to import `SortingState` to hold its own sort, `@tanstack/react-table`
  would be in that screen's type graph and the ESLint ban would be enforcing
  nothing of substance — the dependency would be back, just spelled differently.
  With `DataTableSort`, replacing the engine is a change to `data-table.tsx`
  alone.
- **The row-type constraint is restated, not imported.** `DataTableRow` is
  `Record<string, any>`, structurally identical to TanStack's own `RowData`.
  `any` rather than `unknown` is **load-bearing and was probed, not assumed**: a
  caller's `interface UserRow { … }` is not assignable to
  `Record<string, unknown>` (no index signature), so `unknown` would reject every
  row type declared as an `interface` while accepting the same shape declared as
  a `type`. `data-table.spec.tsx` declares its fixture as an `interface`
  precisely so this stays true.

### The two-state toggle

- **It is the design's own logic, not a simplification of it.**
  `garage-design.dc.html` implements the users table as
  `sortDir: s.sortKey === c.key ? -s.sortDir : 1` — flip on the same key, start
  at ascending on a new one. There is no third branch.
- **The design has no unsorted appearance to show.** Every mock draws an arrow on
  exactly one column (`col.arrow` is set only when `sortKey === c.key`). A third
  press returning to "no column sorted" would have to render a state the design
  never defines.
- **Both TanStack defaults are the opposite of this** and would have been silent
  bugs: `enableSortingRemoval` defaults to `true` (the third press clears), and
  `sortDescFirst` is *inferred from the data*, so a numeric column would open
  descending while a text column next to it opened ascending. Both are pinned
  explicitly, and both pins have a test — mutating either one fails the suite.
  The third pin, `enableMultiSort` (below), is also tested, so all three of
  this decision's TanStack pins now have one — not just these two.

## How

- `tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() })`
  — sorting is the only feature turned on. TanStack v9 requires features to be
  declared; nothing else is.
- `sortDescFirst: false`, `enableSortingRemoval: false`, `enableMultiSort: false`.
  The design has no multi-column sort. All three are pinned **and** tested —
  mutating any one of them fails the suite (`enableMultiSort`'s test asserts
  that a shift-click on a second column replaces the sort instead of adding to
  it, since a shift-click is the only public-API path that can tell the two
  settings apart — the `onSortingChange` handler already reduces every update
  to its first entry, so a plain click can't distinguish them).
- **`sortValue` doubles as the accessor and the sortability flag.** TanStack's
  `column.getCanSort()` is false without an `accessorFn`, so a column with no
  `sortValue` is a display column and *cannot* be sorted even if a caller passes
  its id in `sort`. There is no separate boolean that could disagree with it.
- **The comparator is explicit, per column**, rather than left to TanStack's
  automatic detection: auto-detection reads the first non-null value to pick a
  comparator, so a column whose leading rows happen to be empty would sort
  differently than the same column with the rows in another order. `null` sorts
  last ascending.
- **Controlled and uncontrolled**, matching the primitives' pattern: `sort`
  (with `null` meaning unsorted) makes it controlled, `defaultSort` seeds the
  uncontrolled case, and `onSortChange` reports in both modes.
- `aria-sort` is written on the `<th>` and the arrow glyph is `aria-hidden`, so
  the direction is announced once rather than twice.
- **Jest needs the ESM transform block.** `@tanstack/react-table` v9 and its
  whole chain (`table-core`, `react-store`, `store`) are `"type": "module"` with
  no `require` condition, so `libs/shared/design-system/compounds/jest.config.cts`
  carries the `transformIgnorePatterns` line from
  `doc/decision/0020-orpc-is-esm-only-jest-must-transpile-it.md`. This is the
  **sixth** copy of that block; see the risk below.

## Risk

- **TanStack Table v9 is a young major.** Its API is materially different from
  v8 (`useTable` + `tableFeatures` rather than `useReactTable` + row-model
  factories). The wrapper is what contains that risk — the blast radius of a
  v9→v10 change is this one file.
- **Decision 0020's consolidation is now six copies overdue.** Each copy has
  recorded the same reason for deferring (the move edits files other in-flight
  tasks own) and this one is no different. It should be done deliberately, in a
  task that owns `jest.preset.js`.
- **Only one column can be sorted at a time**, by choice. A screen needing a
  tiebreaker has to fold it into that column's `sortValue`.
- **Sorting is client-side.** Every row is in the browser. The admin tables are
  tens of rows; a server-sorted table would use the controlled `sort` prop and
  ignore the row model, which the API already allows but nothing yet exercises.
