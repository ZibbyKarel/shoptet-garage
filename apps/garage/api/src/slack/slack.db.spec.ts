/**
 * Slack against a real PostgreSQL and a real `@slack/web-api`.
 *
 * Two claims are made here that cannot be made anywhere else:
 *
 * 1. **A Slack failure never breaks a domain operation.** Asserted by running
 *    the *real* `ReservationsService.cancel` against a *real* database, with
 *    `SlackDomainEventPublisher` bound to a Slack that answers 500 to
 *    everything, and checking the cancellation still committed. A unit test
 *    with a stubbed publisher proves the publisher swallows; only this proves
 *    the swallowing is wired into the path a user actually takes.
 *
 * 2. **The message is sent after `COMMIT`.** The fake Slack, at the instant it
 *    receives the request, starts a read on a **second connection**. A second
 *    connection cannot see an uncommitted change, so finding the reservation
 *    already gone proves the transaction had ended before Slack was called.
 *    This is the same probe shape `reservations.db.spec.ts` uses for the seam
 *    itself, moved down to the concrete notification.
 *
 * `SlackNotificationService`'s reads are exercised here rather than against
 * `PrismaDouble` because what they do is read the database — labels, emails,
 * the day's reservations and its queue — and the double belongs to another
 * task's file set.
 */

import type { PrismaClient } from '@garage/database';
import { AuditLogService } from '../audit/audit-log.service';
import { WebClient } from '@slack/web-api';
import { toDateColumn } from '../common/prisma-mapping';
import { ReservationLimitsService } from '../reservation-limits/reservation-limits.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { ReservationPolicy } from '../reservations/reservation-policy';
import { ReservationsService } from '../reservations/reservations.service';
import { WaitlistPromotionService } from '../reservations/waitlist-promotion.service';
import type { GracefulShutdownService } from '../shutdown/graceful-shutdown.service';
import {
  FUTURE_BUSINESS_DAY,
  TODAY,
  actorFor,
  asPrismaService,
  connect,
  seedSpot,
  seedUser,
} from '../testing/database/reservation-harness';
import { SlackClient, SlackWebClientFactory } from './slack-client.service';
import { SlackDomainEventPublisher } from './slack-domain-event.publisher';
import { SlackNotificationService } from './slack-notification.service';
import type { SlackEnv } from './slack.config';
import { SlackConfig } from './slack.config';
import type { CapturedLogs } from './testing/capture-logs';
import { captureLogs } from './testing/capture-logs';
import type { SlackTestServer } from './testing/slack-test-server';
import { SLACK_OK, slackNotOk, startSlackTestServer } from './testing/slack-test-server';

const BOT_TOKEN = 'fake-slack-bot-token';
const CHANNEL = 'C0PARKING';

const SLACK_ENV: SlackEnv = {
  SLACK_ENABLED: true,
  SLACK_BOT_TOKEN: BOT_TOKEN,
  SLACK_CHANNEL_ID: CHANNEL,
  SLACK_REQUEST_TIMEOUT_MS: 500,
  SLACK_RETRY_ATTEMPTS: 1,
  SLACK_RETRY_BASE_DELAY_MS: 10,
  SLACK_DAILY_SUMMARY_AT: '08:00',
};

/** Lets the detached notifications the publisher fires actually run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe('Slack over a real database', () => {
  let client: PrismaClient;
  /** A second pool, so a read can be made that the first one's transaction cannot hide. */
  let observer: PrismaClient;
  let server: SlackTestServer;
  let logs: CapturedLogs;
  let notifications: SlackNotificationService;
  let publisher: SlackDomainEventPublisher;
  let reservations: ReservationsService;

  beforeAll(() => {
    client = connect();
    observer = connect();
  });

  afterAll(async () => {
    await client.$disconnect();
    await observer.$disconnect();
  });

  beforeEach(async () => {
    server = await startSlackTestServer();
    logs = captureLogs();

    const prismaService = asPrismaService(client);
    const factory: SlackWebClientFactory = {
      create: ({ token }) =>
        new WebClient(token, {
          slackApiUrl: server.apiUrl,
          timeout: 0,
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
          attachOriginalToWebAPIRequestError: false,
        }),
    };
    const slack = new SlackClient(SlackConfig.fromEnv(SLACK_ENV), logs.logger, factory);
    notifications = new SlackNotificationService(prismaService, slack, logs.logger);
    publisher = new SlackDomainEventPublisher(notifications, logs.logger, {
      registerCloser: () => undefined,
    } as unknown as GracefulShutdownService);

    const audit = new AuditLogService(prismaService);
    reservations = new ReservationsService(
      prismaService,
      new ReservationWindowService(prismaService, audit),
      new ReservationPolicy(),
      new WaitlistPromotionService(audit),
      audit,
      publisher,
      new ReservationLimitsService(prismaService, audit)
    );
  });

  afterEach(async () => {
    await server.close();
  });

  /** The decoded `text` of the nth `chat.postMessage` the SDK sent. */
  function sentText(index = 0): string {
    const request = server.requests[index];
    if (request === undefined) {
      throw new Error(`No Slack request #${index}; only ${server.requests.length} were sent`);
    }
    return new URLSearchParams(request.body).get('text') ?? '';
  }

  function sentChannel(index = 0): string {
    const request = server.requests[index];
    if (request === undefined) {
      throw new Error(`No Slack request #${index}`);
    }
    return new URLSearchParams(request.body).get('channel') ?? '';
  }

  describe('notifySpotFreed', () => {
    it('posts the spot’s real label, in Czech, to the configured channel', async () => {
      server.respondWith(() => SLACK_OK);
      const spot = await seedSpot(client, { labelPrefix: 'FREED' });

      await expect(
        notifications.notifySpotFreed({
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          reservationId: 'r-does-not-matter',
        })
      ).resolves.toBe('delivered');

      expect(sentChannel()).toBe(CHANNEL);
      expect(sentText()).toBe(
        `Uvolnilo se parkovací místo ${spot.label} na pondělí 5. ledna 2099. Je volné pro kohokoli.`
      );
    });

    it('sends nothing to the channel for a hidden spot', async () => {
      server.respondWith(() => SLACK_OK);
      const spot = await seedSpot(client, { labelPrefix: 'SECRET', hidden: true });

      await expect(
        notifications.notifySpotFreed({
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          reservationId: 'r-hidden',
        })
      ).resolves.toBe('skipped');

      expect(server.requests).toHaveLength(0);
    });

    it('sends nothing when the spot no longer exists', async () => {
      await expect(
        notifications.notifySpotFreed({
          parkingSpotId: '01930000-0000-7000-8000-000000000000',
          date: FUTURE_BUSINESS_DAY,
          reservationId: 'r-1',
        })
      ).resolves.toBe('skipped');

      expect(server.requests).toHaveLength(0);
    });
  });

  describe('notifyWaitlistPromotion', () => {
    it('looks the person up by the email the database holds, then DMs that user id', async () => {
      const user = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'PROMO' });
      server.respondWith((attempt) =>
        attempt === 1 ? { status: 200, body: { ok: true, user: { id: 'U0JAN' } } } : SLACK_OK
      );

      await expect(
        notifications.notifyWaitlistPromotion({
          userId: user.id,
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          reservationId: 'r-1',
        })
      ).resolves.toBe('delivered');

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]?.url).toContain('users.lookupByEmail');
      expect(new URLSearchParams(server.requests[0]?.body).get('email')).toBe(user.email);
      // The DM goes to the Slack user id, never to the shared channel.
      expect(sentChannel(1)).toBe('U0JAN');
      expect(sentText(1)).toBe(
        `Máte parkovací místo ${spot.label} na pondělí 5. ledna 2099. Uvolnilo se a byli jste první ve frontě.`
      );
    });

    it('skips quietly when the person has no Slack account', async () => {
      const user = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'NOSLACK' });
      server.respondWith(() => slackNotOk('users_not_found'));

      await expect(
        notifications.notifyWaitlistPromotion({
          userId: user.id,
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          reservationId: 'r-1',
        })
      ).resolves.toBe('skipped');

      // The lookup was tried; no message followed it.
      expect(server.requests).toHaveLength(1);
    });

    it('never writes the person’s email to the log', async () => {
      const user = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'PRIV' });
      server.respondWith(() => slackNotOk('users_not_found'));

      await notifications.notifyWaitlistPromotion({
        userId: user.id,
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
        reservationId: 'r-1',
      });

      expect(logs.raw()).not.toContain(user.email);
      expect(logs.raw()).not.toContain(BOT_TOKEN);
    });
  });

  describe('postDailySummary', () => {
    it('counts the day from the database and lists the free spots by label', async () => {
      server.respondWith(() => SLACK_OK);
      const holder = await seedUser(client);
      const waiter = await seedUser(client);
      const taken = await seedSpot(client, { labelPrefix: 'TAKEN' });
      const blocked = await seedSpot(client, { labelPrefix: 'BLOCKED' });
      const free = await seedSpot(client, { labelPrefix: 'FREE' });
      const secret = await seedSpot(client, { labelPrefix: 'SECRET', hidden: true });
      const day = '2099-02-02';
      await client.reservation.create({
        data: {
          parkingSpotId: taken.id,
          userId: holder.id,
          date: new Date(`${day}T00:00:00.000Z`),
        },
      });
      // A guest time block (`doc/decision/0314-*`) has no `Reservation` row
      // at all, so the digest must not count this spot free either.
      await client.timedReservation.create({
        data: {
          parkingSpotId: blocked.id,
          date: new Date(`${day}T00:00:00.000Z`),
          startMinute: 9 * 60,
          endMinute: 10 * 60,
          guestName: 'Guest',
        },
      });
      await client.waitlistEntry.create({
        data: {
          parkingSpotId: taken.id,
          userId: waiter.id,
          date: new Date(`${day}T00:00:00.000Z`),
        },
      });

      await expect(notifications.postDailySummary(day)).resolves.toBe('delivered');

      // Compared against the database rather than a magic number: the suites
      // share one database and seed as they go.
      const activeSpots = await observer.parkingSpot.count({
        where: { active: true, hidden: false },
      });
      const text = sentText();
      expect(text).toContain('Parkování — pondělí 2. února 2099');
      expect(text).toContain(`z ${activeSpots}:`);
      expect(text).toContain(free.label);
      expect(text).not.toContain(taken.label);
      expect(text).not.toContain(blocked.label);
      expect(text).not.toContain(secret.label);
      expect(text).toContain('Ve frontě čeká 1 člověk.');
    });
  });

  describe('a cancellation while Slack is broken', () => {
    it('still commits, still answers the user, and only logs the Slack failure', async () => {
      server.respondWith(() => ({ status: 500, body: { ok: false, error: 'internal_error' } }));
      const user = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'BROKEN' });
      const reservation = await client.reservation.create({
        data: {
          parkingSpotId: spot.id,
          userId: user.id,
          date: new Date(`${FUTURE_BUSINESS_DAY}T00:00:00.000Z`),
        },
      });

      await expect(
        reservations.cancel({ reservationId: reservation.id }, actorFor(user))
      ).resolves.toMatchObject({ promoted: false, reservationId: reservation.id });

      // The domain operation is done and durable …
      await expect(observer.reservation.count({ where: { id: reservation.id } })).resolves.toBe(0);

      await flush();
      // … and Slack was tried and failed, without anybody hearing about it.
      expect(server.requests.length).toBeGreaterThanOrEqual(1);
      expect(logs.lines().some((line) => line['message'] === 'Slack call failed')).toBe(true);
    });

    it('does not throw out of the publisher even when Slack never answers', async () => {
      server.respondWith(() => 'hang');
      const user = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'HANG' });
      const reservation = await client.reservation.create({
        data: {
          parkingSpotId: spot.id,
          userId: user.id,
          date: new Date(`${FUTURE_BUSINESS_DAY}T00:00:00.000Z`),
        },
      });

      await expect(
        reservations.cancel({ reservationId: reservation.id }, actorFor(user))
      ).resolves.toMatchObject({ promoted: false });

      // The per-attempt timeout has to expire before the failure is logged; the
      // cancellation above did not wait for it, which is the point.
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(logs.lines().some((line) => line['message'] === 'Slack call failed')).toBe(true);
    });
  });

  describe('a cancellation that promotes someone off the waitlist', () => {
    it('sends the freed-spot notice nowhere and DMs the promoted user instead, end to end', async () => {
      // The gap this closes (review finding M6): every other cancellation spec
      // in this file resolves `promoted: false`. This is the only one that
      // drives `ReservationsService.cancel` through a *real* promotion and
      // checks the wiring all the way to the wire —
      // `SlackDomainEventPublisher.notifyPromotions` →
      // `SlackNotificationService.notifyWaitlistPromotion` →
      // `SlackClient.postDirectMessage` — rather than stopping at the unit
      // spec's stubbed `notifications` object.
      const holder = await seedUser(client);
      const waiter = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'PROMOTED' });
      const reservation = await client.reservation.create({
        data: {
          parkingSpotId: spot.id,
          userId: holder.id,
          date: new Date(`${FUTURE_BUSINESS_DAY}T00:00:00.000Z`),
        },
      });
      await client.waitlistEntry.create({
        data: {
          parkingSpotId: spot.id,
          userId: waiter.id,
          date: toDateColumn(FUTURE_BUSINESS_DAY),
        },
      });
      server.respondWith((attempt) =>
        attempt === 1 ? { status: 200, body: { ok: true, user: { id: 'U0WAITER' } } } : SLACK_OK
      );

      await expect(
        reservations.cancel({ reservationId: reservation.id }, actorFor(holder))
      ).resolves.toMatchObject({ promoted: true });
      await flush();

      // No freed-spot notice to the channel — the queue took it immediately.
      expect(server.requests.some((r) => r.url.includes('chat.postMessage'))).toBe(true);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]?.url).toContain('users.lookupByEmail');
      expect(new URLSearchParams(server.requests[0]?.body).get('email')).toBe(waiter.email);
      expect(sentChannel(1)).toBe('U0WAITER');
      expect(sentText(1)).toBe(
        `Máte parkovací místo ${spot.label} na pondělí 5. ledna 2099. Uvolnilo se a byli jste první ve frontě.`
      );

      // The waiter now holds the reservation the holder gave up.
      await expect(
        observer.reservation.findFirst({ where: { parkingSpotId: spot.id, userId: waiter.id } })
      ).resolves.not.toBeNull();
    });
  });

  describe('the message is sent after COMMIT', () => {
    it('finds the cancellation already visible on a second connection', async () => {
      const user = await seedUser(client);
      const spot = await seedSpot(client, { labelPrefix: 'ORDER' });
      const reservation = await client.reservation.create({
        data: {
          parkingSpotId: spot.id,
          userId: user.id,
          date: new Date(`${FUTURE_BUSINESS_DAY}T00:00:00.000Z`),
        },
      });

      // Started at the moment Slack is called, on a pool the transaction has
      // no hold over. An uncommitted delete would still show the row here.
      let probe: Promise<number> | undefined;
      server.respondWith(() => {
        probe ??= observer.reservation.count({ where: { id: reservation.id } });
        return SLACK_OK;
      });

      await reservations.cancel({ reservationId: reservation.id }, actorFor(user));
      await flush();

      expect(probe).toBeDefined();
      await expect(probe).resolves.toBe(0);
    });
  });

  describe('with Slack disabled', () => {
    it('runs the whole path and sends nothing', async () => {
      const disabled = new SlackClient(
        SlackConfig.fromEnv({
          ...SLACK_ENV,
          SLACK_ENABLED: false,
          SLACK_BOT_TOKEN: undefined,
          SLACK_CHANNEL_ID: undefined,
        }),
        logs.logger,
        {
          create: ({ token }) => new WebClient(token, { slackApiUrl: server.apiUrl, timeout: 0 }),
        }
      );
      const spot = await seedSpot(client, { labelPrefix: 'OFF' });

      await expect(
        new SlackNotificationService(
          asPrismaService(client),
          disabled,
          logs.logger
        ).notifySpotFreed({
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          reservationId: 'r-1',
        })
      ).resolves.toBe('disabled');

      // The database read still happened — the copy is still built and would
      // still crash here if it were broken — but nothing left the process.
      expect(server.requests).toHaveLength(0);
    });
  });

  it('uses a day far enough ahead that the reservation window is open', () => {
    // Guards the fixtures rather than the code: every test above cancels or
    // summarises `FUTURE_BUSINESS_DAY`, and a `TODAY` that had drifted past it
    // would turn these into vacuous passes.
    expect(FUTURE_BUSINESS_DAY > TODAY).toBe(true);
  });

  describe('a guest reservation is cancelled', () => {
    it('still DMs the promoted waiter, and never names the guest', async () => {
      // The DM names the person being *given* the spot (`notice.userId`), never
      // the previous holder, so a guest having no user row changes nothing about
      // it. Asserted because "it happens to work" and "it is guaranteed to work"
      // are different states.
      const [admin, waiter] = [await seedUser(client), await seedUser(client)];
      const spot = await seedSpot(client, { labelPrefix: 'GUEST' });
      const adminActor = actorFor(admin, 'ADMIN');

      const reservation = await reservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: null },
        },
        adminActor,
        TODAY
      );
      await client.waitlistEntry.create({
        data: {
          parkingSpotId: spot.id,
          userId: waiter.id,
          date: toDateColumn(FUTURE_BUSINESS_DAY),
        },
      });
      // Request 0 is `users.lookupByEmail`, request 1 the DM — same two-step
      // shape as the existing end-to-end case, which is why the assertions read
      // index 1.
      server.respondWith((attempt) =>
        attempt === 1 ? { status: 200, body: { ok: true, user: { id: 'U0WAITER' } } } : SLACK_OK
      );

      await expect(
        reservations.cancel({ reservationId: reservation.id }, adminActor)
      ).resolves.toMatchObject({ promoted: true });
      await flush();

      expect(server.requests).toHaveLength(2);
      expect(new URLSearchParams(server.requests[0]?.body).get('email')).toBe(waiter.email);
      expect(sentChannel(1)).toBe('U0WAITER');
      expect(sentText(1)).toContain(spot.label);
      // The guest's name is not the promoted person's business, and was never
      // read to build this message.
      expect(sentText(1)).not.toContain('Jan Host');

      // The waiter now holds what the guest gave up — and it is a user row again.
      await expect(
        observer.reservation.findFirst({ where: { parkingSpotId: spot.id, userId: waiter.id } })
      ).resolves.not.toBeNull();
    });
  });
});
