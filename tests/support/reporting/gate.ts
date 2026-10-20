export type GatePhase = 'core' | 'features';
export type GatePhaseStatus = 'passed' | 'failed' | 'inconclusive';

export interface GatePhaseResult {
  status: GatePhaseStatus;
  durationMs: number;
}

export interface GateResult {
  status: GatePhaseStatus;
  phases: Array<{ phase: GatePhase; result: GatePhaseResult }>;
  diagnosticCommand?: string;
}

export type GateExecutor = (phase: GatePhase) => Promise<GatePhaseResult>;

/** Production `npm run test:gate` calls this function with a real executor. */
export async function runReleaseGate(execute: GateExecutor): Promise<GateResult> {
  const phases: GateResult['phases'] = [];
  const core = await execute('core');
  phases.push({ phase: 'core', result: core });

  if (core.status !== 'passed') {
    return {
      status: core.status,
      phases,
      diagnosticCommand: 'npm run test:core',
    };
  }

  const features = await execute('features');
  phases.push({ phase: 'features', result: features });
  return {
    status: features.status,
    phases,
    ...(features.status === 'passed'
      ? {}
      : { diagnosticCommand: 'npm run test:features' }),
  };
}
