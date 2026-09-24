'use client';

/**
 * The admin's three holder fields, for a free bay.
 *
 * Presentational, and deliberately **not** its own form: it renders inside
 * `SpotDialog`'s `FormProvider`, because the submit button lives in the
 * `Modal`'s footer, outside this subtree. That is the same split
 * `apps/garage/web/src/shell/admin/admin-spots-screen/spot-form-dialog.tsx` uses —
 * `form.handleSubmit` is created in the component that owns the modal, and the
 * fields sit under the provider.
 *
 * Domain composition, so it lives in app feature code and never in
 * `libs/shared/design-system` (`plan.md`, design-system-first).
 */

import { Box, Input, Select, Stack } from '@garage/design-system/primitives';
import { FormField } from '@garage/form';
import { HALF_HOUR_END_TIMES, HALF_HOUR_START_TIMES, useTranslations } from '@garage/i18n';
import { formatTimeOfDay } from '../lot-view';
import { GUEST_HOLDER_VALUE, plateHintFor } from './holder-input';
import type { HolderDuration, HolderFormValues, HolderOption } from './holder-input';

export interface HolderFieldsProps {
  readonly options: readonly HolderOption[];
  /** The `holderId` currently selected — the guest field is only shown for a guest. */
  readonly holderId: string;
  /** The `duration` currently selected — the time selects only show for `'TIMED'`. */
  readonly duration: HolderDuration;
  /**
   * A `'timed'` spot's dialog: the holder is a fixed guest and the duration
   * is a fixed block, so neither the holder select nor the duration select
   * is rendered — only the time-range selects, always.
   */
  readonly timedOnly: boolean;
}

export function HolderFields({ options, holderId, duration, timedOnly }: HolderFieldsProps) {
  const t = useTranslations('lot');
  const hint = plateHintFor(options, holderId);
  const isGuest = timedOnly || holderId === GUEST_HOLDER_VALUE;
  const showTimeFields = timedOnly || duration === 'TIMED';

  // `mb-5` was baked into the field stack's own className; it is this
  // component's placement in `SpotDialog`, not part of `Stack`'s own chrome,
  // so it moves to a wrapping `Box margin=`.
  return (
    <Box margin={[0, 0, 5, 0]}>
      <Stack spacing={4}>
        {timedOnly ? null : (
          <FormField<HolderFormValues, 'holderId'>
            name="holderId"
            render={({ field, error: fieldError }) => (
              <Select label={t('holderField')} error={fieldError} {...field}>
                {options.map((option) => (
                  <option key={option.userId} value={option.userId}>
                    {option.name}
                    {option.licensePlate === null ? '' : ` — ${option.licensePlate}`}
                  </option>
                ))}
                <option value={GUEST_HOLDER_VALUE}>{t('holderGuestOption')}</option>
              </Select>
            )}
          />
        )}

        {isGuest ? (
          <FormField<HolderFormValues, 'guestName'>
            name="guestName"
            render={({ field, error: fieldError }) => (
              <Input
                label={t('guestNameField')}
                // The schema carries no messages — it is built at module level,
                // where there is no translator — so the copy is resolved here.
                error={fieldError === undefined ? undefined : t('guestNameRequired')}
                {...field}
              />
            )}
          />
        ) : null}

        {isGuest && !timedOnly ? (
          <FormField<HolderFormValues, 'duration'>
            name="duration"
            render={({ field }) => (
              <Select label={t('durationField')} {...field}>
                <option value="FULL_DAY">{t('durationFullDay')}</option>
                <option value="TIMED">{t('durationTimed')}</option>
              </Select>
            )}
          />
        ) : null}

        {showTimeFields ? (
          <>
            <FormField<HolderFormValues, 'startTime'>
              name="startTime"
              render={({ field }) => (
                <Select label={t('startTimeField')} {...field}>
                  {HALF_HOUR_START_TIMES.map((time) => (
                    <option key={time} value={time}>
                      {formatTimeOfDay(time)}
                    </option>
                  ))}
                </Select>
              )}
            />
            <FormField<HolderFormValues, 'endTime'>
              name="endTime"
              render={({ field, error: fieldError }) => (
                <Select
                  label={t('endTimeField')}
                  error={fieldError === undefined ? undefined : t('timeRangeInvalid')}
                  {...field}
                >
                  {HALF_HOUR_END_TIMES.map((time) => (
                    <option key={time} value={time}>
                      {formatTimeOfDay(time)}
                    </option>
                  ))}
                </Select>
              )}
            />
          </>
        ) : null}

        <FormField<HolderFormValues, 'licensePlate'>
          name="licensePlate"
          render={({ field, error: fieldError }) => (
            <Input
              label={t('plateField')}
              // Blank means "use the holder's stored plate", so the placeholder is
              // what will actually be used — not a hint about formatting.
              placeholder={hint ?? t('noPlate')}
              error={fieldError}
              {...field}
            />
          )}
        />
      </Stack>
    </Box>
  );
}
