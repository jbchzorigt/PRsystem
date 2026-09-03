/**
 * The provisioning *signal* (doc 15 §5; Phase 05 remediation R3).
 *
 * PostgreSQL is the job record: a paid application carries its own claim
 * token, lease, availability instant and attempt count, and the worker sweeps
 * the table on a cadence. What a signal adds is latency — a message that says
 * "there is work now" so the worker does not wait for its next sweep. It is
 * best-effort by design: a lost, delayed or duplicated message changes
 * nothing, because the worker provisions from the row and never from the
 * message, and a missed signal is recovered by the sweep.
 *
 * So the port never throws and never blocks a callback: a Redis that is down
 * costs a sweep interval, not a payment.
 */
export interface ProvisioningSignalPort {
  readonly id: string;
  /** Resolves `true` when the signal was accepted, `false` when it was not. */
  signal(applicationId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Records every signal; a test reads them, and can arm one failure. */
export class RecordingProvisioningSignal implements ProvisioningSignalPort {
  readonly id = 'recording';
  readonly signalled: string[] = [];
  private failures = 0;

  failNext(times = 1): void {
    this.failures += times;
  }

  signal(applicationId: string): Promise<boolean> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('simulated signal failure'));
    }
    this.signalled.push(applicationId);
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A signal that goes nowhere. The sweep is the only trigger. */
export class NoProvisioningSignal implements ProvisioningSignalPort {
  readonly id = 'none';

  signal(): Promise<boolean> {
    return Promise.resolve(false);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
