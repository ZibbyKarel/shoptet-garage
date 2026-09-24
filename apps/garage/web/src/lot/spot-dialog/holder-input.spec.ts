import {
  GUEST_HOLDER_VALUE,
  holderFormSchema,
  plateHintFor,
  toHolderInput,
  toReservationRequest,
} from './holder-input';
import type { HolderFormValues } from './holder-input';

const OPTIONS = [
  { userId: 'u-1', name: 'Karel Zíbar', licensePlate: '4AB 1234' },
  { userId: 'u-2', name: 'Jana Nováková', licensePlate: null },
];

/** Full field values, defaulted the way the form's own defaults are. */
function values(overrides: Partial<HolderFormValues> = {}): HolderFormValues {
  return {
    holderId: 'u-1',
    guestName: '',
    licensePlate: '',
    duration: 'FULL_DAY',
    startTime: '08:00',
    endTime: '09:00',
    ...overrides,
  };
}

describe('holderFormSchema', () => {
  it('accepts a user holder with no plate typed', () => {
    expect(holderFormSchema.safeParse(values({ holderId: 'u-1' })).success).toBe(true);
  });

  it('requires a guest name when the holder is a guest', () => {
    expect(
      holderFormSchema.safeParse(values({ holderId: GUEST_HOLDER_VALUE, guestName: '   ' })).success
    ).toBe(false);
    expect(
      holderFormSchema.safeParse(values({ holderId: GUEST_HOLDER_VALUE, guestName: 'Jan Host' }))
        .success
    ).toBe(true);
  });

  it('rejects an empty holderId', () => {
    // `holderId: z.string().min(1)` — an empty value means the select was
    // somehow submitted with nothing chosen, which the form must refuse
    // rather than send on as an empty-string holder id.
    expect(holderFormSchema.safeParse(values({ holderId: '' })).success).toBe(false);
  });

  it('carries a marker message, not Czech copy — the render translates it', () => {
    const failed = holderFormSchema.safeParse(
      values({ holderId: GUEST_HOLDER_VALUE, guestName: '' })
    );
    expect(failed.success).toBe(false);
    // A schema built at module level cannot call `t()`, and Czech copy frozen
    // into it would bypass the catalogue. But the message must be *present*, or
    // `FormField` forwards `undefined` and the field renders no error at all.
    expect(failed.success === false && failed.error.issues[0]?.path).toEqual(['guestName']);
    expect(failed.success === false && failed.error.issues[0]?.message).toBe('GUEST_NAME_REQUIRED');
  });

  it('rejects an out-of-order guest time block', () => {
    const failed = holderFormSchema.safeParse(
      values({
        holderId: GUEST_HOLDER_VALUE,
        guestName: 'Jan Host',
        duration: 'TIMED',
        startTime: '10:00',
        endTime: '09:30',
      })
    );
    expect(failed.success).toBe(false);
    expect(failed.success === false && failed.error.issues[0]?.path).toEqual(['endTime']);
    expect(failed.success === false && failed.error.issues[0]?.message).toBe('TIME_RANGE_INVALID');
  });

  it('accepts a well-ordered guest time block', () => {
    expect(
      holderFormSchema.safeParse(
        values({
          holderId: GUEST_HOLDER_VALUE,
          guestName: 'Jan Host',
          duration: 'TIMED',
          startTime: '09:00',
          endTime: '10:30',
        })
      ).success
    ).toBe(true);
  });

  it('does not run the time-range check for a full-day guest', () => {
    // Only meaningful for `duration: 'TIMED'` — the default `startTime`/
    // `endTime` are never checked while a guest books the whole day.
    expect(
      holderFormSchema.safeParse(
        values({
          holderId: GUEST_HOLDER_VALUE,
          guestName: 'Jan Host',
          duration: 'FULL_DAY',
          startTime: '10:00',
          endTime: '09:30',
        })
      ).success
    ).toBe(true);
  });
});

describe('toHolderInput', () => {
  it('maps a chosen user, trimming the plate', () => {
    expect(toHolderInput(values({ holderId: 'u-2', licensePlate: '  9XY 8765 ' }))).toEqual({
      kind: 'USER',
      userId: 'u-2',
      licensePlate: '9XY 8765',
    });
  });

  it('sends no plate override when the field is blank', () => {
    expect(toHolderInput(values({ holderId: 'u-2', licensePlate: '   ' }))).toEqual({
      kind: 'USER',
      userId: 'u-2',
      licensePlate: null,
    });
  });

  it('maps a guest, trimming the name', () => {
    expect(
      toHolderInput(values({ holderId: GUEST_HOLDER_VALUE, guestName: ' Jan Host ' }))
    ).toEqual({ kind: 'GUEST', name: 'Jan Host', licensePlate: null });
  });
});

describe('toReservationRequest', () => {
  it('maps a guest booking a time block to a TIMED request', () => {
    expect(
      toReservationRequest(
        values({
          holderId: GUEST_HOLDER_VALUE,
          guestName: ' Jan Host ',
          duration: 'TIMED',
          startTime: '09:00',
          endTime: '10:30',
        })
      )
    ).toEqual({
      kind: 'TIMED',
      guestName: 'Jan Host',
      licensePlate: null,
      startTime: '09:00',
      endTime: '10:30',
    });
  });

  it('keeps a user holder on the FULL_DAY branch even if duration somehow says TIMED', () => {
    // Only a guest may book a block — `duration` is meaningless for a user
    // and must not change what gets submitted.
    expect(toReservationRequest(values({ holderId: 'u-1', duration: 'TIMED' }))).toEqual({
      kind: 'FULL_DAY',
      holder: { kind: 'USER', userId: 'u-1', licensePlate: null },
    });
  });

  it('maps a guest booking the whole day to the existing FULL_DAY holder shape', () => {
    expect(
      toReservationRequest(values({ holderId: GUEST_HOLDER_VALUE, guestName: 'Jan Host' }))
    ).toEqual({
      kind: 'FULL_DAY',
      holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: null },
    });
  });
});

describe('plateHintFor', () => {
  it('is the chosen user’s stored plate', () => {
    expect(plateHintFor(OPTIONS, 'u-1')).toBe('4AB 1234');
  });

  it('is null for a user with no plate, and for a guest', () => {
    expect(plateHintFor(OPTIONS, 'u-2')).toBeNull();
    expect(plateHintFor(OPTIONS, GUEST_HOLDER_VALUE)).toBeNull();
  });

  it('is null for an id that is not in the list', () => {
    expect(plateHintFor(OPTIONS, 'u-gone')).toBeNull();
  });
});
