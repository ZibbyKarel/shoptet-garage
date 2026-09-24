/**
 * `CalendarService` against `PrismaDouble`. What is tested here is the
 * *selection*: which reservations reach the feed, in what order, and what
 * happens to a token that resolves to nobody. The rendering is
 * `libs/garage/calendar-export`'s, and the wire behaviour is `calendar-pipeline.spec.ts`'s.
 */

import { NotFoundException } from '@nestjs/common';
import { PrismaDouble } from '../testing/prisma-double';
import { CalendarService, ICS_FEED_PAST_DAYS } from './calendar.service';

/** A fixed instant, so "today in Prague" is a value and not a moving target. */
const NOW = new Date('2026-10-15T09:00:00.000Z');
const TODAY = '2026-10-15';

describe('CalendarService', () => {
  let double: PrismaDouble;
  let service: CalendarService;

  beforeEach(() => {
    double = new PrismaDouble();
    service = new CalendarService(double.asPrismaService());
  });

  it('returns the holder’s reservations as contract feed entries', async () => {
    const spot = double.seedSpot({ label: 'E2.92' });
    const user = double.seedUser({ icsToken: 'valid-token' });
    const reservation = double.seedReservation({
      parkingSpotId: spot.id,
      userId: user.id,
      date: TODAY,
      createdAt: new Date('2026-09-01T08:30:00.000Z'),
    });

    await expect(service.feedEntriesForToken('valid-token', NOW)).resolves.toEqual([
      {
        reservationId: reservation.id,
        date: TODAY,
        createdAt: '2026-09-01T08:30:00.000Z',
        spotLabel: 'E2.92',
      },
    ]);
  });

  it('keeps a reservation on a hidden spot in its holder’s feed', async () => {
    const spot = double.seedSpot({ label: 'SECRET', hidden: true });
    const user = double.seedUser({ icsToken: 'hidden-holder' });
    double.seedReservation({ parkingSpotId: spot.id, userId: user.id, date: TODAY });

    await expect(service.feedEntriesForToken('hidden-holder', NOW)).resolves.toMatchObject([
      { spotLabel: 'SECRET' },
    ]);
  });

  it('returns nobody else’s reservations', async () => {
    const spot = double.seedSpot({ label: 'E2.92' });
    const other = double.seedSpot({ label: 'E2.93' });
    const mine = double.seedUser({ icsToken: 'mine' });
    const theirs = double.seedUser({ icsToken: 'theirs' });
    double.seedReservation({ parkingSpotId: spot.id, userId: mine.id, date: TODAY });
    double.seedReservation({ parkingSpotId: other.id, userId: theirs.id, date: TODAY });

    const entries = await service.feedEntriesForToken('mine', NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.spotLabel).toBe('E2.92');
  });

  it('is chronological, with the id breaking ties so the bytes are stable', async () => {
    const spotA = double.seedSpot({ label: 'A1' });
    const spotB = double.seedSpot({ label: 'B1' });
    const user = double.seedUser({ icsToken: 'valid-token' });
    // Seeded out of order on purpose.
    double.seedReservation({ parkingSpotId: spotA.id, userId: user.id, date: '2026-11-02' });
    double.seedReservation({ parkingSpotId: spotB.id, userId: user.id, date: '2026-10-20' });
    double.seedReservation({ parkingSpotId: spotA.id, userId: user.id, date: '2026-10-16' });

    const entries = await service.feedEntriesForToken('valid-token', NOW);

    expect(entries.map((entry) => entry.date)).toEqual(['2026-10-16', '2026-10-20', '2026-11-02']);
  });

  describe('the horizon', () => {
    let userId: string;

    function seedOn(date: string): void {
      const spot = double.seedSpot({ label: `S-${date}` });
      double.seedReservation({ parkingSpotId: spot.id, userId, date });
    }

    beforeEach(() => {
      userId = double.seedUser({ icsToken: 'valid-token' }).id;
    });

    it('includes the oldest day still inside the window', async () => {
      // 2026-10-15 minus 30 days.
      seedOn('2026-09-15');

      const entries = await service.feedEntriesForToken('valid-token', NOW);
      expect(entries.map((entry) => entry.date)).toEqual(['2026-09-15']);
      expect(ICS_FEED_PAST_DAYS).toBe(30);
    });

    it('drops the day one step older', async () => {
      seedOn('2026-09-14');

      await expect(service.feedEntriesForToken('valid-token', NOW)).resolves.toEqual([]);
    });

    it('has no forward bound — the reservation window is the only cap', async () => {
      seedOn('2027-06-01');

      const entries = await service.feedEntriesForToken('valid-token', NOW);
      expect(entries.map((entry) => entry.date)).toEqual(['2027-06-01']);
    });

    it('measures “today” in Europe/Prague, not in the server’s zone', async () => {
      // 22:30 UTC on 14 October is already the 15th in Prague (CEST, UTC+2),
      // so the window starts on 15 September, not on the 14th.
      const lateEvening = new Date('2026-10-14T22:30:00.000Z');
      seedOn('2026-09-14');

      await expect(service.feedEntriesForToken('valid-token', lateEvening)).resolves.toEqual([]);
    });
  });

  describe('a token that resolves to nobody', () => {
    beforeEach(() => {
      double.seedUser({ icsToken: 'valid-token' });
    });

    it('refuses an unknown token with 404, not 401', async () => {
      // 401 would confirm to somebody walking the token space that the route
      // exists and the token was merely wrong. `doc/decision/0080-*`.
      await expect(service.feedEntriesForToken('nope', NOW)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('refuses an empty token', async () => {
      await expect(service.feedEntriesForToken('', NOW)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a deactivated user’s otherwise valid token', async () => {
      double.seedUser({ icsToken: 'offboarded', active: false });

      await expect(service.feedEntriesForToken('offboarded', NOW)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('says exactly the same thing in every case', async () => {
      double.seedUser({ icsToken: 'offboarded', active: false });

      const responses = await Promise.all(
        ['nope', '', 'offboarded'].map((token) =>
          service.feedEntriesForToken(token, NOW).then(
            () => null,
            (error: NotFoundException) => error.getResponse()
          )
        )
      );

      // One distinct body across all three, and it is Nest's default — the same
      // one an unrouted path produces. A message naming the reason would be the
      // oracle the status code is careful not to be.
      expect(new Set(responses.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(responses[0]).toEqual({ statusCode: 404, message: 'Not Found' });
    });

    it('never reveals whether a token exists by doing extra work for it', async () => {
      // Both the unknown and the deactivated case must be settled by the *same*
      // single query — a post-hoc `user.active` check would have made the
      // second one measurably slower on a public URL, which is a distinguisher
      // the 404 was chosen to remove. Asserted structurally: neither path may
      // reach the reservation table, and both must issue exactly one user read.
      double.seedUser({ icsToken: 'offboarded', active: false });

      const prisma = double.asPrismaService();
      const findFirst = jest.spyOn(prisma.client.user, 'findFirst');
      const findMany = jest.spyOn(prisma.client.reservation, 'findMany');
      const spied = new CalendarService(prisma);

      for (const token of ['nope', 'offboarded']) {
        await expect(spied.feedEntriesForToken(token, NOW)).rejects.toBeInstanceOf(
          NotFoundException
        );
      }

      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  it('renders an empty feed for a user with no reservations', async () => {
    double.seedUser({ icsToken: 'valid-token' });

    await expect(service.feedEntriesForToken('valid-token', NOW)).resolves.toEqual([]);
  });
});
