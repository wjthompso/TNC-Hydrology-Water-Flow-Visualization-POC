import catalogData from './catalog.json';

export type TestCategory =
  | 'feature-behavior'
  | 'feature-supporting'
  | 'critical-core'
  | 'shared-supporting';
export type BrowserMode = 'deterministic' | 'live' | 'not-applicable';
export type FeatureLifecycle = 'active' | 'deprecated' | 'retired';
export type TestEnforcement = 'required' | 'nonblocking' | 'disabled';

export interface ApprovedMetadataChange {
  reason: string;
  affectedBehaviors: string[];
  consequences: string;
  approvalEvidence: string;
  expectedBehaviorReview?: string;
}

export interface CatalogExample {
  id: string;
  name: string;
  methodology: string;
  category: 'feature-behavior' | 'critical-core';
  owner: string;
  sourceFile: string;
}

export interface CatalogTest {
  id: string;
  name: string;
  methodology: string;
  category: TestCategory;
  owner: string | null;
  additionalFeatureAssociations: string[];
  scope: 'unit' | 'component' | 'integration' | 'end-to-end';
  environment: 'browser' | 'non-browser';
  browserMode: BrowserMode;
  regression: boolean;
  bugReference: string | null;
  enforcement: TestEnforcement;
  enforcementChange: ApprovedMetadataChange | null;
  durationBudgetMs: number;
  fast: boolean;
  sourceFile: string;
}

export interface TestCatalog {
  schemaVersion: number;
  featureSets: Array<{ id: string; name: string; example?: boolean }>;
  features: Array<{
    id: string;
    featureSetId: string;
    name: string;
    lifecycle: FeatureLifecycle;
    lifecycleChange: ApprovedMetadataChange | null;
  }>;
  criticalCoreAreas: Array<{ id: string; name: string; example?: boolean }>;
  examples: CatalogExample[];
  tests: CatalogTest[];
}

export const catalog = catalogData as TestCatalog;

export { validateCatalog } from '../validation/foundations.ts';

export function selectFeatureTests(
  candidate: TestCatalog,
  featureId: string,
): CatalogTest[] {
  return candidate.tests.filter(
    (test) =>
      test.owner === featureId ||
      test.additionalFeatureAssociations.includes(featureId),
  );
}

export function selectFeatureSetTests(
  candidate: TestCatalog,
  featureSetId: string,
): CatalogTest[] {
  const featureIds = new Set(
    candidate.features
      .filter((feature) => feature.featureSetId === featureSetId)
      .map((feature) => feature.id),
  );
  return candidate.tests.filter(
    (test) =>
      (test.owner !== null && featureIds.has(test.owner)) ||
      test.additionalFeatureAssociations.some((id) => featureIds.has(id)),
  );
}

export function selectFeatureBehaviorTests(candidate: TestCatalog): CatalogTest[] {
  return candidate.tests.filter((test) => test.category === 'feature-behavior');
}

export function selectExecutableTests(candidate: TestCatalog): CatalogTest[] {
  return candidate.tests.filter((test) => test.enforcement !== 'disabled');
}

export function selectGateTests(candidate: TestCatalog): CatalogTest[] {
  return candidate.tests.filter(
    (test) =>
      test.enforcement === 'required' &&
      (test.category === 'critical-core' || test.category === 'feature-behavior'),
  );
}
