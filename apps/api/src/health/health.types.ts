/** Outcome of a single dependency probe. */
export interface DependencyProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** Failure reason. Never contains a connection string or credential. */
  readonly detail?: string;
}

/** A named dependency probe. Implementations must never throw. */
export interface DependencyProbe {
  readonly name: string;
  check(): Promise<DependencyProbeResult>;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'degraded';
  readonly checks: readonly DependencyProbeResult[];
}

export interface LivenessReport {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
}
