/**
 * The init migration is the only artefact that states the constraints the
 * reservation flow depends on, and it cannot be regenerated from
 * `schema.prisma` alone — the singleton CHECK, the range CHECK and the
 * append-only trigger are hand-written on the end of it.
 *
 * Without a database these can still be asserted as SQL: what follows is not a
 * test of the schema file's prose but of the exact DDL that will be executed.
 * Every constraint the brief lists appears here by name.
 *
 * ## Every migration, not just the first
 *
 * This file used to read `directories[0]` and stop. That was right when there
 * was one migration; there are three, and the two `audit_*` files had no test
 * of any kind — nothing asserted they were additive, and nothing would have
 * noticed a `DROP COLUMN` in a fourth. The final review raised it as I-4.
 *
 * The suite now reads all of them: the init one is asserted statement by
 * statement as before, and every *subsequent* one has to be additive. The last
 * describe block closes the other half of the same gap (I-3) without needing a
 * database — it reconciles the enum members the migrations actually produce
 * against the ones `schema.prisma` declares, which is the only place the two
 * artefacts were previously allowed to drift in silence.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const SCHEMA_PATH = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

/** Migration directory names, in the order Prisma applies them. */
function migrationDirectories(): readonly string[] {
  const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) {
    throw new Error(`No migration directory found in ${MIGRATIONS_DIR}`);
  }
  return directories;
}

function readMigration(directory: string): string {
  return readFileSync(join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8');
}

const MIGRATION_DIRECTORIES = migrationDirectories();
const INIT_DIRECTORY = MIGRATION_DIRECTORIES[0];
if (INIT_DIRECTORY === undefined) {
  throw new Error(`No migration directory found in ${MIGRATIONS_DIR}`);
}
const LATER_DIRECTORIES = MIGRATION_DIRECTORIES.slice(1);

const sql = readMigration(INIT_DIRECTORY);

/** Collapses whitespace so assertions do not depend on line wrapping. */
const flat = sql.replace(/\s+/g, ' ');

/**
 * SQL with `--` line comments removed.
 *
 * The `audit_*` migrations explain themselves at length, and both explanations
 * contain the words `DROP` and `ALTER TYPE` while describing what they are
 * *not* doing. Asserting on the comments would be asserting on prose.
 */
function statementsOnly(migrationSql: string): string {
  return migrationSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('init migration — tables and enums', () => {
  it.each(['ParkingGroup', 'UserRole', 'ReservationLockMode', 'AuditLogAction'])(
    'creates the %s enum type',
    (enumName) => {
      expect(sql).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    }
  );

  it.each([
    'User',
    'ParkingSpot',
    'Reservation',
    'WaitlistEntry',
    'AuditLog',
    'ReservationWindowSettings',
  ])('creates the %s table', (table) => {
    expect(sql).toContain(`CREATE TABLE "${table}"`);
  });
});

describe('init migration — date-only columns', () => {
  // A timestamp here would silently reintroduce the timezone bugs Task 3 spent
  // its whole test suite eliminating.
  it.each(['Reservation', 'WaitlistEntry'])('%s.date is DATE, not a timestamp', (table) => {
    const createTable = flat.match(new RegExp(`CREATE TABLE "${table}" \\((.*?)\\);`))?.[1];
    expect(createTable).toBeDefined();
    expect(createTable).toContain('"date" DATE NOT NULL');
    expect(createTable).not.toMatch(/"date" TIMESTAMP/);
  });
});

describe('init migration — uniqueness that makes double-booking impossible', () => {
  it('one reservation per spot and day', () => {
    // Task 10 maps this constraint's P2002 onto SPOT_ALREADY_RESERVED.
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "Reservation_parkingSpotId_date_key" ON "Reservation"("parkingSpotId", "date")'
    );
  });

  it('one reservation per user and day', () => {
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "Reservation_userId_date_key" ON "Reservation"("userId", "date")'
    );
  });

  it('one waitlist entry per spot, user and day', () => {
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "WaitlistEntry_parkingSpotId_userId_date_key" ON "WaitlistEntry"("parkingSpotId", "userId", "date")'
    );
  });

  it.each([
    ['User_email_key', '"User"("email")'],
    ['User_oktaId_key', '"User"("oktaId")'],
    ['User_icsToken_key', '"User"("icsToken")'],
    ['ParkingSpot_label_key', '"ParkingSpot"("label")'],
  ])('%s is unique', (indexName, target) => {
    expect(flat).toContain(`CREATE UNIQUE INDEX "${indexName}" ON ${target}`);
  });
});

describe('init migration — indexes', () => {
  it.each([
    ['Reservation_date_idx', '"Reservation"("date")'],
    ['WaitlistEntry_date_idx', '"WaitlistEntry"("date")'],
  ])('%s covers the per-day lookup', (indexName, target) => {
    expect(flat).toContain(`CREATE INDEX "${indexName}" ON ${target}`);
  });

  it('the waitlist queue order is indexed', () => {
    expect(flat).toContain(
      'CREATE INDEX "WaitlistEntry_parkingSpotId_date_createdAt_id_idx" ON "WaitlistEntry"("parkingSpotId", "date", "createdAt", "id")'
    );
  });
});

describe('init migration — foreign keys', () => {
  it('User.preferredParkingSpotId is nullable and set to NULL when a spot is deleted', () => {
    expect(flat).toContain('"preferredParkingSpotId" UUID,');
    expect(flat).toContain(
      'ALTER TABLE "User" ADD CONSTRAINT "User_preferredParkingSpotId_fkey" FOREIGN KEY ("preferredParkingSpotId") REFERENCES "ParkingSpot"("id") ON DELETE SET NULL'
    );
  });

  it.each([
    ['Reservation_parkingSpotId_fkey'],
    ['Reservation_userId_fkey'],
    ['WaitlistEntry_parkingSpotId_fkey'],
    ['WaitlistEntry_userId_fkey'],
    ['AuditLog_actorUserId_fkey'],
  ])('%s restricts deletion of the referenced row', (constraintName) => {
    expect(flat).toMatch(
      new RegExp(`ADD CONSTRAINT "${constraintName}" FOREIGN KEY [^;]*ON DELETE RESTRICT`)
    );
  });
});

describe('init migration — hand-written constraints', () => {
  it('enforces the ReservationWindowSettings singleton with a CHECK on the primary key', () => {
    expect(flat).toContain(
      'ADD CONSTRAINT "ReservationWindowSettings_singleton_check" CHECK ("id" = 1)'
    );
    expect(flat).toContain('CONSTRAINT "ReservationWindowSettings_pkey" PRIMARY KEY ("id")');
  });

  it('bounds openDaysBefore the way the contract does', () => {
    expect(flat).toContain(
      'ADD CONSTRAINT "ReservationWindowSettings_openDaysBefore_range_check" CHECK ("openDaysBefore" BETWEEN 1 AND 31)'
    );
  });

  it('seeds the singleton row so the table is never empty', () => {
    expect(flat).toContain('INSERT INTO "ReservationWindowSettings"');
    expect(flat).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('makes AuditLog append-only with a BEFORE UPDATE OR DELETE trigger', () => {
    expect(flat).toContain('CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON');
    expect(flat).toContain('"AuditLog" FOR EACH ROW EXECUTE FUNCTION "auditlog_reject_mutation"()');
    expect(flat).toContain('RAISE EXCEPTION');
  });

  it('also seals TRUNCATE, which row-level triggers do not see', () => {
    // Without this statement-level trigger a single `TRUNCATE "AuditLog";`
    // would erase the entire audit trail — the only record that a hard-deleted
    // reservation ever existed.
    expect(flat).toContain('CREATE TRIGGER "AuditLog_append_only_truncate" BEFORE TRUNCATE ON');
    expect(flat).toContain(
      '"AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION "auditlog_reject_mutation"()'
    );
  });
});

describe('init migration — column types the contract depends on', () => {
  it('AuditLog.payload is JSONB, not TEXT or JSON', () => {
    // `schema-contract-parity.spec.ts` defers the "JSONB NOT NULL" claim here,
    // because Prisma's `Json` type cannot express the distinction.
    const createTable = flat.match(/CREATE TABLE "AuditLog" \((.*?)\);/)?.[1];
    expect(createTable).toBeDefined();
    expect(createTable).toContain('"payload" JSONB NOT NULL');
    expect(createTable).not.toMatch(/"payload" (TEXT|JSON\b)/);
  });

  it.each(['User', 'ParkingSpot', 'Reservation', 'WaitlistEntry', 'AuditLog'])(
    '%s.id is UUID (decision 0025 — UUID v7 primary keys)',
    (table) => {
      const createTable = flat.match(new RegExp(`CREATE TABLE "${table}" \\((.*?)\\);`))?.[1];
      expect(createTable).toBeDefined();
      expect(createTable).toContain('"id" UUID NOT NULL');
    }
  );

  it('ReservationWindowSettings.id is the INTEGER singleton key, not a UUID', () => {
    const createTable = flat.match(/CREATE TABLE "ReservationWindowSettings" \((.*?)\);/)?.[1];
    expect(createTable).toBeDefined();
    expect(createTable).toContain('"id" INTEGER NOT NULL DEFAULT 1');
  });
});

describe('reservation-limit-settings migration — hand-written constraints', () => {
  const limitsSql = readMigration('20260917120000_reservation_limit_settings').replace(/\s+/g, ' ');

  it('creates the table with the singleton primary key', () => {
    expect(limitsSql).toContain('CREATE TABLE "ReservationLimitSettings"');
    expect(limitsSql).toContain('CONSTRAINT "ReservationLimitSettings_pkey" PRIMARY KEY ("id")');
  });

  it('enforces the singleton with a CHECK on the primary key, like the window settings', () => {
    expect(limitsSql).toContain(
      'ADD CONSTRAINT "ReservationLimitSettings_singleton_check" CHECK ("id" = 1)'
    );
  });

  it('bounds monthlyReservationCap the way the contract does', () => {
    expect(limitsSql).toContain(
      'ADD CONSTRAINT "ReservationLimitSettings_monthlyReservationCap_range_check" CHECK ("monthlyReservationCap" BETWEEN 1 AND 31)'
    );
  });

  it('seeds the singleton row so the table is never empty', () => {
    expect(limitsSql).toContain('INSERT INTO "ReservationLimitSettings"');
    expect(limitsSql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('adds the audit action without recreating the append-only enum', () => {
    expect(limitsSql).toContain(
      `ALTER TYPE "AuditLogAction" ADD VALUE IF NOT EXISTS 'RESERVATION_LIMITS_UPDATED'`
    );
  });
});

describe('timed-reservation migration — column types', () => {
  const timedReservationSql = readMigration('20260924120000_timed_reservation').replace(
    /\s+/g,
    ' '
  );

  it('startMinute and endMinute are SMALLINT, not TEXT', () => {
    const createTable = timedReservationSql.match(
      /CREATE TABLE "TimedReservation" \((.*?)\);/
    )?.[1];
    expect(createTable).toBeDefined();
    expect(createTable).toContain('"startMinute" SMALLINT NOT NULL');
    expect(createTable).toContain('"endMinute" SMALLINT NOT NULL');
    expect(createTable).not.toMatch(/"(start|end)Minute" TEXT/);
  });

  // BEFORE would take the spot-day lock ahead of the unique index and deadlock
  // a create against a cancellation's promotion — see the migration's comment
  // and `database-contract.db.spec.ts`.
  it('fires the Reservation trigger AFTER the row is written, the blocks trigger BEFORE', () => {
    expect(timedReservationSql).toContain(
      'CREATE TRIGGER "reservation_reject_timed_conflict" AFTER INSERT OR UPDATE OF "parkingSpotId", "date" ON "Reservation"'
    );
    expect(timedReservationSql).toContain(
      'CREATE TRIGGER "timed_reservation_reject_conflict" BEFORE INSERT OR UPDATE'
    );
  });
});

describe('migration_lock.toml', () => {
  it('pins the provider to postgresql', () => {
    const lock = readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8');
    expect(lock).toContain('provider = "postgresql"');
  });
});

describe('every migration after the first is additive', () => {
  it('there is at least one, or this block is asserting nothing', () => {
    // A guard on the guard: `it.each([])` passes vacuously, and a suite that
    // silently stops covering the thing it names is the defect this file was
    // written to fix.
    expect(LATER_DIRECTORIES.length).toBeGreaterThan(0);
  });

  it.each(LATER_DIRECTORIES)('%s drops nothing', (directory) => {
    const statements = statementsOnly(readMigration(directory));
    // Every one of these would destroy data, and `AuditLog` cannot be rewritten
    // at all — the append-only trigger rejects the UPDATE a column rewrite
    // issues. A migration that needs one of them needs a decision record, and
    // this assertion is where the conversation starts.
    expect(statements).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
  });

  it.each(LATER_DIRECTORIES)('%s changes no enum type except by ADD VALUE', (directory) => {
    const statements = statementsOnly(readMigration(directory));
    for (const alter of statements.match(/ALTER\s+TYPE\b[^;]*/gi) ?? []) {
      expect(alter).toMatch(/ADD\s+VALUE\s+IF\s+NOT\s+EXISTS/i);
    }
  });
});

describe('the migrations and schema.prisma agree on AuditLogAction', () => {
  /**
   * The one enum the two artefacts were free to drift on: the init migration
   * creates it with six members, `schema.prisma` declares eight, and the only
   * assertion about it used to be that the `CREATE TYPE` line exists. Nothing
   * else in this project compares the migration history to the schema without a
   * live database — `schema-contract-parity.spec.ts` compares the *generated
   * client*, which is a third artefact derived from the schema and regenerated
   * by nobody in CI.
   */
  function migrationMembers(): string[] {
    const created = flat.match(/CREATE TYPE "AuditLogAction" AS ENUM \(([^)]*)\)/)?.[1];
    expect(created).toBeDefined();
    const members = [...(created ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');

    for (const directory of LATER_DIRECTORIES) {
      const statements = statementsOnly(readMigration(directory));
      const added = statements.matchAll(
        /ALTER\s+TYPE\s+"AuditLogAction"\s+ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'([^']+)'/gi
      );
      for (const match of added) {
        members.push(match[1] ?? '');
      }
    }
    return members;
  }

  function schemaMembers(): string[] {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    const block = schema.match(/enum AuditLogAction \{([^}]*)\}/)?.[1];
    expect(block).toBeDefined();
    return (block ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'));
  }

  it('the union of CREATE TYPE and every ADD VALUE is exactly what the schema declares', () => {
    expect([...migrationMembers()].sort()).toEqual([...schemaMembers()].sort());
  });

  it('no member is added twice across the history', () => {
    const members = migrationMembers();
    expect(new Set(members).size).toBe(members.length);
  });

  it('covers the two members the init migration does not create', () => {
    // Named rather than counted, so that deleting a migration file fails here
    // with the name of what went missing.
    expect(migrationMembers()).toEqual(
      expect.arrayContaining(['RESERVATION_WINDOW_UPDATED', 'WAITLIST_JOINED'])
    );
  });
});
