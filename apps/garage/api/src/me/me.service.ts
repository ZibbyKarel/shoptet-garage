/**
 * The caller's own profile and settings.
 *
 * Three procedures, and the one thing they have in common is that the subject is
 * always `context.user` — never an id from the payload. That is why none of the
 * inputs carries a user id: there is no shape of request that could ask this
 * service about somebody else.
 */

import { Injectable } from '@nestjs/common';
import type { MyProfile, UpdateMySettingsInput } from '@garage/contract';
import type { Prisma, User as UserRow } from '@garage/database';
import { AuditLogService } from '../audit/audit-log.service';
import { generateIcsToken } from '../auth/auth-user.service';
import { DomainError } from '../common/errors/domain-error';
import { isUniqueConstraintViolation } from '../common/errors/prisma-error-mapping';
import { toContractUser } from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';

/**
 * How many times a fresh `icsToken` is retried after a unique-constraint
 * collision.
 *
 * The contract deliberately declares **no** error on `me.regenerateIcsToken`
 * (`doc/decision/0021-*`): a collision between two 32-byte random values is not
 * a state a client can act on, it is an instruction to retry, and the UI has no
 * copy for it. So the retry happens here. Three attempts, for the same reason
 * `AuthUserService` bounds its provisioning loop: an unresolvable P2002 must
 * surface as an error rather than as a hang.
 */
export const MAX_ICS_TOKEN_ATTEMPTS = 3;

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService
  ) {}

  async getProfile(userId: string): Promise<MyProfile> {
    return toContractUser(await this.requireUser(userId));
  }

  /**
   * Applies the contract's three-valued update: absent leaves the field alone,
   * `null` clears it, a value sets it.
   *
   * `input.licensePlate !== undefined` is what tells "absent" from "clear":
   * Zod's `.optional()` leaves an absent key out of the parsed object entirely,
   * and JSON has no way to transmit `undefined`, so `null` is unambiguous.
   */
  async updateSettings(input: UpdateMySettingsInput, userId: string): Promise<MyProfile> {
    const existing = await this.requireUser(userId);

    if (input.preferredParkingSpotId !== undefined && input.preferredParkingSpotId !== null) {
      await this.requireSelectableSpot(input.preferredParkingSpotId);
    }

    const data: Prisma.UserUpdateInput = {
      ...(input.licensePlate === undefined ? {} : { licensePlate: input.licensePlate }),
      ...(input.preferredParkingSpotId === undefined
        ? {}
        : {
            preferredParkingSpot:
              input.preferredParkingSpotId === null
                ? { disconnect: true }
                : { connect: { id: input.preferredParkingSpotId } },
          }),
    };

    const row = await this.prisma.client.user.update({ where: { id: userId }, data });

    // The `payload` shape is fixed per action by `../audit/audit-payloads.ts`.
    await this.audit.record({
      actorUserId: userId,
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: userId,
      payload: {
        change: 'settings',
        before: {
          licensePlate: existing.licensePlate,
          preferredParkingSpotId: existing.preferredParkingSpotId,
        },
        after: {
          licensePlate: row.licensePlate,
          preferredParkingSpotId: row.preferredParkingSpotId,
        },
      },
    });

    return toContractUser(row);
  }

  /**
   * Issues a new ICS feed token, invalidating the old feed URL immediately.
   *
   * The audit entry records **that** it was regenerated and never the token
   * itself: the token is the only credential on the personal calendar feed, and
   * an append-only table nobody can redact is the worst possible place for it.
   */
  async regenerateIcsToken(userId: string): Promise<string> {
    let lastConflict: unknown;

    for (let attempt = 1; attempt <= MAX_ICS_TOKEN_ATTEMPTS; attempt += 1) {
      const icsToken = generateIcsToken();
      try {
        const row = await this.prisma.client.user.update({
          where: { id: userId },
          data: { icsToken },
        });

        await this.audit.record({
          actorUserId: userId,
          action: 'USER_UPDATED',
          entityType: 'User',
          entityId: userId,
          payload: { change: 'ics-token-regenerated', attempt },
        });

        return row.icsToken;
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) {
          throw error;
        }
        lastConflict = error;
      }
    }

    // Unreachable in practice at 2^256 possibilities. Rethrowing the real P2002
    // rather than inventing a contract error keeps it a 500 with a stack in the
    // log, which is what an impossible outcome should look like.
    throw lastConflict instanceof Error
      ? lastConflict
      : new Error('Could not issue a unique ICS token.');
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (user === null) {
      // The caller is authenticated, so their row existed a moment ago. Reaching
      // here means it was deleted mid-request — which this application never
      // does (offboarding deactivates). Reported as `NOT_FOUND` rather than
      // crashed on, because the client can do nothing else with it either.
      throw new DomainError('NOT_FOUND', { message: 'No such user.' });
    }
    return user;
  }

  /**
   * A preferred spot must exist and be visible (`NOT_FOUND`) and be active
   * (`VALIDATION_FAILED`).
   *
   * The two are separate codes because they are separate situations for the
   * person at the screen: an id that does not exist is a stale client, while a
   * retired spot is a real spot they can see was taken out of service. A
   * hidden spot answers as a missing one: bulk booking never assigns it, and
   * to a normal user it does not exist (`doc/decision/0316-*`).
   */
  private async requireSelectableSpot(spotId: string): Promise<void> {
    const spot = await this.prisma.client.parkingSpot.findUnique({ where: { id: spotId } });

    if (spot === null || spot.hidden) {
      throw new DomainError('NOT_FOUND', { message: 'No such parking spot.' });
    }
    if (!spot.active) {
      throw new DomainError('VALIDATION_FAILED', {
        message: 'A retired parking spot cannot be a preferred spot.',
        details: { parkingSpotId: spotId },
      });
    }
  }
}
