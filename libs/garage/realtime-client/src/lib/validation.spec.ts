/**
 * The parsing layer on its own, and the property that matters most about it:
 * it is driven by the contract's registry, so it cannot fall behind the
 * contract.
 */

import { readFileSync } from 'node:fs';
import {
  CLIENT_TO_SERVER_ACK_SCHEMAS,
  SERVER_TO_CLIENT_EVENT_SCHEMAS,
} from '@garage/contract/realtime';
import type { ServerToClientEventName } from '@garage/contract/realtime';
import { DATE, SPOT_ID, USER_SUMMARY } from '../__fixtures__/realtime-fixtures';
import { parseAck, parseServerEvent } from './validation';

const TIMESTAMP = '2026-09-15T08:00:00.000Z';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const cellRef = { date: DATE, parkingSpotId: SPOT_ID };

const publicReservation = {
  id: RESERVATION_ID,
  date: DATE,
  parkingSpotId: SPOT_ID,
  holder: {
    kind: 'USER',
    userId: USER_SUMMARY.id,
    name: USER_SUMMARY.name,
    licensePlate: USER_SUMMARY.licensePlate,
  },
  createdAt: TIMESTAMP,
};

/**
 * One valid payload per registered event.
 *
 * `Record<ServerToClientEventName, unknown>` is what makes this exhaustive:
 * adding an event to the contract stops this file compiling until a payload
 * for it appears here, so the "every event is parsed" test below can never
 * quietly cover fewer events than the contract declares.
 */
const validPayloads: Record<ServerToClientEventName, unknown> = {
  'cell:locked': { ...cellRef, lockedBy: USER_SUMMARY, expiresAt: TIMESTAMP },
  'cell:unlocked': cellRef,
  'reservation:created': { ...cellRef, reservation: publicReservation },
  'reservation:cancelled': { ...cellRef, reservationId: RESERVATION_ID },
  'reservation:reassigned': {
    ...cellRef,
    cause: 'WAITLIST_PROMOTION',
    previousReservationId: RESERVATION_ID,
    reservation: publicReservation,
    fromWaitlistEntryId: null,
  },
  'waitlist:updated': { ...cellRef, waitlistCount: 2 },
  'timed-reservations:updated': {
    ...cellRef,
    timedReservations: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        startTime: '08:00',
        endTime: '09:00',
        guestName: 'Guest',
        licensePlate: null,
        createdAt: TIMESTAMP,
      },
    ],
  },
};

const eventNames = Object.keys(SERVER_TO_CLIENT_EVENT_SCHEMAS) as ServerToClientEventName[];

describe('parseServerEvent', () => {
  it.each(eventNames)('accepts a valid %s payload', (event) => {
    const result = parseServerEvent(event, validPayloads[event]);
    expect(result.ok).toBe(true);
  });

  it.each(eventNames)('rejects a %s payload that is not an object at all', (event) => {
    const result = parseServerEvent(event, 'nonsense');
    expect(result.ok).toBe(false);
  });

  it.each(eventNames)('rejects a %s payload with a broken cell reference', (event) => {
    // Every server → client payload extends `cellRefSchema`, so this is the
    // one field that must be checked on all of them.
    const payload = { ...(validPayloads[event] as object), parkingSpotId: 'not-a-uuid' };
    const result = parseServerEvent(event, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.event).toBe(event);
      expect(result.report.issues).toEqual(['parkingSpotId: Invalid UUID']);
    }
  });

  it('reports the path and the message, and nothing from the payload', () => {
    const result = parseServerEvent('cell:locked', {
      ...cellRef,
      lockedBy: { ...USER_SUMMARY, id: 'not-a-uuid' },
      expiresAt: 'whenever',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.issues).toEqual([
        'lockedBy.id: Invalid UUID',
        'expiresAt: Invalid ISO datetime',
      ]);
      // No user names, no plate, no raw payload — the report is safe to log.
      expect(JSON.stringify(result.report)).not.toContain(USER_SUMMARY.name);
    }
  });
});

describe('parseAck', () => {
  it('accepts an acquired hold', () => {
    const result = parseAck('cell:lock', { result: 'ACQUIRED', expiresAt: TIMESTAMP });
    expect(result).toEqual({ ok: true, data: { result: 'ACQUIRED', expiresAt: TIMESTAMP } });
  });

  it('accepts a hold somebody else has', () => {
    const result = parseAck('cell:lock', {
      result: 'HELD_BY_OTHER',
      lockedBy: USER_SUMMARY,
      expiresAt: TIMESTAMP,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown result rather than falling through to a branch', () => {
    const result = parseAck('cell:lock', { result: 'MAYBE', expiresAt: TIMESTAMP });
    expect(result.ok).toBe(false);
  });

  it('rejects an acquired hold with no usable expiry', () => {
    // Unparsed, `Date.parse('soon')` is `NaN` and the heartbeat timer fires
    // immediately, forever.
    const result = parseAck('cell:lock', { result: 'ACQUIRED', expiresAt: 'soon' });
    expect(result.ok).toBe(false);
  });

  it('covers every command the contract says answers with an ack', () => {
    expect(Object.keys(CLIENT_TO_SERVER_ACK_SCHEMAS)).toEqual(['cell:lock']);
  });
});

describe('the wrapper surface', () => {
  it('needs no direct socket.io-client import to do any of this', () => {
    // The file's own import list is the claim; reading it back makes the claim
    // self-checking rather than something a reviewer has to take on faith
    // (same device as `libs/shared/form/src/lib/app-form.spec.tsx`).
    //
    // It demonstrates the wrapper's API is *sufficient*; it is **not** the
    // defence against the ban being broken. This file is inside the lib that
    // owns `socket.io-client` — the import is legal here, and `__fixtures__/
    // offline-transport.ts` two directories away makes it, correctly. The ban
    // is `no-restricted-imports` in `eslint.config.mjs` (`WRAPPED_LIBRARIES`),
    // verified separately by linting `apps/**`; delete that rule and this test
    // still passes.
    const source = readFileSync(__filename, 'utf-8');
    expect(source).not.toMatch(/from ['"]socket\.io-client['"]/);
    expect(source).not.toMatch(/require\(['"]socket\.io-client['"]\)/);
  });
});
