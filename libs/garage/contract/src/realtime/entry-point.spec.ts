/**
 * The entry point is only real if consumers can name it.
 *
 * `src/realtime/index.ts` existing proves nothing on its own — the path alias in
 * `tsconfig.base.json` is what turns it into `@garage/contract/realtime`, and
 * a missing or misspelt alias would first surface in Task 15 or Task 24.
 *
 * This file cannot simply `import '@garage/contract/realtime'`: a project may
 * not reach its own sources through its own alias
 * (`@nx/enforce-module-boundaries`, and rightly — that is how import cycles get
 * laundered). So it checks the alias declaration itself, and pins the module it
 * points at to the one imported relatively here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as realtimeEntry from './index';

const WORKSPACE_ROOT = resolve(__dirname, '../../../../..');

const paths = (
  JSON.parse(readFileSync(resolve(WORKSPACE_ROOT, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  }
).compilerOptions.paths;

describe('@garage/contract/realtime', () => {
  it('is declared as a path alias of its own', () => {
    expect(paths['@garage/contract/realtime']).toEqual([
      './libs/garage/contract/src/realtime/index.ts',
    ]);
  });

  it('points at a file that exists and is this module', () => {
    const target = resolve(WORKSPACE_ROOT, paths['@garage/contract/realtime']?.[0] as string);
    expect(target).toBe(resolve(__dirname, 'index.ts'));
    expect(readFileSync(target, 'utf8')).toContain("export * from './rooms'");
  });

  it('is a second entry point, not a replacement for the first', () => {
    expect(paths['@garage/contract']).toEqual(['./libs/garage/contract/src/index.ts']);
  });

  it('exports the event registries, the payload schemas and the room helper', () => {
    // Pinned, so removing something from the public surface is a deliberate act.
    expect(Object.keys(realtimeEntry).sort()).toEqual(
      [
        'CLIENT_TO_SERVER_ACK_SCHEMAS',
        'CLIENT_TO_SERVER_EVENT_SCHEMAS',
        'DAY_ROOM_PREFIX',
        'SERVER_TO_CLIENT_EVENT_SCHEMAS',
        'SOCKET_IO_PATH',
        'cellLockAckSchema',
        'cellLockCommandSchema',
        'cellLockResultSchema',
        'cellLockedEventSchema',
        'cellRefSchema',
        'cellUnlockedEventSchema',
        'dayRoomCommandSchema',
        'reservationCancelledEventSchema',
        'reservationCreatedEventSchema',
        'reservationReassignCauseSchema',
        'reservationReassignedEventSchema',
        'roomForDate',
        'timedReservationsUpdatedEventSchema',
        'waitlistUpdatedEventSchema',
      ].sort()
    );
  });

  it('exports no oRPC procedure or router', () => {
    // The two entry points are disjoint in what they carry, not just in which
    // files they live in.
    for (const name of Object.keys(realtimeEntry)) {
      expect([name, name.toLowerCase().includes('contract')]).toEqual([name, false]);
    }
  });
});
