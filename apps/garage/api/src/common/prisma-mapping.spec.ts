/**
 * The storage ↔ contract gap.
 *
 * The date conversions are the part worth pinning: a `@db.Date` column carries a
 * calendar day with no time and no zone, and reading it with local getters (or
 * putting it through the Europe/Prague converter) shifts it by one day for half
 * the year. That bug does not announce itself — it produces a reservation for
 * the wrong day.
 */

import { toDateOnlyInPrague } from '@garage/shared-types';
import {
  toAdminUser,
  toContractSpot,
  toContractUser,
  toDateColumn,
  toDateOnly,
  toPublicReservation,
  toTimestamp,
  toUserSummary,
} from './prisma-mapping';

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'alice@example.test',
    name: 'Alice',
    licensePlate: '1AB 2345',
    role: 'USER' as const,
    oktaId: 'okta-1',
    active: true,
    icsToken: 'secret-token',
    preferredParkingSpotId: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

describe('date-only mapping', () => {
  it.each(['2026-01-01', '2026-03-29', '2026-06-15', '2026-10-25', '2026-12-31'])(
    'round-trips %s through the column representation',
    (date) => {
      expect(toDateOnly(toDateColumn(date))).toBe(date);
    }
  );

  it('reads the column in UTC, not in the process’ local zone', () => {
    // The `Date` a `@db.Date` column produces is UTC midnight. `getDate()` on a
    // machine west of Greenwich would answer with the previous day.
    expect(toDateOnly(new Date('2026-06-15T00:00:00.000Z'))).toBe('2026-06-15');
  });

  it('is not the Europe/Prague conversion — that one is for instants', () => {
    // Summer in Prague is UTC+2, so putting a column value through the zone
    // converter moves the day forward. Both functions are correct for their own
    // input; using the wrong one is the defect.
    const column = new Date('2026-06-15T00:00:00.000Z');

    expect(toDateOnly(column)).toBe('2026-06-15');
    expect(toDateOnlyInPrague(column)).toBe('2026-06-15');

    // The two only agree because a column value is midnight UTC. An *instant*
    // late in a Prague day is where they part company — which is why the two
    // conversions must not be confused for one another.
    expect(toDateOnlyInPrague(new Date('2026-06-14T23:30:00.000Z'))).toBe('2026-06-15');
    expect(toDateOnly(new Date('2026-06-14T23:30:00.000Z'))).toBe('2026-06-14');
  });

  it('rejects a value that is not a calendar day', () => {
    expect(() => toDateColumn('2026-02-30')).toThrow(TypeError);
  });
});

describe('entity mapping', () => {
  it('renders timestamps as the contract’s ISO strings', () => {
    expect(toTimestamp(EPOCH)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('maps a spot field for field', () => {
    expect(
      toContractSpot({
        id: 'spot-1',
        label: 'E2.92',
        group: 'IT',
        active: true,
        hidden: true,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      })
    ).toEqual({
      id: 'spot-1',
      label: 'E2.92',
      group: 'IT',
      active: true,
      hidden: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps the ICS token on the caller’s own profile', () => {
    expect(toContractUser(userRow())).toMatchObject({ icsToken: 'secret-token' });
  });

  it('removes the ICS token from the admin projection, and nothing else', () => {
    const full = toContractUser(userRow());
    const admin = toAdminUser(userRow());

    expect(admin).not.toHaveProperty('icsToken');
    expect(Object.keys(admin).sort()).toEqual(
      Object.keys(full)
        .filter((key) => key !== 'icsToken')
        .sort()
    );
  });

  it('reduces a user to three fields for other people’s eyes', () => {
    expect(toUserSummary(userRow())).toEqual({
      id: 'user-1',
      name: 'Alice',
      licensePlate: '1AB 2345',
    });
  });
});

describe('toPublicReservation', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    parkingSpotId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    guestName: null,
    licensePlate: null,
    date: new Date('2099-01-05T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
  };
  const holder = { id: row.userId as string, name: 'Jana Nováková', licensePlate: '1AB 2345' };

  it('projects a user holder, falling back to their stored plate', () => {
    expect(toPublicReservation(row, holder)).toEqual({
      id: row.id,
      createdAt: '2026-09-01T08:00:00.000Z',
      holder: { kind: 'USER', userId: holder.id, name: 'Jana Nováková', licensePlate: '1AB 2345' },
    });
  });

  it('prefers the per-reservation plate over the holder’s stored one', () => {
    const overridden = { ...row, licensePlate: '9XY 8765' };
    expect(toPublicReservation(overridden, holder).holder.licensePlate).toBe('9XY 8765');
  });

  it('projects a guest holder with no userId', () => {
    const guest = { ...row, userId: null, guestName: 'Jan Host', licensePlate: '9XY 8765' };
    const projected = toPublicReservation(guest, null);
    expect(projected.holder).toEqual({
      kind: 'GUEST',
      name: 'Jan Host',
      licensePlate: '9XY 8765',
    });
  });

  it('throws on a row with no holder at all, rather than inventing one', () => {
    // Unreachable through the database — `Reservation_holder_check` refuses the
    // row — so this pins the mapper's own behaviour if it ever is reached.
    const orphan = { ...row, userId: null, guestName: null };
    expect(() => toPublicReservation(orphan, null)).toThrow(/neither a user nor a guest/i);
  });

  it('throws when the holder does not belong to the row, rather than naming the wrong person', () => {
    // No call site does this today (Task 24's sweep checked all four); this
    // pins the hardening so a future one fails loudly instead of silently.
    const mismatched = { id: 'someone-else', name: 'Petr Novák', licensePlate: null };
    expect(() => toPublicReservation(row, mismatched)).toThrow(
      /has userId .+, but was mapped with holder/i
    );
  });
});
