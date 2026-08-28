import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Releases N independent OS processes at the same instant and collects what
 * each one reported.
 *
 * Two `Promise.all`-ed calls in one process share an event loop, so nothing
 * distinguishes "both ran at once" from "one ran, then the other". Separate
 * processes, each announcing READY and then blocking until the parent releases
 * it, make the overlap a fact the test can assert — and make a sequential run
 * fail rather than pass quietly.
 */
export interface ChildReport {
  readonly pid: number;
  readonly enteredAt: number;
  readonly leftAt: number;
  readonly [key: string]: unknown;
}

export interface ChildRaceOptions {
  /** Absolute path to a plain CommonJS child script. */
  readonly script: string;
  readonly cwd: string;
  /** One environment per child; the number of entries is the number of racers. */
  readonly envs: readonly Record<string, string>[];
  readonly readyTimeoutMs?: number;
  readonly exitTimeoutMs?: number;
}

export async function runChildRace(options: ChildRaceOptions): Promise<ChildReport[]> {
  if (!existsSync(options.script)) {
    throw new Error(`child script is missing: ${options.script}`);
  }

  // Plain `node` against plain CommonJS: every TypeScript loader re-spawns a
  // grandchild, and the READY handshake does not survive that extra hop —
  // the children run happily while the parent waits on a pipe it does not hold.
  const children = options.envs.map((env) =>
    spawn(process.execPath, [options.script], {
      cwd: options.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );

  // Tracks which children have already exited, so nothing is written to, or
  // signalled at, a process that is gone.
  const exited = new Set<number>();
  children.forEach((child, index) => {
    child.on('close', () => exited.add(index));
  });

  try {
    // A child that fails to start emits `error` and never `data`. Without this
    // the wait below would spin until the suite timed out, saying nothing useful.
    const startupErrors: string[] = [];
    for (const child of children) {
      child.on('error', (error) => startupErrors.push(error.message));
      // Pipe errors are reported on the *streams*, not on the child. An EPIPE
      // from writing to a child that has just exited would otherwise be an
      // unhandled error: the suite's own tests all pass, and the runner still
      // exits non-zero with nothing to explain it. This was an observed flake,
      // not a hypothetical one.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.on('error', (error: Error) => startupErrors.push(`stream: ${error.message}`));
      }
    }

    const collected = children.map((child) => {
      const state = { out: '', err: '', ready: false };
      child.stdout?.on('data', (chunk: Buffer) => {
        state.out += chunk.toString('utf8');
        if (state.out.includes('READY')) state.ready = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        state.err += chunk.toString('utf8');
      });
      return state;
    });

    const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
    while (!collected.every((c) => c.ready)) {
      if (startupErrors.length > 0) {
        throw new Error(`a child failed to start: ${startupErrors.join('; ')}`);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `a child never signalled READY: ${JSON.stringify(
            collected.map((c) => ({ out: c.out.slice(0, 200), err: c.err.slice(0, 200) })),
          )}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // Released together, only once every one of them is waiting.
    children.forEach((child, index) => {
      if (exited.has(index) || child.stdin === null || child.stdin.destroyed) return;
      child.stdin.write('go\n');
    });

    const exits = await Promise.all(
      children.map(
        (child) =>
          new Promise<number>((resolveExit) => {
            // Bounded: a child that never exits must fail the test, not hang the
            // runner until it is killed from outside.
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolveExit(-2);
            }, options.exitTimeoutMs ?? 60_000);
            child.on('close', (code) => {
              clearTimeout(timer);
              resolveExit(code ?? -1);
            });
          }),
      ),
    );

    const failed = exits
      .map((code, index) => ({ index, code, stderr: collected[index]?.err.slice(0, 400) ?? '' }))
      .filter((r) => r.code !== 0);
    if (failed.length > 0) {
      throw new Error(`child(ren) failed: ${JSON.stringify(failed)}`);
    }

    return collected.map((c) => {
      const line = c.out.split('\n').find((l) => l.startsWith('{'));
      if (line === undefined) throw new Error(`a child produced no report: ${c.out.slice(0, 200)}`);
      return JSON.parse(line) as ChildReport;
    });
  } finally {
    // Only signal what is still alive. Killing an already-reaped child is
    // harmless, but touching its streams is not.
    children.forEach((child, index) => {
      if (!exited.has(index)) child.kill('SIGKILL');
    });
  }
}

/** Sorted by start instant, so a caller can talk about "first" and "second". */
export function inStartOrder(reports: readonly ChildReport[]): ChildReport[] {
  return [...reports].sort((a, b) => a.enteredAt - b.enteredAt);
}
