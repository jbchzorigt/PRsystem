import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The migration credential must not survive into anything a process emits.
 *
 * Both runtimes refuse `MIGRATION_DATABASE_URL`, and the refusal travels through
 * the real failure path: `main()` rejects, the top-level `catch` builds the
 * redacting logger and serialises the error with its stack. Asserting on the
 * thrown object alone would miss the two places a secret usually escapes — the
 * stack, and the structured fields a logger adds around it.
 *
 * So the actual entrypoint is run as a child process and everything it writes to
 * stdout and stderr is searched.
 */

const SECRET = 'startup-log-probe-password';
const MIGRATION_URL = `postgresql://prsystem_migrate_login:${SECRET}@127.0.0.1:55442/prsystem`;

const RUNTIMES = [
  { name: 'api', cwd: resolve(__dirname, '..', '..'), entry: 'src/main.ts' },
  { name: 'worker', cwd: resolve(__dirname, '..', '..', '..', 'worker'), entry: 'src/main.ts' },
] as const;

function runEntrypoint(cwd: string, entry: string): { output: string; status: number | null } {
  const run = spawnSync('pnpm', ['exec', 'tsx', entry], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'ci',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '54321',
      KMS_ADAPTER: 'local',
      KMS_SEED: 'synthetic-credential-logging-seed',
      DATABASE_URL: 'postgresql://prsystem_api_login:pw@127.0.0.1:55442/prsystem',
      REDIS_URL: 'redis://127.0.0.1:59998',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      MIGRATION_DATABASE_URL: MIGRATION_URL,
      // Deliberately absent so the API's scheduler capability is off and the
      // refusal under test is the migration credential, nothing else.
      SCHEDULER_ENABLED: 'false',
    },
  });
  return { output: `${run.stdout ?? ''}\n${run.stderr ?? ''}`, status: run.status };
}

describe.each(RUNTIMES)('$name startup refuses and logs nothing sensitive', (runtime) => {
  it('fails to start, names the variable, and leaks neither the value nor the URL', () => {
    const { output, status } = runEntrypoint(runtime.cwd, runtime.entry);

    // The process must not have started successfully.
    expect(status).not.toBe(0);

    // It must say which variable is wrong, or an operator cannot act on it.
    expect(output).toContain('MIGRATION_DATABASE_URL');

    // And nothing it wrote — message, stack, structured fields, serialised log
    // lines — may carry the value.
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(MIGRATION_URL);
    expect(output).not.toContain('prsystem_migrate_login:');
  }, 180000);

  it('emits structured log lines that carry no credential in any field', () => {
    const { output } = runEntrypoint(runtime.cwd, runtime.entry);

    // Every JSON line is walked field by field, so a secret nested inside `err`
    // or any serialiser-added field is caught rather than relying on a
    // substring scan of the whole blob.
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));

    const values: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') values.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === 'object') Object.values(node).forEach(walk);
    };
    for (const line of lines) {
      try {
        walk(JSON.parse(line));
      } catch {
        // Not JSON: already covered by the substring assertions above.
      }
    }

    // Non-vacuous: the runtime really did log something structured.
    expect(lines.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toContain(SECRET);
      expect(value).not.toContain(MIGRATION_URL);
    }
  }, 180000);
});
