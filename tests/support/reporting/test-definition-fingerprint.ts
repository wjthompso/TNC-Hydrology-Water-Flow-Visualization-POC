import { createHash } from 'node:crypto';
import type { CatalogTest } from '../catalog/test-catalog.ts';

/**
 * Fingerprint of one permanent catalog test definition.
 * The `id` field is a catalog test identifier such as `SST-001`, not an HTML id attribute.
 * Result recording and catalog rendering share this function so a reused identifier
 * cannot inherit an older result.
 */
export function testDefinitionFingerprint(test: CatalogTest): string {
  const definition = {
    id: test.id,
    name: test.name,
    methodology: test.methodology,
    category: test.category,
    owner: test.owner,
    additionalFeatureAssociations: [...test.additionalFeatureAssociations].sort((left, right) =>
      compareText(left, right),
    ),
    scope: test.scope,
    environment: test.environment,
    browserMode: test.browserMode,
    regression: test.regression,
    bugReference: test.bugReference,
    rootCauseAnalysis: test.rootCauseAnalysis,
    enforcement: test.enforcement,
    durationBudgetMs: test.durationBudgetMs,
    sourceFile: test.sourceFile,
  };
  return sha256(`catalog-test-definition-v1\n${JSON.stringify(definition)}`);
}

/** Fingerprint of the required Feature Behavior and Critical Core definitions that the release gate covers. */
export function requiredGateDefinitionFingerprint(tests: readonly CatalogTest[]): string {
  const requiredDefinitions = tests
    .filter(
      (test) =>
        test.enforcement === 'required' &&
        (test.category === 'critical-core' || test.category === 'feature-behavior'),
    )
    .map((test) => ({
      id: test.id,
      definitionFingerprint: testDefinitionFingerprint(test),
    }))
    .sort((left, right) => compareText(left.id, right.id));
  return sha256(`required-gate-definition-v1\n${JSON.stringify(requiredDefinitions)}`);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
