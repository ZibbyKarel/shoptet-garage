/**
 * The window state is *not* re-derived here.
 *
 * `monthLockState` / `isMonthOpen` in `@garage/shared-types` own the rule and
 * have their own exhaustive tests. What these tests pin is that this service
 * calls them with the right arguments — the settings from the database and
 * today in Europe/Prague — and shapes the answer the contract asks for. The
 * `delegates to shared-types` case makes that structural rather than a claim:
 * it compares this service's output against `monthLockState` called directly,
 * for every combination, so a hand-rolled copy of the rule here would have to
 * agree with the real one on all of them to pass.
 */

import { monthLockState, reservationWindowRange, startOfYearMonth } from '@garage/shared-types';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaDouble } from '../testing/prisma-double';
import { ReservationWindowService } from './reservation-window.service';

const TODAY = '2026-09-02';

describe('ReservationWindowService', () => {
  let double: PrismaDouble;
  let window: ReservationWindowService;

  beforeEach(() => {
    double = new PrismaDouble();
    window = new ReservationWindowService(
      double.asPrismaService(),
      new AuditLogService(double.asPrismaService())
    );
  });

  describe('getSettings', () => {
    it('returns the stored singleton', async () => {
      double.seedWindowSettings({ openDaysBefore: 14, lockMode: 'FORCE_OPEN' });

      await expect(window.getSettings()).resolves.toEqual({
        openDaysBefore: 14,
        lockMode: 'FORCE_OPEN',
      });
    });

    it('falls back to the documented defaults when the seed has never run', async () => {
      await expect(window.getSettings()).resolves.toEqual({
        openDaysBefore: 7,
        lockMode: 'AUTO',
      });
    });
  });

  describe('updateSettings', () => {
    it('replaces both fields', async () => {
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'AUTO' });

      const result = await window.updateSettings(
        { openDaysBefore: 21, lockMode: 'FORCE_LOCKED' },
        'admin-1'
      );

      expect(result).toEqual({ openDaysBefore: 21, lockMode: 'FORCE_LOCKED' });
      expect(double.windowSettings).toMatchObject({
        openDaysBefore: 21,
        lockMode: 'FORCE_LOCKED',
      });
    });

    it('creates the singleton when it does not exist yet', async () => {
      await window.updateSettings({ openDaysBefore: 3, lockMode: 'AUTO' }, 'admin-1');

      expect(double.windowSettings).toMatchObject({ id: 1, openDaysBefore: 3 });
    });

    it('records who changed it, from what, to what', async () => {
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'AUTO' });

      await window.updateSettings({ openDaysBefore: 7, lockMode: 'FORCE_LOCKED' }, 'admin-1');

      expect(double.auditLogs).toEqual([
        expect.objectContaining({
          actorUserId: 'admin-1',
          action: 'RESERVATION_WINDOW_UPDATED',
          entityType: 'ReservationWindowSettings',
          entityId: '1',
          payload: {
            before: { openDaysBefore: 7, lockMode: 'AUTO' },
            after: { openDaysBefore: 7, lockMode: 'FORCE_LOCKED' },
          },
        }),
      ]);
    });
  });

  describe('listMonths', () => {
    it('returns one ascending row per month in the inclusive range', async () => {
      double.seedWindowSettings();

      const result = await window.listMonths({ from: '2026-11', to: '2027-02' }, TODAY);

      expect(result.months.map((month) => month.month)).toEqual([
        '2026-11',
        '2026-12',
        '2027-01',
        '2027-02',
      ]);
    });

    it('echoes the settings the states were derived under', async () => {
      double.seedWindowSettings({ openDaysBefore: 10, lockMode: 'AUTO' });

      const result = await window.listMonths({ from: '2026-10', to: '2026-10' }, TODAY);

      expect(result.settings).toEqual({ openDaysBefore: 10, lockMode: 'AUTO' });
    });

    it('reports the AUTO window bounds even when a lock mode overrides the state', async () => {
      // The UI needs them to explain what the automatic rule would have done,
      // and reads `lockMode` to know that it did not apply.
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'FORCE_LOCKED' });

      const [month] = (await window.listMonths({ from: '2026-10', to: '2026-10' }, TODAY)).months;

      const expected = reservationWindowRange(startOfYearMonth('2026-10'), 7);
      expect(month).toMatchObject({
        state: 'LOCKED',
        lockMode: 'FORCE_LOCKED',
        windowFrom: expected.from,
        windowTo: expected.to,
      });
    });

    it.each([
      ['a month whose window has not opened yet', '2026-12', 'NOT_YET_OPEN'],
      ['the month whose window is open now', '2026-10', 'OPEN'],
      ['the current month, running past its window', '2026-09', 'OPEN'],
    ] as const)('reports %s as %s', async (_label, month, state) => {
      // openDaysBefore = 7 puts 2026-10's window at 2026-09-24..2026-09-30, so
      // on 2026-09-02 it is still NOT_YET_OPEN. Widen it so one case is OPEN.
      double.seedWindowSettings({ openDaysBefore: 40, lockMode: 'AUTO' });

      const result = await window.listMonths({ from: month, to: month }, TODAY);

      expect(result.months[0]?.state).toBe(state);
    });

    it('delegates to shared-types rather than re-deriving the rule', async () => {
      for (const openDaysBefore of [1, 7, 31]) {
        for (const lockMode of ['AUTO', 'FORCE_OPEN', 'FORCE_LOCKED'] as const) {
          double.seedWindowSettings({ openDaysBefore, lockMode });

          const { months } = await window.listMonths({ from: '2026-08', to: '2026-12' }, TODAY);

          // The expectation below is built from `months` itself, so an
          // implementation returning `[]` would satisfy it against an equally
          // empty list. August through December inclusive is five.
          expect(months).toHaveLength(5);
          expect(months.map((month) => month.state)).toEqual(
            months.map((month) =>
              monthLockState(startOfYearMonth(month.month), openDaysBefore, lockMode, TODAY)
            )
          );
        }
      }
    });
  });

  describe('describeDay', () => {
    it('answers for the month the day falls in', () => {
      const result = window.describeDay(
        '2026-10-17',
        { openDaysBefore: 7, lockMode: 'AUTO' },
        TODAY
      );

      expect(result.month).toBe('2026-10');
      expect(result.state).toBe('NOT_YET_OPEN');
    });
  });
});
