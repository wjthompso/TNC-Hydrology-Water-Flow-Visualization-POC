import type {
  FeatureLifecycle,
  TestEnforcement,
} from '../catalog/test-catalog';

export type RecordedResultState =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'quarantined'
  | 'inconclusive';
export type CatalogResultState =
  | RecordedResultState
  | 'disabled'
  | 'deprecated'
  | 'retired'
  | 'unexecuted';

export function catalogResultState(
  recordedState: RecordedResultState | null,
  lifecycle: FeatureLifecycle | 'not-applicable',
  enforcement: TestEnforcement,
): CatalogResultState {
  if (enforcement === 'disabled') return 'disabled';
  if (lifecycle === 'deprecated') return 'deprecated';
  if (lifecycle === 'retired') return 'retired';
  return recordedState ?? 'unexecuted';
}
