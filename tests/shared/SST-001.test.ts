import { describe, expect, it } from 'vitest';
import {
  selectExecutableTests,
  selectFeatureBehaviorTests,
  selectFeatureSetTests,
  selectFeatureTests,
  selectGateTests,
  testCatalog,
  validateCatalog,
  type ApprovedMetadataChange,
  type TestCatalog,
} from '../support/catalog/test-catalog';
import {
  executionStatus,
  normalizePlaywrightResults,
} from '../support/reporting/playwright-results';
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
      rootCauseAnalysis: null,
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
      rootCauseAnalysis: null,
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
      rootCauseAnalysis: null,
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
      rootCauseAnalysis: null,
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
      rootCauseAnalysis: null,
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
      rootCauseAnalysis: null,
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
    expect(validateCatalog(testCatalog)).toEqual([]);
    expect(testCatalog.examples.map(({ id }) => id)).toEqual([
      'FBT-E001',
      'FBT-E002',
      'CCT-E001',
    ]);

    const malformedIdentifier = copyCatalog();
    malformedIdentifier.tests[2].id = 'FBT-E001';
    expect(validateCatalog(malformedIdentifier)).toContain(
      'FBT-E001 is not a valid permanent catalog test identifier (a category prefix and number such as FBT-001). Catalog test identifiers are not HTML id attributes.',
    );

    const htmlStyleIdentifier = copyCatalog();
    htmlStyleIdentifier.tests[2].id = 'sign-in-button';
    expect(validateCatalog(htmlStyleIdentifier)).toContain(
      'sign-in-button is not a valid permanent catalog test identifier (a category prefix and number such as FBT-001). Catalog test identifiers are not HTML id attributes.',
    );

    const prefixMismatch = copyCatalog();
    prefixMismatch.tests[4].id = 'FBT-009';
    expect(validateCatalog(prefixMismatch)).toContain(
      'FBT-009 category shared-supporting requires catalog test identifier prefix SST.',
    );

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

    for (const test of testCatalog.tests) {
      if (test.regression) {
        expect(test.category).toBe('feature-behavior');
        expect(test.bugReference?.trim().length ?? 0).toBeGreaterThan(0);
        expect(test.rootCauseAnalysis?.trim().length ?? 0).toBeGreaterThan(0);
        expect(test.methodology.includes('Regression RCA:')).toBe(false);
      } else {
        expect(test.bugReference).toBeNull();
        expect(test.rootCauseAnalysis).toBeNull();
      }
    }

    const missingBugReference = copyCatalog();
    missingBugReference.tests[2].regression = true;
    missingBugReference.tests[2].rootCauseAnalysis = 'Sample root cause.';
    expect(validateCatalog(missingBugReference)).toContain(
      'FBT-001 Bug Check requires a nonempty bug reference.',
    );

    const missingRootCause = copyCatalog();
    missingRootCause.tests[2].regression = true;
    missingRootCause.tests[2].bugReference = 'sample bug';
    missingRootCause.tests[2].rootCauseAnalysis = '   ';
    expect(validateCatalog(missingRootCause)).toContain(
      'FBT-001 Bug Check requires a nonempty root cause analysis.',
    );

    const baselineWithReference = copyCatalog();
    baselineWithReference.tests[2].bugReference = 'sample bug';
    expect(validateCatalog(baselineWithReference)).toContain(
      'FBT-001 baseline test must leave bug reference and root cause analysis null.',
    );

    const supportingBugCheck = copyCatalog();
    supportingBugCheck.tests[1].regression = true;
    supportingBugCheck.tests[1].bugReference = 'sample bug';
    supportingBugCheck.tests[1].rootCauseAnalysis = 'Sample root cause.';
    expect(validateCatalog(supportingBugCheck)).toContain(
      'FST-001 Bug Check is only valid on a Feature Behavior Test.',
    );

    const validBugCheck = copyCatalog();
    validBugCheck.tests[2].regression = true;
    validBugCheck.tests[2].bugReference = 'sample bug';
    validBugCheck.tests[2].rootCauseAnalysis = 'Sample root cause.';
    expect(validateCatalog(validBugCheck)).toEqual([]);

    expect(catalogResultState('passed', 'active', 'disabled')).toBe('disabled');
    expect(catalogResultState('passed', 'deprecated', 'required')).toBe(
      'deprecated',
    );
    expect(catalogResultState(null, 'active', 'required')).toBe('unexecuted');

    const selected = [
      {
        id: 'FBT-003',
        sourceFile: 'tests/sample/FBT-003.live.spec.ts',
        name: 'Sample retry check.',
        enforcement: 'required',
      },
    ];
    const repoRoot = '/repo';
    const playwrightReport = (
      results: Array<Record<string, unknown>>,
      title = 'Sample retry check.',
    ) => ({
      suites: [
        {
          title,
          file: 'tests/sample/FBT-003.live.spec.ts',
          specs: [
            {
              title,
              file: 'tests/sample/FBT-003.live.spec.ts',
              tests: [{ results }],
            },
          ],
        },
      ],
    });
    const normalize = (results: Array<Record<string, unknown>>, title?: string) =>
      normalizePlaywrightResults(
        playwrightReport(results, title),
        selected,
        false,
        repoRoot,
      )[0];

    const failedThenPassed = normalize([
      {
        retry: 0,
        status: 'timedOut',
        duration: 1200.4,
        error: {
          message: `\u001b[31mTimed out waiting for water\u001b[0m\n${'extra\n'.repeat(24)}`,
          location: { file: '/repo/tests/sample/FBT-003.live.spec.ts', line: 12 },
        },
        stdout: [{ text: Array.from({ length: 45 }, (_, index) => `out ${index}`).join('\n') }],
        stderr: [{ text: 'err detail\n' }],
        attachments: [
          {
            name: 'trace',
            contentType: 'application/zip',
            path: '/repo/.test-results/playwright-artifacts/trace.zip',
          },
          {
            name: 'screenshot',
            contentType: 'image/png',
            path: '/repo/.test-results/playwright-artifacts/shot.png',
          },
        ],
      },
      { retry: 1, status: 'passed', duration: 800.2 },
    ]);
    expect(failedThenPassed).toMatchObject({
      id: 'FBT-003',
      state: 'passed',
      durationMs: 800,
      totalDurationMs: 2000,
      passedAfterRetry: true,
    });
    expect(failedThenPassed.failedAttempts).toEqual([
      {
        attempt: 1,
        status: 'timedOut',
        durationMs: 1200,
        errorMessage: `Timed out waiting for water\n${'extra\n'.repeat(19)}`.trimEnd(),
        errorLocation: 'tests/sample/FBT-003.live.spec.ts:12',
        stdoutTail: Array.from({ length: 40 }, (_, index) => `out ${index + 5}`).join('\n'),
        stderrTail: 'err detail\n',
        artifacts: [
          '.test-results/playwright-artifacts/trace.zip',
          '.test-results/playwright-artifacts/shot.png',
        ],
      },
    ]);
    expect(executionStatus(selected, [failedThenPassed])).toEqual({
      name: 'passed',
      exitCode: 0,
    });

    const inconclusiveThenPassed = normalize([
      {
        retry: 0,
        status: 'failed',
        duration: 10,
        errors: [{ message: 'INCONCLUSIVE: USGS tiles unavailable' }],
      },
      { retry: 1, status: 'passed', duration: 20 },
    ]);
    expect(inconclusiveThenPassed.state).toBe('passed');
    expect(inconclusiveThenPassed.passedAfterRetry).toBe(true);
    expect(inconclusiveThenPassed.failedAttempts?.[0]).toMatchObject({
      attempt: 1,
      status: 'inconclusive',
      errorMessage: 'INCONCLUSIVE: USGS tiles unavailable',
    });

    const passedOnce = normalize([{ retry: 0, status: 'passed', duration: 15 }]);
    expect(passedOnce.state).toBe('passed');
    expect(passedOnce.passedAfterRetry).toBeUndefined();
    expect(passedOnce.failedAttempts).toBeUndefined();
    expect(passedOnce.durationMs).toBe(15);

    const markerOnlyInTitle = normalizePlaywrightResults(
      {
        suites: [
          {
            title: 'INCONCLUSIVE: this suite label is not an attempt error.',
            file: 'tests/sample/FBT-003.live.spec.ts',
            specs: [
              {
                title: 'Sample retry check.',
                file: 'tests/sample/FBT-003.live.spec.ts',
                tests: [{ results: [{ retry: 0, status: 'passed', duration: 15 }] }],
              },
            ],
          },
        ],
      },
      selected,
      false,
      repoRoot,
    )[0];
    expect(markerOnlyInTitle.state).toBe('passed');
    expect(markerOnlyInTitle.passedAfterRetry).toBeUndefined();

    const failedTwice = normalize([
      { retry: 0, status: 'failed', duration: 5, error: { message: 'first' } },
      { retry: 1, status: 'failed', duration: 6, error: { message: 'second' } },
    ]);
    expect(failedTwice.state).toBe('failed');
    expect(failedTwice.passedAfterRetry).toBeUndefined();
    expect(failedTwice.durationMs).toBe(6);
    expect(failedTwice.totalDurationMs).toBe(11);
    expect(executionStatus(selected, [failedTwice])).toEqual({
      name: 'failed',
      exitCode: 1,
    });

    const failedThenInconclusive = normalize([
      { retry: 0, status: 'failed', duration: 5, error: { message: 'first' } },
      {
        retry: 1,
        status: 'timedOut',
        duration: 7,
        error: { message: 'INCONCLUSIVE: terrain tiles did not load' },
      },
    ]);
    expect(failedThenInconclusive.state).toBe('inconclusive');
    expect(failedThenInconclusive.passedAfterRetry).toBeUndefined();
    expect(failedThenInconclusive.durationMs).toBe(7);
    expect(executionStatus(selected, [failedThenInconclusive])).toEqual({
      name: 'inconclusive',
      exitCode: 2,
    });
  });
});
