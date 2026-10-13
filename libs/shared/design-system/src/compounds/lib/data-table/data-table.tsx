import { cx, FOCUS_RING } from '@garage/design-system/primitives';
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortFn,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, useState, type ReactNode } from 'react';

import { EmptyState } from '../empty-state/empty-state';

import { compareSortValues } from './compare-sort-values';

/**
 * The only `@tanstack/react-table` feature this table turns on.
 *
 * `libs/shared/design-system/src/compounds` is the package's owner in `WRAPPED_LIBRARIES`
 * (`eslint.config.mjs`), so this file is the single place in the workspace
 * allowed to import it — and every TanStack type stays behind the props below.
 * Nothing a caller passes in or gets back out is a TanStack type: sorting
 * crosses the boundary as `DataTableSort`, a plain `{ columnId, direction }`
 * object, so swapping the engine later is a change to this file alone.
 */
const FEATURES = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

/**
 * What a column may be sorted by. Deliberately narrow: these are the types
 * `<` and `>` order meaningfully. A column that needs anything else (a status
 * ranking, say) maps it to a number itself — which keeps the ordering rule
 * visible in the caller's code rather than buried in a comparator here.
 */
export type DataTableSortValue = string | number | boolean | null;

/**
 * What a row may be.
 *
 * Structurally identical to TanStack's own `RowData` constraint
 * (`Record<string, any> | Array<any>` in `@tanstack/table-core`), restated here
 * rather than imported so that no TanStack type appears in this lib's public
 * signatures — the whole point of the wrapper.
 *
 * `any`, not `unknown`, is load-bearing and was probed rather than assumed: a
 * caller's `interface UserRow { … }` is **not** assignable to
 * `Record<string, unknown>` (no index signature), so `unknown` here would
 * reject every row type declared as an `interface` while accepting the same
 * shape declared as a `type`. `Record<string, any>` accepts both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
export type DataTableRow = Record<string, any>;

export type DataTableAlign = 'start' | 'end';

const ALIGN_CELL: Record<DataTableAlign, string> = {
  start: 'text-left',
  end: 'text-right',
};

const ALIGN_HEADER: Record<DataTableAlign, string> = {
  start: 'justify-start',
  end: 'justify-end',
};

export interface DataTableColumn<TData> {
  /** Stable identity of the column. Also the key `sort` refers to. */
  id: string;
  /** Column heading. Rendered uppercase by the header's own styling. */
  header: ReactNode;
  /** Renders one body cell. */
  cell: (row: TData) => ReactNode;
  /**
   * Value this column sorts by. **Omit it and the column cannot be sorted** —
   * there is no separate `sortable` flag to disagree with it. That mirrors the
   * design, where `Štítek`/`Kategorie`/`Stav dnes` in
   * `doc/design/screens/04-admin-spots.png` are plain labels while
   * `Jméno`/`E-mail` in `03-admin-users.png` are buttons.
   */
  sortValue?: ((row: TData) => DataTableSortValue) | undefined;
  /** Horizontal alignment of the header and every cell. Defaults to `start`. */
  align?: DataTableAlign | undefined;
  /** Any CSS width, applied through `<colgroup>`. E.g. `'96px'`, `'30%'`. */
  width?: string | undefined;
}

/** Which column the table is ordered by, and which way. */
export interface DataTableSort {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<TData> {
  /** Column definitions, left to right. */
  columns: DataTableColumn<TData>[];
  /** The rows. Sorting is applied to a copy; this array is never mutated. */
  data: TData[];
  /**
   * Stable identity of a row — the React key, and the `data-row-id` attribute
   * on the `<tr>`. Required rather than defaulting to the array index, because
   * an index key re-uses the wrong DOM node the moment the table is re-sorted.
   */
  getRowId: (row: TData) => string;
  /**
   * The card's visible title **and** the table's accessible name (a `sr-only`
   * `<caption>`). One prop for both, so the two cannot drift apart.
   */
  title: string;
  /** Second line under the title. */
  description?: ReactNode | undefined;
  /** Right-hand side of the header band — a search field, or a primary button. */
  actions?: ReactNode | undefined;
  /** A band under the header, for filters. The category chips in `04-admin-spots.png`. */
  toolbar?: ReactNode | undefined;
  /** Minimum table width, e.g. `'560px'`. Below it the card scrolls sideways. */
  minWidth?: string | undefined;
  /** Initial ordering when the table owns its own sort state. */
  defaultSort?: DataTableSort | undefined;
  /**
   * Ordering, when the caller owns it. Pass `null` for "unsorted". Supplying
   * this makes the table controlled: it stops updating its own state and only
   * reports through `onSortChange`.
   */
  sort?: DataTableSort | null | undefined;
  /** Called with the ordering a header press asks for, in both modes. */
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  /**
   * Title of the empty state.
   *
   * **Required, and deliberately so.** This is user-visible copy, and this
   * library has no access to `libs/shared/i18n` — a compound that called
   * `useTranslations` would stop being presentation-only. A default here would
   * be a Czech sentence emitted from outside the message catalogue; making the
   * prop required puts it in app code, where the catalogue is, and lets the
   * compiler say so at the next call site rather than at the next reader.
   */
  emptyTitle: string;
  /** Second line of the empty state. */
  emptyDescription?: ReactNode | undefined;
  /** Call to action in the empty state, usually a `Button`. */
  emptyAction?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * The design's admin table: a bordered card with a title band, an optional
 * filter band, and a sortable list underneath.
 * (`doc/design/screens/03-admin-users.png`, `04-admin-spots.png`.)
 *
 * ## A real `<table>`
 *
 * The design draws the rows as a CSS grid, with `grid-template-columns` shared
 * between the header row and every body row. This renders a real
 * `<table>`/`<th>`/`<td>` instead, with the column tracks expressed through
 * `<colgroup>`. Same picture, but the row/column semantics, `aria-sort` and a
 * screen reader's table navigation come from the element rather than from a
 * hand-written set of `role` attributes that nothing would catch going stale —
 * the same reasoning as `doc/decision/0012-focus-ring-and-native-elements-in-primitives.md`.
 * See `doc/decision/0070-datatable-is-a-real-table-not-a-grid.md`.
 *
 * ## Sorting is a two-state toggle
 *
 * Pressing a sorted column flips it; pressing a new one starts it ascending.
 * There is no third "unsorted" press, because the design has no unsorted
 * appearance to show for it — every mock draws an arrow on exactly one column.
 * This is TanStack's `enableSortingRemoval: false` plus `sortDescFirst: false`,
 * and it reproduces the design's own `sortDir` logic exactly
 * (`garage-design.dc.html`, `userCols`).
 *
 * Domain-free: every string on screen arrives as a prop.
 */
export function DataTable<TData extends DataTableRow>({
  columns,
  data,
  getRowId,
  title,
  description,
  actions,
  toolbar,
  minWidth,
  defaultSort,
  sort,
  onSortChange,
  emptyTitle,
  emptyDescription,
  emptyAction,
  className,
}: DataTableProps<TData>) {
  const isControlled = sort !== undefined;
  const [internalSort, setInternalSort] = useState<DataTableSort | null>(defaultSort ?? null);
  const activeSort = isControlled ? sort : internalSort;

  const tanstackColumns = useMemo(
    () =>
      columns.map((column) => {
        const { sortValue } = column;

        if (sortValue === undefined) {
          // No accessor at all: TanStack's `column.getCanSort()` is false for a
          // display column, so an unsortable column cannot be sorted even by a
          // caller passing its id in `sort`.
          return { id: column.id };
        }

        const sortFn: SortFn<typeof FEATURES, TData> = (rowA, rowB) =>
          compareSortValues(sortValue(rowA.original), sortValue(rowB.original));

        return { id: column.id, accessorFn: sortValue, sortFn };
      }),
    [columns]
  );

  const sortingState: SortingState = useMemo(
    () =>
      activeSort === null
        ? []
        : [{ id: activeSort.columnId, desc: activeSort.direction === 'desc' }],
    [activeSort]
  );

  const table = useTable({
    features: FEATURES,
    columns: tanstackColumns,
    data,
    state: { sorting: sortingState },
    // The design starts every newly picked column ascending and never removes
    // a sort; both defaults would otherwise be the opposite for numeric
    // columns (`sortDescFirst` is inferred from the data) and for a third
    // press (`enableSortingRemoval` defaults to true).
    sortDescFirst: false,
    enableSortingRemoval: false,
    enableMultiSort: false,
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sortingState) : updater;
      const [first] = next;

      if (first === undefined) {
        return;
      }

      const nextSort: DataTableSort = {
        columnId: first.id,
        direction: first.desc ? 'desc' : 'asc',
      };

      // Guards a performance property, not a correctness one: `activeSort`
      // never reads `internalSort` while controlled, so this write would be
      // dead state, not a wrong one. Skipping it avoids a redundant re-render
      // on every controlled press the caller ignores — pinned by "does not
      // re-render when a controlled press is one the caller ignores" below.
      if (!isControlled) {
        setInternalSort(nextSort);
      }
      onSortChange?.(nextSort);
    },
  });

  const rows = table.getRowModel().rows;

  return (
    <section
      className={cx(
        'overflow-x-auto rounded-lg border border-border bg-bg',
        // Deliberately **unnamed**. A `<section>` is only a landmark once it
        // has an accessible name, and naming it here made every table announce
        // its title three times: once as a `region` landmark, once as the
        // table's `<caption>`, once as the visible heading. Three of those on
        // an admin screen gives a screen-reader user three same-named regions
        // to walk past. The caption is the one that has to stay — it is what
        // names the *table*, which is the thing being read.
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-6 py-5">
        <div>
          <div className="text-lg font-bold text-fg">{title}</div>
          {description !== undefined && <p className="text-sm text-fg-3">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {toolbar !== undefined && <div className="border-b border-divider px-6 py-4">{toolbar}</div>}

      <table className="w-full border-collapse" style={minWidth ? { minWidth } : undefined}>
        {/* The visible copy of this string is the card title above; a screen
            reader needs it attached to the table itself to announce one. */}
        <caption className="sr-only">{title}</caption>
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead className="bg-bg-soft">
          <tr>
            {columns.map((column) => {
              const align = column.align ?? 'start';
              const tanstackColumn = table.getColumn(column.id);
              const sorted = tanstackColumn?.getIsSorted() ?? false;
              const canSort = tanstackColumn?.getCanSort() ?? false;

              return (
                <th
                  key={column.id}
                  scope="col"
                  // Omitted entirely on a column that cannot be sorted:
                  // `aria-sort="none"` on a fixed column would announce a
                  // control that is not there.
                  aria-sort={
                    canSort
                      ? sorted === 'asc'
                        ? 'ascending'
                        : sorted === 'desc'
                          ? 'descending'
                          : 'none'
                      : undefined
                  }
                  className={cx(
                    'px-3 py-4 text-xs font-bold uppercase tracking-caps first:pl-6 last:pr-6',
                    ALIGN_CELL[align]
                  )}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={tanstackColumn?.getToggleSortingHandler()}
                      className={cx(
                        'inline-flex w-full cursor-pointer items-center gap-2 rounded-xs',
                        'border-0 bg-transparent p-0 text-xs font-bold uppercase tracking-caps',
                        'transition duration-[var(--dur-base)] ease-out',
                        // Both halves of the pair are supplied by the branch,
                        // never layered: two unconditional `text-*` utilities
                        // would resolve by Tailwind's emit order, not by the
                        // order they appear in here.
                        sorted === false
                          ? 'text-neutral-600 hover:text-fg'
                          : 'text-fg hover:text-fg',
                        ALIGN_HEADER[align],
                        FOCUS_RING
                      )}
                    >
                      {column.header}
                      {/* Decorative: `aria-sort` on the <th> is what actually
                          announces the direction, so reading the glyph too
                          would say it twice. */}
                      <span aria-hidden="true" className="text-[10px] leading-none">
                        {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : ''}
                      </span>
                    </button>
                  ) : (
                    <span className="text-neutral-600">{column.header}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="border-t border-divider">
                <EmptyState
                  size="sm"
                  title={emptyTitle}
                  description={emptyDescription}
                  action={emptyAction}
                />
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={getRowId(row.original)}
                data-row-id={getRowId(row.original)}
                className="border-t border-divider"
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cx(
                      'px-3 py-3 align-middle text-sm text-fg first:pl-6 last:pr-6',
                      ALIGN_CELL[column.align ?? 'start']
                    )}
                  >
                    {column.cell(row.original)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
