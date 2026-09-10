#!/usr/bin/env node
/* global process, URL, setTimeout */
/**
 * Backup, restore and disaster-recovery rehearsal — Phase 22 (build-plan §Phase 22,
 * docs/architecture/02 §7, docs/architecture/15 §5, docs/implementation/recovery-runbook.md).
 *
 *   node tools/recovery-rehearsal.mjs [--out <report.json>] [--keep]
 *
 * What it measures, against the provisional RPO ≤ 5 minutes and RTO ≤ 4 hours:
 *
 *   1. A dedicated PostgreSQL 17 (the compose stack's image) is started with
 *      continuous WAL archiving to a volume, as the recovery posture requires.
 *   2. The platform's own bootstrap and migration journal provision a database,
 *      and the API's harness seeds a real hotel; a workload then writes real
 *      business rows (rooms, cleaning events, audit, outbox) with timestamps.
 *   3. A base backup is taken while the workload continues; more rows follow it.
 *   4. The failure is unplanned: after the last commit the rehearsal waits only
 *      for the archiver's own cadence — nothing is switched by hand — records how
 *      long the newest commit stayed unarchived (the RPO exposure), and then
 *      destroys the primary and its data directory.
 *   5. Restore A: base backup + archived WAL to the end of the archive; measured
 *      from the moment of failure to a verified database (RTO). Every row the
 *      archive covered must be present.
 *   6. Restore B: point-in-time to a chosen target between two commits; rows
 *      before the target present, rows after it absent.
 *   7. The schema of each restore equals the primary's pre-failure schema dump,
 *      and the outbox delivery markers survive the restore untouched — the
 *      relay's claim predicate is what stops a restored database re-sending.
 *
 * Nothing here touches the compose stack's cluster, and everything it creates
 * carries the `prsystem-rehearsal` prefix and is removed at the end.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = outIndex >= 0 ? resolve(process.cwd(), args[outIndex + 1]) : undefined;
const KEEP = args.includes('--keep');

const IMAGE = 'postgres:17.6-alpine';
const PREFIX = 'prsystem-rehearsal';
const PRIMARY = `${PREFIX}-primary`;
const RESTORE_A = `${PREFIX}-restore-latest`;
const RESTORE_B = `${PREFIX}-restore-pitr`;
const VOL_ARCHIVE = `${PREFIX}-archive`;
const VOL_BACKUP = `${PREFIX}-backup`;
const VOL_A = `${PREFIX}-data-latest`;
const VOL_B = `${PREFIX}-data-pitr`;
const PORT_PRIMARY = 55499;
const PORT_A = 55498;
const PORT_B = 55497;
const USER = 'prsystem';
const PASSWORD = 'prsystem_local_dev';
const SUITE = 'rehearsal';
const DATABASE = `prsystem_test_${SUITE}`;
/** The archiver's cadence: the longest a commit can wait for its segment (seconds). */
const ARCHIVE_TIMEOUT_S = 30;

const TARGETS = { rpoSeconds: 5 * 60, rtoSeconds: 4 * 60 * 60 };

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => Date.now();

function docker(argv, options = {}) {
  const result = spawnSync('docker', argv, { encoding: 'utf8', ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${argv.join(' ')} → ${String(result.status)}\n${result.stderr}`);
  }
  return result.stdout;
}
const dockerQuiet = (argv) =>
  docker(argv, { allowFailure: true, stdio: ['ignore', 'pipe', 'pipe'] });

function cleanup() {
  for (const name of [PRIMARY, RESTORE_A, RESTORE_B]) dockerQuiet(['rm', '-f', name]);
  for (const volume of [VOL_ARCHIVE, VOL_BACKUP, VOL_A, VOL_B])
    dockerQuiet(['volume', 'rm', '-f', volume]);
}

function startPrimary() {
  docker([
    'run',
    '-d',
    '--name',
    PRIMARY,
    '-e',
    `POSTGRES_USER=${USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e',
    'POSTGRES_DB=prsystem',
    '-p',
    `127.0.0.1:${String(PORT_PRIMARY)}:5432`,
    '-v',
    `${VOL_ARCHIVE}:/archive`,
    '-v',
    `${VOL_BACKUP}:/backup`,
    IMAGE,
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    'archive_command=test ! -f /archive/%f && cp %p /archive/%f',
    '-c',
    `archive_timeout=${String(ARCHIVE_TIMEOUT_S)}`,
    '-c',
    'max_wal_senders=3',
  ]);
}

async function waitReady(container, port, timeoutMs = 120_000) {
  const started = now();
  for (;;) {
    const probe = spawnSync('docker', ['exec', container, 'pg_isready', '-U', USER], {
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      // pg_isready answers before the entrypoint's initdb restart on a first boot;
      // a real connection over TCP is what the API would need.
      const { Client } = apiRequire('pg');
      const client = new Client({
        connectionString: `postgresql://${USER}:${PASSWORD}@127.0.0.1:${String(port)}/postgres`,
        connectionTimeoutMillis: 2000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return now() - started;
      } catch {
        await client.end().catch(() => undefined);
      }
    }
    const running = docker(['inspect', '-f', '{{.State.Running}}', container], {
      allowFailure: true,
    }).trim();
    if (running !== 'true') {
      throw new Error(
        `${container} exited before it was ready:\n${docker(['logs', '--tail', '20', container], { allowFailure: true })}`,
      );
    }
    if (now() - started > timeoutMs)
      throw new Error(`${container} did not become ready within ${String(timeoutMs)}ms`);
    await sleep(500);
  }
}

async function withClient(port, database, work) {
  const { Client } = apiRequire('pg');
  const client = new Client({
    connectionString: `postgresql://${USER}:${PASSWORD}@127.0.0.1:${String(port)}/${database}`,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const schemaDump = (container) =>
  docker([
    'exec',
    container,
    'pg_dump',
    '-U',
    USER,
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    DATABASE,
  ])
    .split('\n')
    // Comments, session settings and pg_dump's per-run `\restrict` token are not schema.
    .filter(
      (line) =>
        !line.startsWith('--') &&
        line.trim() !== '' &&
        !line.startsWith('SET ') &&
        !line.startsWith('SELECT pg_catalog.set_config') &&
        !line.startsWith('\\'),
    )
    .join('\n');

/** An archiver that has failed once is a rehearsal that cannot measure anything. */
async function assertArchiverHealthy() {
  const state = await withClient(
    PORT_PRIMARY,
    'postgres',
    async (c) =>
      (await c.query('SELECT failed_count, last_failed_wal FROM pg_stat_archiver')).rows[0],
  );
  if (Number(state.failed_count) > 0) {
    throw new Error(
      `the archiver failed on ${String(state.last_failed_wal)}: check the archive volume`,
    );
  }
}

async function main() {
  const report = {
    image: IMAGE,
    archiveTimeoutSeconds: ARCHIVE_TIMEOUT_S,
    targets: TARGETS,
    steps: {},
  };
  cleanup();
  log('starting the primary with WAL archiving');
  startPrimary();
  report.steps.primaryReadyMs = await waitReady(PRIMARY, PORT_PRIMARY);
  // The volumes' mount points are created root-owned; the archiver runs as
  // postgres. The first segment may have failed before the ownership fix, so
  // the archiver's counters are reset and a planned switch proves the path
  // works before anything is measured.
  docker(['exec', PRIMARY, 'sh', '-c', 'chown postgres:postgres /archive /backup']);
  await withClient(PORT_PRIMARY, 'postgres', async (c) => {
    await c.query("SELECT pg_stat_reset_shared('archiver')");
    await c.query('SELECT pg_switch_wal()');
  });
  for (let attempt = 0; ; attempt += 1) {
    const state = await withClient(
      PORT_PRIMARY,
      'postgres',
      async (c) =>
        (await c.query('SELECT archived_count, failed_count FROM pg_stat_archiver')).rows[0],
    );
    if (Number(state.archived_count) > 0) break;
    if (Number(state.failed_count) > 0 || attempt > 120)
      throw new Error('the archive path does not work: check the archive volume');
    await sleep(500);
  }

  // ------------------------------------------------------------ provision
  process.env['DATABASE_URL'] =
    `postgresql://${USER}:${PASSWORD}@127.0.0.1:${String(PORT_PRIMARY)}/prsystem`;
  process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'] ??= USER;
  process.env['NODE_ENV'] = 'test';
  process.env['APP_ENV'] = 'ci';
  const { createPublicHarness } = apiRequire(
    './dist/modules/public/test-support/public-harness.js',
  );
  const t0 = now();
  const pub = await createPublicHarness(SUITE);
  report.steps.provisionMs = now() - t0;
  log(
    `provisioned ${DATABASE} through the bootstrap and the migration journal in ${String(report.steps.provisionMs)}ms`,
  );
  const hotel = await pub.publishedHotel('Rehearsal буудал');

  // ------------------------------------------------------------ workload
  const commits = [];
  async function write(count, label) {
    for (let index = 0; index < count; index += 1) {
      const roomId = await hotel.cleanRoom();
      const at = await withClient(
        PORT_PRIMARY,
        DATABASE,
        async (c) => (await c.query('SELECT now() AS at')).rows[0].at,
      );
      commits.push({ roomId, at: new Date(at).toISOString(), label });
    }
  }
  await write(20, 'before-backup');
  log('20 rooms written before the base backup');

  // ------------------------------------------------------------ base backup
  await assertArchiverHealthy();
  const tb = now();
  docker([
    'exec',
    PRIMARY,
    'sh',
    '-c',
    `rm -rf /backup/base && mkdir -p /backup/base && pg_basebackup -U ${USER} -D /backup/base -Ft -X none --checkpoint=fast`,
  ]);
  report.steps.baseBackupMs = now() - tb;
  const backupListing = docker([
    'exec',
    PRIMARY,
    'sh',
    '-c',
    'ls -l /backup/base && du -sh /backup/base',
  ]);
  report.steps.baseBackupListing = backupListing.trim().split('\n');
  log(`base backup taken in ${String(report.steps.baseBackupMs)}ms`);

  await write(10, 'after-backup');
  await sleep(1500);
  const pitrTarget = await withClient(
    PORT_PRIMARY,
    DATABASE,
    async (c) => (await c.query('SELECT now() AS at')).rows[0].at,
  );
  report.pitrTarget = new Date(pitrTarget).toISOString();
  await sleep(1500);
  await write(10, 'after-target');
  const expectedAtTarget = commits.filter((c) => c.label !== 'after-target').length;
  const expectedTotal = commits.length;
  const lastCommit = commits[commits.length - 1];
  log(
    `${String(expectedTotal)} rooms in total; point-in-time target ${report.pitrTarget} after room ${String(expectedAtTarget)}`,
  );

  const preFailure = await withClient(PORT_PRIMARY, DATABASE, async (c) => ({
    rooms: Number((await c.query('SELECT count(*)::text AS n FROM platform.room')).rows[0].n),
    audit: Number(
      (await c.query('SELECT count(*)::text AS n FROM audit.platform_event')).rows[0].n,
    ),
    outbox: Number(
      (await c.query('SELECT count(*)::text AS n FROM platform.outbox_event')).rows[0].n,
    ),
    outboxPublished: Number(
      (
        await c.query(
          'SELECT count(*)::text AS n FROM platform.outbox_delivery WHERE published_at IS NOT NULL',
        )
      ).rows[0].n,
    ),
    currentWal: (await c.query('SELECT pg_walfile_name(pg_current_wal_lsn()) AS f')).rows[0].f,
  }));
  report.preFailure = preFailure;
  const schemaBefore = schemaDump(PRIMARY);

  // ------------------------------------------------------- unplanned failure
  // Nothing is switched by hand. The rehearsal waits for the archiver's own
  // cadence to cover the newest commit, and the wait is the RPO exposure.
  const lastCommitAt = new Date(lastCommit.at).getTime();
  const waitStart = now();
  let archivedAt;
  for (;;) {
    const state = await withClient(
      PORT_PRIMARY,
      'postgres',
      async (c) =>
        (
          await c.query(
            'SELECT last_archived_wal, last_archived_time, failed_count FROM pg_stat_archiver',
          )
        ).rows[0],
    );
    if (Number(state.failed_count) > 0) throw new Error('the archiver reported a failure');
    if (state.last_archived_wal !== null && state.last_archived_wal >= preFailure.currentWal) {
      archivedAt = new Date(state.last_archived_time).getTime();
      break;
    }
    if (now() - waitStart > (ARCHIVE_TIMEOUT_S + 60) * 1000)
      throw new Error('the newest segment was not archived within the cadence');
    await sleep(500);
  }
  report.rpo = {
    lastCommitAt: lastCommit.at,
    lastCommitArchivedAt: new Date(archivedAt).toISOString(),
    exposureSeconds: Math.max(0, (archivedAt - lastCommitAt) / 1000),
    boundSeconds: ARCHIVE_TIMEOUT_S,
    targetSeconds: TARGETS.rpoSeconds,
  };
  report.rpo.withinTarget =
    report.rpo.exposureSeconds <= TARGETS.rpoSeconds && ARCHIVE_TIMEOUT_S <= TARGETS.rpoSeconds;
  log(
    `newest commit archived ${String(report.rpo.exposureSeconds)}s after it was made (cadence bound ${String(ARCHIVE_TIMEOUT_S)}s)`,
  );
  const archiveListing = docker([
    'exec',
    PRIMARY,
    'sh',
    '-c',
    'ls /archive | wc -l && du -sh /archive',
  ])
    .trim()
    .split('\n');
  report.steps.archive = { files: Number(archiveListing[0]), size: archiveListing[1] };

  await pub.close();
  const failureAt = now();
  docker(['rm', '-f', PRIMARY]);
  report.failureAt = new Date(failureAt).toISOString();
  log('primary destroyed with its data directory; the archive and the base backup remain');

  // ---------------------------------------------------------------- restores
  async function restore(name, volume, port, recoveryTarget) {
    const started = now();
    const conf = [
      "restore_command = 'cp /archive/%f %p'",
      "recovery_target_action = 'promote'",
      // PostgreSQL wants `YYYY-MM-DD HH:MM:SS.mmm+00`, not the ISO `T`/`Z` form.
      ...(recoveryTarget === undefined
        ? []
        : [
            `recovery_target_time = '${recoveryTarget.replace('T', ' ').replace('Z', '+00')}'`,
            'recovery_target_inclusive = true',
          ]),
    ];
    // Each line is a separate printf argument, so `%f` and `%p` are text, not formats.
    const confArgs = conf.map((line) => `"${line}"`).join(' ');
    docker([
      'run',
      '--rm',
      '-v',
      `${VOL_BACKUP}:/backup:ro`,
      '-v',
      `${volume}:/var/lib/postgresql/data`,
      IMAGE,
      'sh',
      '-c',
      `set -e; cd /var/lib/postgresql/data && tar -xf /backup/base/base.tar && touch recovery.signal && printf '%s\n' ${confArgs} >> postgresql.auto.conf && chown -R postgres:postgres . && chmod 700 .`,
    ]);
    const unpackedMs = now() - started;
    docker([
      'run',
      '-d',
      '--name',
      name,
      '-e',
      `POSTGRES_PASSWORD=${PASSWORD}`,
      '-p',
      `127.0.0.1:${String(port)}:5432`,
      '-v',
      `${volume}:/var/lib/postgresql/data`,
      '-v',
      `${VOL_ARCHIVE}:/archive:ro`,
      IMAGE,
    ]);
    const readyMs = await waitReady(name, port, 300_000);
    // Promotion may follow readiness by a moment; wait until the server is not in recovery.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const inRecovery = await withClient(
        port,
        'postgres',
        async (c) => (await c.query('SELECT pg_is_in_recovery() AS r')).rows[0].r,
      );
      if (!inRecovery) break;
      await sleep(500);
    }
    const verified = await withClient(port, DATABASE, async (c) => ({
      rooms: Number((await c.query('SELECT count(*)::text AS n FROM platform.room')).rows[0].n),
      audit: Number(
        (await c.query('SELECT count(*)::text AS n FROM audit.platform_event')).rows[0].n,
      ),
      outbox: Number(
        (await c.query('SELECT count(*)::text AS n FROM platform.outbox_event')).rows[0].n,
      ),
      outboxPublished: Number(
        (
          await c.query(
            'SELECT count(*)::text AS n FROM platform.outbox_delivery WHERE published_at IS NOT NULL',
          )
        ).rows[0].n,
      ),
      lastRoomPresent:
        (
          await c.query('SELECT count(*)::int AS n FROM platform.room WHERE room_id = $1', [
            lastCommit.roomId,
          ])
        ).rows[0].n === 1,
      roomAtTargetPresent:
        (
          await c.query('SELECT count(*)::int AS n FROM platform.room WHERE room_id = $1', [
            commits[expectedAtTarget - 1].roomId,
          ])
        ).rows[0].n === 1,
      firstAfterTargetPresent:
        (
          await c.query('SELECT count(*)::int AS n FROM platform.room WHERE room_id = $1', [
            commits[expectedAtTarget].roomId,
          ])
        ).rows[0].n === 1,
    }));
    const schemaAfter = schemaDump(name);
    const schemaEqual = schemaAfter === schemaBefore;
    if (!schemaEqual && OUT !== undefined) {
      writeFileSync(`${OUT}.${name}.schema-before.sql`, schemaBefore);
      writeFileSync(`${OUT}.${name}.schema-after.sql`, schemaAfter);
    }
    const totalMs = now() - started;
    const logTail = docker(['logs', '--tail', '40', name], { allowFailure: true }) || '';
    const recoveryLines = (
      docker(['logs', name], { allowFailure: true, stdio: ['ignore', 'pipe', 'pipe'] }) + logTail
    )
      .split('\n')
      .filter((line) =>
        /recovery|restored log file|redo|consistent recovery state|promot/i.test(line),
      )
      .slice(-8);
    return { unpackedMs, readyMs, totalMs, verified, schemaEqual, recoveryLines };
  }

  log('restore A: base backup plus every archived segment');
  const restoreA = await restore(RESTORE_A, VOL_A, PORT_A);
  restoreA.rtoSeconds = (now() - failureAt) / 1000;
  restoreA.expectedRooms = expectedTotal;
  restoreA.complete =
    restoreA.verified.rooms === preFailure.rooms &&
    restoreA.verified.lastRoomPresent &&
    restoreA.verified.audit === preFailure.audit &&
    restoreA.verified.outbox === preFailure.outbox &&
    restoreA.verified.outboxPublished === preFailure.outboxPublished &&
    restoreA.schemaEqual;
  report.restoreLatest = restoreA;
  log(
    `restore A verified in ${String(restoreA.totalMs)}ms — ${String(restoreA.verified.rooms)} of ${String(preFailure.rooms)} rooms, schema equal: ${String(restoreA.schemaEqual)}`,
  );

  log(`restore B: point-in-time to ${report.pitrTarget}`);
  const restoreB = await restore(RESTORE_B, VOL_B, PORT_B, report.pitrTarget);
  restoreB.expectedRooms = expectedAtTarget;
  restoreB.complete =
    restoreB.verified.rooms === expectedAtTarget &&
    restoreB.verified.roomAtTargetPresent &&
    !restoreB.verified.firstAfterTargetPresent &&
    restoreB.schemaEqual;
  report.restorePointInTime = restoreB;
  log(
    `restore B verified in ${String(restoreB.totalMs)}ms — ${String(restoreB.verified.rooms)} rooms (expected ${String(expectedAtTarget)}), schema equal: ${String(restoreB.schemaEqual)}`,
  );

  report.rto = {
    measuredSeconds: restoreA.rtoSeconds,
    targetSeconds: TARGETS.rtoSeconds,
    withinTarget: restoreA.rtoSeconds <= TARGETS.rtoSeconds,
    note: 'failure → restore A ready and verified, on one machine from a local archive; a hosted restore adds provisioning and network transfer, which the runbook budgets separately',
  };
  report.outcome =
    report.rpo.withinTarget && report.rto.withinTarget && restoreA.complete && restoreB.complete
      ? 'PASS'
      : 'FAIL';
  report.measuredAt = new Date().toISOString();
  report.commits = commits.length;
  if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `outcome ${report.outcome}: RPO exposure ${String(report.rpo.exposureSeconds)}s (bound ${String(ARCHIVE_TIMEOUT_S)}s, target ${String(TARGETS.rpoSeconds)}s); RTO ${String(report.rto.measuredSeconds)}s (target ${String(TARGETS.rtoSeconds)}s)`,
  );
  if (!KEEP) cleanup();
  process.exit(report.outcome === 'PASS' ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(
    `recovery rehearsal failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  if (!KEEP) cleanup();
  process.exit(2);
});
