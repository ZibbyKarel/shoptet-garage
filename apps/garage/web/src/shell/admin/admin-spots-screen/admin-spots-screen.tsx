'use client';

/**
 * The "Parkovací místa" tab (`doc/design/screens/04-admin-spots.png`): the spot
 * list, an inline category picker and activity switch per row, and add / edit /
 * delete.
 *
 * ## "Smazat" retires, it never deletes
 *
 * The button says *Smazat* because the design says so, but the procedure behind
 * it is `admin.spot.deactivate`, which sets `active: false`. A spot row can
 * never be deleted — `Reservation`, `WaitlistEntry` and `AuditLog` all point at
 * it — and the API refuses even the soft delete while somebody still holds the
 * spot from today onwards. That `CONFLICT` gets its own Czech sentence here,
 * because the generic one ("somebody else made the same change") would be a
 * false explanation. See
 * `doc/decision/0163-smazat-retires-a-spot-and-says-so-when-it-cannot.md`.
 *
 * ## The category chips are counts, not editors
 *
 * The design draws removable chips and an "Přidat kategorii" field. A category
 * is `PARKING_GROUPS` — a closed enum in `libs/garage/shared-types` backed by a Postgres
 * enum column — so there is nothing here that could add or remove one without a
 * schema change. The band renders the counts and says the list is fixed rather
 * than offering a control that cannot work. See
 * `doc/decision/0164-parking-categories-stay-a-closed-enum.md`.
 *
 * ## "Skryté" hides, it does not retire
 *
 * A hidden spot is seen and booked by admins only; normal users do not see it
 * anywhere (`doc/decision/0316-hidden-spots-are-seen-and-booked-by-admins-only`).
 * Unlike the activity switch it collides with nothing, so it has no conflict
 * copy of its own.
 *
 * ## "Nabíječka" is information only
 *
 * The EV-charger switch changes no booking rule and collides with nothing, so
 * like "Skryté" it has no conflict copy of its own. The bolt next to the label
 * is the same mark the lot draws, and it carries the same accessible name
 * (`doc/decision/0317-the-ev-charger-flag-is-informational-and-shown-to-everyone`).
 *
 * Presentational: `../admin-spots-panel.tsx` is the connected half.
 */

import { useState } from 'react';
import type { CreateSpotInput, ParkingGroup, ParkingSpot, SpotListOutput } from '@garage/contract';
import {
  Badge,
  BoltIcon,
  Button,
  Select,
  Stack,
  Switch,
  Text,
  VisuallyHidden,
} from '@garage/design-system/primitives';
import { ConfirmDialog, DataTable } from '@garage/design-system/compounds';
import type { DataTableColumn } from '@garage/design-system/compounds';
import { PARKING_GROUPS, useTranslations } from '@garage/i18n';
import { useNotify } from '../../notifications/toast-provider';
import { ScreenDataGuard, type ScreenData } from '../../screen-state/screen-state';
import { useAdminWriteError, type AdminWriteFailure } from '../admin-errors';
import {
  isDialogSaving,
  shouldShowFailureIn,
  type FailureSurface,
  type SpotDialog,
} from './spots-view';
import { CategoryBand } from './category-band';
import { SpotFormDialog } from './spot-form-dialog';

/** How a spot stands today, as the day overview reports it. */
export interface SpotToday {
  /** Name of whoever holds the spot today, or `null` when it is free. */
  readonly holderName: string | null;
  /** Whether that holder is a guest — meaningless when {@link holderName} is `null`. */
  readonly holderIsGuest: boolean;
}

export interface AdminSpotsScreenProps {
  readonly onRetry: () => void;
  /** The spot list as one state. Inactive spots included. */
  readonly spots: ScreenData<SpotListOutput>;
  /**
   * Today's state per spot id. A spot missing from the map has no state to show
   * — an inactive spot is not in the day overview at all — and renders as a
   * dash rather than as "Volné", which would be a claim.
   */
  readonly todayBySpotId: ReadonlyMap<string, SpotToday>;
  /** Resolves when the spot exists; rejects to keep the dialog open. */
  readonly onCreate: (input: CreateSpotInput) => Promise<void>;
  /** Same contract, for a label/group/EV charger edit. */
  readonly onSave: (input: {
    id: string;
    label: string;
    group: ParkingGroup;
    evCharger?: boolean;
  }) => Promise<void>;
  /** Inline activity switch. Fire-and-forget: the row reports through `rowError`. */
  readonly onActiveChange: (id: string, active: boolean) => void;
  /** Inline "Skryté" switch. Fire-and-forget, like `onActiveChange`. */
  readonly onHiddenChange: (id: string, hidden: boolean) => void;
  /** Inline "Nabíječka" switch. Fire-and-forget, like `onActiveChange`. */
  readonly onEvChargerChange: (id: string, evCharger: boolean) => void;
  /** Resolves when the spot is retired; rejects to keep the dialog open. */
  readonly onDeactivate: (id: string) => Promise<void>;
  /**
   * A write is in flight for this spot id, if any. Scopes the row-level
   * disabling: only the row being written is frozen, not the whole table.
   */
  readonly pendingSpotId: string | null;
  /** Any write is in flight — including a create, which has no id yet. */
  readonly isSaving: boolean;
  /**
   * The failed write, or `null` when there is none. See
   * {@link AdminWriteFailure} for why the error and its origin are one value.
   */
  readonly writeFailure: AdminWriteFailure | null;
  /**
   * Throws away whatever `writeFailure` holds.
   *
   * Called on every dialog change — opened, swapped, cancelled or closed after
   * a success. A failure describes one attempt at one spot; the moment the
   * admin moves to a different dialog it describes nothing on screen, and
   * leaving it in state is how it gets re-shown under the wrong heading. See
   * `doc/decision/0167-*`.
   */
  readonly onDiscardFailure: () => void;
}

export function AdminSpotsScreen({
  onRetry,
  spots,
  todayBySpotId,
  onCreate,
  onSave,
  onActiveChange,
  onHiddenChange,
  onEvChargerChange,
  onDeactivate,
  pendingSpotId,
  isSaving,
  writeFailure,
  onDiscardFailure,
}: AdminSpotsScreenProps) {
  const t = useTranslations('admin');
  // Same badge and key the spot dialog and the admin day table render —
  // `guestHolder` lives in the `lot` catalogue.
  const tLot = useTranslations('lot');
  const describeWriteError = useAdminWriteError();
  const [dialog, setDialog] = useState<SpotDialog | null>(null);

  /**
   * The only way the dialog changes. Every open, swap, cancel and
   * close-on-success goes through here so that the failure on screen is
   * discarded with it — see `onDiscardFailure`.
   */
  function changeDialog(next: SpotDialog | null) {
    onDiscardFailure();
    setDialog(next);
  }

  /**
   * The sentence to print on `where`, or `null` when nothing belongs there.
   *
   * {@link shouldShowFailureIn} holds the rule — which surface a failure is
   * shown on, and which surfaces could have produced it at all; this adds the
   * two things only the screen has, the failure itself and the translation of
   * it. Each call site therefore renders at most one `Toast`.
   */
  function failureShownIn(where: FailureSurface): string | null {
    if (writeFailure === null) {
      return null;
    }
    return shouldShowFailureIn(writeFailure.from, dialog?.kind ?? null, where)
      ? describeWriteError(writeFailure.from, writeFailure.error)
      : null;
  }

  const dialogSaving = isDialogSaving(isSaving, dialog, pendingSpotId);

  const columns: DataTableColumn<ParkingSpot>[] = [
    {
      id: 'label',
      header: t('spotsColumnLabel'),
      sortValue: (spot) => spot.label,
      cell: (spot) => (
        <Stack direction="row" align="center" spacing={2}>
          <Text as="span" weight="bold">
            {spot.label}
          </Text>
          {spot.evCharger ? <BoltIcon label={tLot('evCharger')} /> : null}
          {spot.active ? null : <Badge tone="neutral">{t('spotsInactive')}</Badge>}
          {spot.hidden ? <Badge tone="neutral">{t('spotsHidden')}</Badge> : null}
        </Stack>
      ),
    },
    {
      id: 'group',
      header: t('spotsColumnGroup'),
      width: '160px',
      cell: (spot) => (
        <Select
          aria-label={t('spotsGroupSelectLabel', { label: spot.label })}
          value={spot.group}
          disabled={pendingSpotId === spot.id}
          onChange={(event) =>
            void onSave({
              id: spot.id,
              label: spot.label,
              group: event.currentTarget.value as ParkingGroup,
            }).catch(() => {
              // The row's failure is rendered by `writeFailure` above the table;
              // an unhandled rejection here would only add noise to the console.
            })
          }
        >
          {PARKING_GROUPS.map((group) => (
            <option key={group} value={group}>
              {group}
            </option>
          ))}
        </Select>
      ),
    },
    {
      id: 'today',
      header: t('spotsColumnToday'),
      cell: (spot) => {
        const today = todayBySpotId.get(spot.id);
        if (today === undefined) {
          return (
            <Text as="span" tone="subtle">
              {t('spotsTodayUnknown')}
            </Text>
          );
        }
        return today.holderName === null ? (
          <Text as="span" tone="subtle">
            {t('dayStatusFree')}
          </Text>
        ) : (
          // Same `ml-2`-as-row-gap replacement as `AdminDayScreen`'s status
          // column — this cell renders the identical guest tag.
          <Stack direction="row" align="center" spacing={2}>
            <Text as="span">{t('dayStatusTaken', { name: today.holderName })}</Text>
            {today.holderIsGuest ? (
              <Badge size="sm" tone="tag">
                {tLot('guestHolder')}
              </Badge>
            ) : null}
          </Stack>
        );
      },
    },
    {
      id: 'active',
      header: t('spotsColumnActive'),
      width: '110px',
      cell: (spot) => (
        <Switch
          tone="success"
          checked={spot.active}
          aria-label={t('spotsActiveToggleLabel', { label: spot.label })}
          disabled={pendingSpotId === spot.id}
          onCheckedChange={(next) => onActiveChange(spot.id, next)}
        />
      ),
    },
    {
      id: 'hidden',
      header: t('spotsColumnHidden'),
      width: '110px',
      cell: (spot) => (
        <Switch
          checked={spot.hidden}
          aria-label={t('spotsHiddenToggleLabel', { label: spot.label })}
          disabled={pendingSpotId === spot.id}
          onCheckedChange={(next) => onHiddenChange(spot.id, next)}
        />
      ),
    },
    {
      id: 'evCharger',
      header: t('spotsColumnEvCharger'),
      width: '110px',
      cell: (spot) => (
        <Switch
          checked={spot.evCharger}
          aria-label={t('spotsEvChargerToggleLabel', { label: spot.label })}
          disabled={pendingSpotId === spot.id}
          onCheckedChange={(next) => onEvChargerChange(spot.id, next)}
        />
      ),
    },
    {
      id: 'actions',
      header: <VisuallyHidden>{t('spotsColumnActions')}</VisuallyHidden>,
      align: 'end',
      width: '210px',
      cell: (spot) => (
        <Stack direction="row" align="center" spacing={2}>
          <Button
            variant="secondary"
            disabled={pendingSpotId === spot.id}
            onClick={() => changeDialog({ kind: 'edit', spot })}
          >
            {t('spotsEdit')}
          </Button>
          <Button
            variant="danger"
            disabled={pendingSpotId === spot.id}
            onClick={() => changeDialog({ kind: 'delete', spot })}
          >
            {t('spotsDelete')}
          </Button>
        </Stack>
      ),
    },
  ];

  const tableError = failureShownIn('table');
  // Only the delete dialog carries its failure inside itself; the form dialog
  // takes the same value through its own `errorMessage` prop.
  const deleteError = dialog?.kind === 'delete' ? failureShownIn('dialog') : null;

  useNotify(tableError, 'danger');
  useNotify(deleteError, 'danger');

  return (
    <ScreenDataGuard state={spots} onRetry={onRetry} headingLevel={3}>
      {(loaded) => (
        <Stack spacing={4}>
          <DataTable
            columns={columns}
            data={[...loaded.spots]}
            getRowId={(spot) => spot.id}
            title={t('spotsTitle')}
            description={t('spotsDescription')}
            actions={
              <Button variant="primary" size="lg" onClick={() => changeDialog({ kind: 'create' })}>
                {t('spotsAdd')}
              </Button>
            }
            toolbar={<CategoryBand spots={loaded.spots} />}
            defaultSort={{ columnId: 'label', direction: 'asc' }}
            minWidth="900px"
            emptyTitle={t('spotsEmpty')}
            emptyDescription={t('spotsEmptyDescription')}
          />

          {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
            <SpotFormDialog
              // A fresh form per spot. Without it an edit→edit transition would
              // reuse the mounted form and its previous `defaultValues`.
              key={dialog.kind === 'edit' ? dialog.spot.id : 'create'}
              spot={dialog.kind === 'edit' ? dialog.spot : null}
              errorMessage={failureShownIn('dialog')}
              saving={dialogSaving}
              onCancel={() => changeDialog(null)}
              onSubmit={async (values) => {
                if (dialog.kind === 'edit') {
                  await onSave({ id: dialog.spot.id, ...values });
                } else {
                  await onCreate(values);
                }
                changeDialog(null);
              }}
            />
          ) : null}

          <ConfirmDialog
            open={dialog?.kind === 'delete'}
            title={t('spotsDeleteTitle', {
              label: dialog?.kind === 'delete' ? dialog.spot.label : '',
            })}
            description={t('spotsDeleteDescription')}
            confirmLabel={t('spotsDeleteConfirm')}
            cancelLabel={t('spotsCancel')}
            tone="danger"
            loading={dialogSaving}
            onConfirm={() => {
              if (dialog?.kind !== 'delete') {
                return;
              }
              void onDeactivate(dialog.spot.id).then(
                () => changeDialog(null),
                () => {
                  // Left open on purpose: the sentence below is the retry
                  // affordance, and closing would hide why nothing happened.
                }
              );
            }}
            onCancel={() => changeDialog(null)}
          />
        </Stack>
      )}
    </ScreenDataGuard>
  );
}
