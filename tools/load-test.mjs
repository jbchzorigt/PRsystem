#!/usr/bin/env node
/* global process, fetch, setTimeout, URL */
/**
 * Load measurement against the provisional latency and throughput targets —
 * Phase 22 (docs/architecture/15-non-functional-targets.md §2, §3).
 *
 *   node tools/load-test.mjs [--out <report.json>] [--requests 200] [--concurrency 8]
 *
 * The seeded e2e API server (`e2e/api-server.mjs`: the real API on a scratch
 * database, every external port its simulator) is started on its own ports,
 * and one representative route per latency class is driven `requests` times
 * at `concurrency` in flight, measured at the client on the same machine —
 * loopback, so the number is the API's own. Then the indexed read is driven
 * for a fixed window to report the sustained request rate.
 *
 *   Read, indexed              GET  /hotels/:id/rooms/board
 *   Read, paginated search     GET  /operation/subscriptions?limit=25
 *   Public search              GET  /public/hotels?checkIn&checkOut
 *   Command, simple            POST /guest/bookings/:id/cancellation
 *   Command, transactional     POST /guest/bookings            (the ten-minute hold)
 *   Command, provider          POST /guest/bookings/:id/payment-attempts/:attempt/invoice
 *
 * Every command is a real one — a hold takes inventory and its cancellation
 * gives it back — so the run leaves the database as it found it. A shortfall
 * is reported beside the target, never hidden.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const OUT = option('out', undefined);
const REQUESTS = Number(option('requests', '200'));
const CONCURRENCY = Number(option('concurrency', '8'));
const WINDOW_S = Number(option('window', '15'));
const API_PORT = 53230;
const CONSOLE_PORT = 53231;
const API = `http://127.0.0.1:${String(API_PORT)}/api/v1`;
const CONSOLE = `http://127.0.0.1:${String(CONSOLE_PORT)}`;

const TARGETS = {
  'read-indexed': { p50: 50, p95: 200, p99: 500 },
  'read-paginated': { p50: 100, p95: 400, p99: 800 },
  'public-search': { p50: 150, p95: 600, p99: 1200 },
  'command-simple': { p50: 100, p95: 300, p99: 700 },
  'command-transactional': { p50: 200, p95: 800, p99: 1500 },
  'command-provider': { p50: 300, p95: 1500, p99: 3000 },
};
const THROUGHPUT_TARGET_RPS = 200;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (line) => process.stdout.write(`${line}\n`);

let keys = 0;
async function call(method, path, { token, body, headers } = {}) {
  keys += 1;
  const started = performance.now();
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `load-${String(process.pid)}-${String(keys)}`,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(headers ?? {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : JSON.parse(text),
    ms: performance.now() - started,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/** Runs `work(i)` `count` times with `concurrency` in flight; returns latencies and failures. */
async function drive(count, concurrency, work) {
  const latencies = [];
  const failures = [];
  let next = 0;
  const started = performance.now();
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      try {
        const result = await work(index);
        latencies.push(result.ms);
        if (result.status >= 400)
          failures.push({ index, status: result.status, code: result.body?.error?.code });
      } catch (error) {
        failures.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedS = (performance.now() - started) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    count,
    concurrency,
    failures: failures.length,
    failureSample: failures.slice(0, 3),
    p50: Math.round(percentile(sorted, 50) * 10) / 10,
    p95: Math.round(percentile(sorted, 95) * 10) / 10,
    p99: Math.round(percentile(sorted, 99) * 10) / 10,
    max: Math.round(percentile(sorted, 100) * 10) / 10,
    rps: Math.round((latencies.length / elapsedS) * 10) / 10,
  };
}

async function main() {
  const server = spawn(process.execPath, [resolve(root, 'e2e/api-server.mjs')], {
    env: {
      ...process.env,
      E2E_SUITE: 'load',
      E2E_API_PORT: String(API_PORT),
      E2E_CONSOLE_PORT: String(CONSOLE_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => (serverOutput += chunk));
  server.stderr.on('data', (chunk) => (serverOutput += chunk));
  const stop = () => {
    server.kill('SIGTERM');
  };
  process.on('exit', stop);
  try {
    let seed;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        const response = await fetch(`${CONSOLE}/seed`);
        if (response.ok) {
          seed = await response.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      if (server.exitCode !== null)
        throw new Error(`the e2e server exited:\n${serverOutput.slice(-2000)}`);
      await sleep(500);
    }
    if (seed === undefined) throw new Error('the e2e server did not come up');
    log(`seeded API on ${seed.api}`);

    // ---------------------------------------------------------- identities
    const reception = (await call('POST', '/auth/sign-in', { body: seed.hotel.reception })).body
      .token;
    const admin = seed.operation.admins[0];
    const totp = await (
      await fetch(`${CONSOLE}/totp?email=${encodeURIComponent(admin.email)}`)
    ).json();
    const operator = (
      await call('POST', '/operation/auth/sign-in', {
        body: { email: admin.email, password: admin.password, code: totp.code },
      })
    ).body.token;
    if (typeof reception !== 'string' || typeof operator !== 'string')
      throw new Error('sign-in failed');
    const phone = `9955${String(1000 + Math.floor(Math.random() * 8000))}`;
    const password = ['synthetic', 'load', 'passphrase'].join('-');
    await call('POST', '/guest/phone-verifications', { body: { phone, purpose: 'REGISTER' } });
    const otp = await (await fetch(`${CONSOLE}/otp?phone=${phone}`)).json();
    const guest = (
      await call('POST', '/guest/accounts', { body: { phone, code: otp.code, password } })
    ).body.token;
    if (typeof guest !== 'string') throw new Error('guest registration failed');
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const hotelId = seed.hotel.hotelId;
    const categoryId = seed.hotel.categoryId;

    const report = {
      measuredAt: new Date().toISOString(),
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      classes: {},
      throughput: {},
    };

    // ------------------------------------------------------------ reads
    log('read, indexed: the room board');
    report.classes['read-indexed'] = await drive(REQUESTS, CONCURRENCY, () =>
      call('GET', `/hotels/${hotelId}/rooms/board`, { token: reception }),
    );
    log('read, paginated: the subscription list');
    report.classes['read-paginated'] = await drive(REQUESTS, CONCURRENCY, () =>
      call('GET', '/operation/subscriptions?limit=25&offset=0', { token: operator }),
    );
    log('public search');
    report.classes['public-search'] = await drive(REQUESTS, CONCURRENCY, () =>
      call('GET', `/public/hotels?checkIn=${today}&checkOut=${tomorrow}`),
    );

    // ------------------------------------------------------------ commands
    // Each hold is a real transactional command; its cancellation is the
    // simple lifecycle command that gives the inventory back. They alternate
    // so the category never runs out.
    log('command, transactional (hold) and command, simple (cancellation)');
    const holds = [];
    const cancels = [];
    const provider = [];
    const commandCount = Math.min(REQUESTS, 120);
    const commandConcurrency = Math.min(CONCURRENCY, 4);
    await drive(commandCount, commandConcurrency, async () => {
      const held = await call('POST', '/guest/bookings', {
        token: guest,
        body: {
          categoryId,
          checkInDate: today,
          checkOutDate: tomorrow,
          stayingGuestName: 'Load Test',
          provider: 'QPAY',
        },
      });
      holds.push(held);
      if (held.status === 201) {
        const invoice = await call(
          'POST',
          `/guest/bookings/${held.body.bookingId}/payment-attempts/${held.body.attempt.attemptId}/invoice`,
          { token: guest, body: {} },
        );
        provider.push(invoice);
        const cancelled = await call(
          'POST',
          `/guest/bookings/${held.body.bookingId}/cancellation`,
          { token: guest, body: {} },
        );
        cancels.push(cancelled);
      }
      return held;
    });
    const summarise = (results) => {
      const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
      return {
        count: results.length,
        concurrency: commandConcurrency,
        failures: results.filter((r) => r.status >= 400).length,
        failureSample: results
          .filter((r) => r.status >= 400)
          .slice(0, 3)
          .map((r) => ({ status: r.status, code: r.body?.error?.code })),
        p50: Math.round(percentile(sorted, 50) * 10) / 10,
        p95: Math.round(percentile(sorted, 95) * 10) / 10,
        p99: Math.round(percentile(sorted, 99) * 10) / 10,
        max: Math.round(percentile(sorted, 100) * 10) / 10,
      };
    };
    report.classes['command-transactional'] = summarise(holds);
    report.classes['command-simple'] = summarise(cancels);
    report.classes['command-provider'] = summarise(provider);

    // ------------------------------------------------------------ throughput
    log(
      `sustained throughput: the room board for ${String(WINDOW_S)}s at ${String(CONCURRENCY * 4)} in flight`,
    );
    const deadline = performance.now() + WINDOW_S * 1000;
    let served = 0;
    let errors = 0;
    const windowLatencies = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY * 4 }, async () => {
        while (performance.now() < deadline) {
          const result = await call('GET', `/hotels/${hotelId}/rooms/board`, { token: reception });
          served += 1;
          windowLatencies.push(result.ms);
          if (result.status >= 400) errors += 1;
        }
      }),
    );
    const sortedWindow = windowLatencies.sort((a, b) => a - b);
    report.throughput = {
      windowSeconds: WINDOW_S,
      inFlight: CONCURRENCY * 4,
      served,
      errors,
      rps: Math.round((served / WINDOW_S) * 10) / 10,
      p95: Math.round(percentile(sortedWindow, 95) * 10) / 10,
      targetRps: THROUGHPUT_TARGET_RPS,
      withinTarget: served / WINDOW_S >= THROUGHPUT_TARGET_RPS && errors === 0,
    };

    // ------------------------------------------------------------ verdicts
    for (const [name, target] of Object.entries(TARGETS)) {
      const measured = report.classes[name];
      measured.target = target;
      measured.withinTarget =
        measured.failures === 0 &&
        measured.p50 <= target.p50 &&
        measured.p95 <= target.p95 &&
        measured.p99 <= target.p99;
    }
    report.outcome =
      Object.values(report.classes).every((c) => c.withinTarget) && report.throughput.withinTarget
        ? 'PASS'
        : 'SHORTFALL';
    log('');
    log('| class | n | p50 ms | p95 ms | p99 ms | target p50/p95/p99 | failures | within |');
    log('| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |');
    for (const [name, c] of Object.entries(report.classes)) {
      log(
        `| ${name} | ${String(c.count)} | ${String(c.p50)} | ${String(c.p95)} | ${String(c.p99)} | ${String(c.target.p50)}/${String(c.target.p95)}/${String(c.target.p99)} | ${String(c.failures)} | ${c.withinTarget ? 'yes' : 'NO'} |`,
      );
    }
    log(
      `| throughput (room board, ${String(WINDOW_S)}s) | ${String(report.throughput.served)} | p95 ${String(report.throughput.p95)} | | | ≥ ${String(THROUGHPUT_TARGET_RPS)} rps | ${String(report.throughput.errors)} | ${String(report.throughput.rps)} rps → ${report.throughput.withinTarget ? 'yes' : 'NO'} |`,
    );
    log(`outcome: ${report.outcome}`);
    if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    stop();
    await sleep(1500);
  }
}

main().catch((error) => {
  process.stderr.write(
    `load test failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(2);
});
