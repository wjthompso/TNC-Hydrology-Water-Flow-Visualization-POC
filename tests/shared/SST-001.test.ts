import { describe, expect, it } from 'vitest';
import {
  catalog,
  selectExecutableTests,
  selectFeatureBehaviorTests,
  selectFeatureSetTests,
  selectFeatureTests,
  selectGateTests,
  validateCatalog,
  type ApprovedMetadataChange,
  type TestCatalog,
} from '../support/catalog/catalog';
import { catalogResultState } from '../support/reporting/result-state';

const ruleCatalog = (): TestCatalog => ({
  schemaVersion: 3,
  featureSets: [{ id: 'FS-100', name: 'Sample feature set' }],
  features: [
    {
      id: 'F-110',
      featureSetId: 'FS-100',
      name: 'Sample water surface',
      lifecycle: 'active',
      lifecycleChange: null,
    },
    {
      id: 'F-120',
      featureSetId: 'FS-100',
      name: 'Sample selection',
      lifecycle: 'active',
      lifecycleChange: null,
    },
  ],
  criticalCoreAreas: [{ id: 'CC-100', name: 'Sample calculations' }],
  examples: [],
  tests: [
    {
      id: 'CCT-001',
      name: 'Sample core check.',
      methodology: 'Compares a sample conversion with an exact value.',
      category: 'critical-core',
      owner: 'CC-100',
      additionalFeatureAssociations: ['F-110'],
      scope: 'unit',
      environment: 'non-browser',
      browserMode: 'not-applicable',
      regression: false,
      bugReference: null,
      enforcement: 'required',
      enforcementChange: null,
      durationBudgetMs: 200,
      fast: true,
      sourceFile: 'tests/shared/SST-001.test.ts',
    },
    {
      id: 'FST-001',
      name: 'Sample supporting check.',
      methodology: 'Checks one sample implementation detail.',
      category: 'feature-supporting',
      owner: 'F-110',
      additionalFeatureAssociations: [],
      scope: 'unit',
      environment: 'non-browser',
      browserMode: 'not-applicable',
      regression: false,
      bugReference: null,
      enforcement: 'nonblocking',
      enforcementChange: null,
      durationBudgetMs: 300,
      fast: true,
      sourceFile: 'tests/shared/SST-001.test.ts',
    },
    {
      id: 'FBT-001',
      name: 'Sample behavior check.',
      methodology: 'Checks one sample observable outcome.',
      category: 'feature-behavior',
      owner: 'F-110',
      additionalFeatureAssociations: [],
      scope: 'end-to-end',
      environment: 'browser',
      browserMode: 'deterministic',
      regression: false,
      bugReference: null,
      enforcement: 'required',
      enforcementChange: null,
      durationBudgetMs: 15000,
      fast: false,
      sourceFile: 'tests/shared/SST-001.test.ts',
    },
    {
      id: 'FBT-002',
      name: 'Sample second behavior check.',
      methodology: 'Checks a second sample observable outcome.',
      category: 'feature-behavior',
      owner: 'F-120',
      additionalFeatureAssociations: [],
      scope: 'end-to-end',
      environment: 'browser',
      browserMode: 'live',
      regression: false,
      bugReference: null,
      enforcement: 'required',
      enforcementChange: null,
      durationBudgetMs: 90000,
      fast: false,
      sourceFile: 'tests/shared/SST-001.test.ts',
    },
    {
      id: 'SST-001',
      name: 'Sample shared check.',
      methodology: 'Checks a sample catalog rule.',
      category: 'shared-supporting',
      owner: null,
      additionalFeatureAssociations: [],
      scope: 'unit',
      environment: 'non-browser',
      browserMode: 'not-applicable',
      regression: false,
      bugReference: null,
      enforcement: 'nonblocking',
      enforcementChange: null,
      durationBudgetMs: 1000,
      fast: true,
      sourceFile: 'tests/shared/SST-001.test.ts',
    },
    {
      id: 'SST-002',
      name: 'Sample gate check.',
      methodology: 'Checks sample gate ordering.',
      category: 'shared-supporting',
      owner: null,
      additionalFeatureAssociations: [],
      scope: 'unit',
      environment: 'non-browser',
      browserMode: 'not-applicable',
      regression: false,
      bugReference: null,
      enforcement: 'nonblocking',
      enforcementChange: null,
      durationBudgetMs: 1000,
      fast: true,
      sourceFile: 'tests/shared/SST-002.test.ts',
    },
  ],
});

const copyCatalog = (): TestCatalog => structuredClone(ruleCatalog());
const approvedChange = (
  expectedBehaviorReview?: string,
): ApprovedMetadataChange => ({
  reason: 'Approved lifecycle or enforcement transition.',
  affectedBehaviors: ['Water visualization behavior'],
  consequences: 'Release-gate participation changes as recorded.',
  approvalEvidence: 'Developer approval recorded in test plan review.',
  ...(expectedBehaviorReview ? { expectedBehaviorReview } : {}),
});

describe('SST-001', () => {
  it('The catalog rejects a test entry that breaks the classification rules, and feature filters return each matching test once.', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    expect(
      catalog.tests.filter(
        (test) =>
          test.category === 'feature-behavior' || test.category === 'critical-core',
      ),
    ).toEqual([]);
    expect(selectGateTests(catalog)).toEqual([]);
    expect(catalog.examples.map(({ id }) => id)).toEqual([
      'FBT-E001',
      'FBT-E002',
      'CCT-E001',
    ]);

    const duplicateIds = copyCatalog();
    duplicateIds.tests[1].id = duplicateIds.tests[0].id;
    expect(validateCatalog(duplicateIds)).toContain(
      `Duplicate test ID: ${duplicateIds.tests[0].id}.`,
    );

    const illegalCombination = copyCatalog();
    illegalCombination.tests[4].owner = 'F-110';
    expect(validateCatalog(illegalCombination)).toContain(
      'SST-001 Shared Supporting owner must be null.',
    );

    const unknownOwner = copyCatalog();
    unknownOwner.tests[1].owner = 'F-999';
    expect(validateCatalog(unknownOwner)).toContain(
      'FST-001 has unknown Feature owner F-999.',
    );

    const invalidBrowserMode = copyCatalog();
    invalidBrowserMode.tests[0].browserMode = 'live';
    expect(validateCatalog(invalidBrowserMode)).toContain(
      'CCT-001 non-browser tests require not-applicable browser mode.',
    );

    const rules = ruleCatalog();
    expect(selectFeatureBehaviorTests(rules).map(({ id }) => id)).toEqual([
      'FBT-001',
      'FBT-002',
    ]);
    expect(selectFeatureTests(rules, 'F-110').map(({ id }) => id)).toEqual([
      'CCT-001',
      'FST-001',
      'FBT-001',
    ]);
    expect(selectFeatureSetTests(rules, 'FS-100').map(({ id }) => id)).toEqual([
      'CCT-001',
      'FST-001',
      'FBT-001',
      'FBT-002',
    ]);

    const duplicateAssociation = copyCatalog();
    duplicateAssociation.tests[0].additionalFeatureAssociations = ['F-110', 'F-110'];
    expect(validateCatalog(duplicateAssociation)).toContain(
      'CCT-001 contains duplicate additional Feature associations.',
    );

    const invalidLifecycle = copyCatalog();
    invalidLifecycle.features[0].lifecycle = 'removed' as 'active';
    expect(validateCatalog(invalidLifecycle)).toContain(
      'Feature F-110 has invalid lifecycle removed.',
    );

    const deprecatedWithoutEvidence = copyCatalog();
    deprecatedWithoutEvidence.features[0].lifecycle = 'deprecated';
    expect(validateCatalog(deprecatedWithoutEvidence)).toContain(
      'Feature F-110 deprecated lifecycle requires approval evidence.',
    );

    const approvedDeprecated = copyCatalog();
    approvedDeprecated.features[0].lifecycle = 'deprecated';
    approvedDeprecated.features[0].lifecycleChange = approvedChange();
    expect(validateCatalog(approvedDeprecated)).toEqual([]);

    const deprecatedNonblocking = copyCatalog();
    deprecatedNonblocking.features[0].lifecycle = 'deprecated';
    deprecatedNonblocking.features[0].lifecycleChange = approvedChange();
    deprecatedNonblocking.tests[2].enforcement = 'nonblocking';
    expect(validateCatalog(deprecatedNonblocking)).toContain(
      'FBT-001 deprecated non-required enforcement requires approval evidence.',
    );
    deprecatedNonblocking.tests[2].enforcementChange = approvedChange();
    expect(validateCatalog(deprecatedNonblocking)).toEqual([]);

    const activeNonblocking = copyCatalog();
    activeNonblocking.tests[2].enforcement = 'nonblocking';
    expect(validateCatalog(activeNonblocking)).toContain(
      'FBT-001 active Feature Behavior defaults to required; an exception requires approval evidence.',
    );

    const reactivated = copyCatalog();
    reactivated.features[0].lifecycleChange = approvedChange();
    expect(validateCatalog(reactivated)).toContain(
      'Feature F-110 reactivation requires an expected-behavior review.',
    );
    reactivated.features[0].lifecycleChange = approvedChange(
      'Expected behavior was reviewed against the current Feature definition.',
    );
    expect(validateCatalog(reactivated)).toEqual([]);

    const disabled = copyCatalog();
    disabled.tests[2].enforcement = 'disabled';
    disabled.tests[2].enforcementChange = approvedChange();
    expect(selectFeatureTests(disabled, 'F-110').map(({ id }) => id)).toContain(
      'FBT-001',
    );
    expect(selectExecutableTests(disabled).map(({ id }) => id)).not.toContain(
      'FBT-001',
    );
    expect(selectGateTests(disabled).map(({ id }) => id)).not.toContain(
      'FBT-001',
    );

    expect(catalogResultState('passed', 'active', 'disabled')).toBe('disabled');
    expect(catalogResultState('passed', 'deprecated', 'required')).toBe(
      'deprecated',
    );
    expect(catalogResultState(null, 'active', 'required')).toBe('unexecuted');
  });
});
