import { describe, expect, it, vi } from 'vitest';
import {
  runReleaseGate,
  type GatePhase,
  type GatePhaseStatus,
} from '../support/reporting/gate';

function executor(statuses: Record<GatePhase, GatePhaseStatus>) {
  return vi.fn(async (phase: GatePhase) => ({
    status: statuses[phase],
    durationMs: 1,
  }));
}

describe('SST-002', () => {
  it('The release check runs the core tests first and stops before feature tests if a core test fails.', async () => {
    const passing = executor({ core: 'passed', features: 'passed' });
    await expect(runReleaseGate(passing)).resolves.toMatchObject({ status: 'passed' });
    expect(passing.mock.calls.map(([phase]) => phase)).toEqual(['core', 'features']);

    const failing = executor({ core: 'failed', features: 'passed' });
    await expect(runReleaseGate(failing)).resolves.toMatchObject({
      status: 'failed',
      diagnosticCommand: 'npm run test:core',
    });
    expect(failing).toHaveBeenCalledTimes(1);

    const inconclusive = executor({ core: 'inconclusive', features: 'passed' });
    await expect(runReleaseGate(inconclusive)).resolves.toMatchObject({
      status: 'inconclusive',
      diagnosticCommand: 'npm run test:core',
    });
    expect(inconclusive).toHaveBeenCalledTimes(1);
  });
});
