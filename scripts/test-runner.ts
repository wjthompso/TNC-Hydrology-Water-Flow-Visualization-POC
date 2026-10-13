import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import playwrightConfig from '../playwright.config.ts';
import type { CatalogTest, TestCatalog } from '../tests/support/catalog/test-catalog.ts';
import { runReleaseGate } from '../tests/support/reporting/gate.ts';
import {
  commandReportLines,
  commandReportUsesColor,
  formatWallClock,
} from '../tests/support/reporting/command-report.ts';
import {
  executionStatus,
  normalizePlaywrightResults,
  passedAfterRetryLines,
  type NormalizedTestResult,
} from '../tests/support/reporting/playwright-results.ts';
import {
  requiredGateDefinitionFingerprint,
  testDefinitionFingerprint,
} from '../tests/support/reporting/test-definition-fingerprint.ts';
import {
  introductionLines,
  type PlannedTest,
} from '../tests/support/reporting/run-progress.ts';
import { validateTestingFoundations } from '../tests/support/validation/foundations.ts';

const root = process.cwd();
const resultsDirectory = path.join(root, '.test-results');
const cacheDirectory = process.env.TNC_TEST_CACHE_DIR
  ? path.resolve(process.env.TNC_TEST_CACHE_DIR)
  : path.join(root, '.test-cache');
const testCatalog = JSON.parse(
  await readFile(path.join(root, 'tests/support/catalog/test-catalog.json'), 'utf8'),
) as TestCatalog;

type ExecutionStateName = 'passed' | 'failed' | 'inconclusive';

type NormalizedResult = NormalizedTestResult;

interface Execution {
  name: ExecutionStateName;
  exitCode: number;
  durationMs: number;
  results: NormalizedResult[];
}

const isExecutable = (test: CatalogTest) => test.enforcement !== 'disabled';
const sourceFiles = (tests: CatalogTest[]) => [
  ...new Set(tests.map(({ sourceFile }) => sourceFile)),
];
const associatedWithFeature = (test: CatalogTest, featureId: string) =>
  test.owner === featureId || test.additionalFeatureAssociations.includes(featureId);

function featureSetTests(featureSetId: string): CatalogTest[] {
  const featureIds = new Set(
    testCatalog.features
      .filter((feature) => feature.featureSetId === featureSetId)
      .map(({ id }) => id),
  );
  return testCatalog.tests.filter(
    (test) =>
      (test.owner !== null && featureIds.has(test.owner)) ||
      test.additionalFeatureAssociations.some((id) => featureIds.has(id)),
  );
}

function selectTests(mode: string | undefined, selector: string | undefined): CatalogTest[] {
  const enabled = testCatalog.tests.filter(isExecutable);
  switch (mode) {
    case 'fast-only':
      return enabled.filter((test) => test.environment === 'non-browser' && test.fast);
    case 'features':
      return enabled.filter((test) => test.category === 'feature-behavior');
    case 'core':
      return enabled.filter((test) => test.category === 'critical-core');
    case 'shared':
      return enabled.filter((test) => test.category === 'shared-supporting');
    case 'browser-deterministic':
      return enabled.filter((test) => test.browserMode === 'deterministic');
    case 'browser-live':
      return enabled.filter((test) => test.browserMode === 'live');
    case 'browser-all':
      return enabled.filter((test) => test.environment === 'browser');
    case 'feature':
      if (!testCatalog.features.some(({ id }) => id === selector)) {
        throw new Error(`Unknown Feature selector: ${selector ?? '(missing)'}.`);
      }
      return enabled.filter((test) => associatedWithFeature(test, selector ?? ''));
    case 'feature-set':
      if (!testCatalog.featureSets.some(({ id }) => id === selector)) {
        throw new Error(`Unknown Feature Set selector: ${selector ?? '(missing)'}.`);
      }
      return featureSetTests(selector ?? '').filter(isExecutable);
    case 'all':
      return enabled;
    default:
      throw new Error(`Unknown test command mode: ${mode ?? '(missing)'}.`);
  }
}

function requiredTests(category: CatalogTest['category']): CatalogTest[] {
  return testCatalog.tests.filter(
    (test) =>
      isExecutable(test) && test.enforcement === 'required' && test.category === category,
  );
}

async function runProcess(
  command: string,
  args: string[],
  environment: Record<string, string> = {},
) {
  const startedAt = performance.now();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...environment },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  return {
    exitCode,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function vitestResults(
  report: unknown,
  selected: CatalogTest[],
  processFailed: boolean,
): NormalizedResult[] {
  const testResults = asRecord(report)?.testResults;
  const files = Array.isArray(testResults) ? testResults : [];
  return selected.map((test) => {
    const file = files
      .map(asRecord)
      .find((item) => typeof item?.name === 'string' && item.name.endsWith(test.sourceFile));
    const assertionResults = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
    const assertion = assertionResults
      .map(asRecord)
      .find((item) => item?.title === test.name);
    const status = assertion?.status ?? file?.status;
    const perfStats = asRecord(file?.perfStats);
    const runtime = typeof perfStats?.runtime === 'number' ? perfStats.runtime : 0;
    const duration = typeof assertion?.duration === 'number' ? assertion.duration : runtime;
    const durationMs = Math.round(duration);
    return {
      id: test.id,
      state:
        status === 'passed'
          ? 'passed'
          : status === 'pending' || status === 'skipped'
            ? 'skipped'
            : processFailed
              ? 'failed'
              : 'unexecuted',
      durationMs,
      totalDurationMs: durationMs,
    };
  });
}

function playwrightResults(
  report: unknown,
  selected: CatalogTest[],
  processFailed: boolean,
): NormalizedResult[] {
  return normalizePlaywrightResults(report, selected, processFailed, root);
}

function plannedTests(selected: CatalogTest[]): PlannedTest[] {
  return selected.map(({ id, name, durationBudgetMs }) => ({ id, name, durationBudgetMs }));
}

function vitestWorkerCount(): number {
  const processors =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Same cap Vitest uses for a non-watch forks pool: one fewer than the available processors, at least one.
  return Math.max(processors - 1, 1);
}

function playwrightWorkerCount(mode: 'deterministic' | 'live'): number {
  const project = playwrightConfig.projects?.find((entry) => entry.name === mode);
  const workers = project?.workers;
  return typeof workers === 'number' && workers > 0 ? workers : 1;
}

function announceRun(selected: CatalogTest[], workers: number): string {
  const tests = plannedTests(selected);
  for (const line of introductionLines(tests, workers)) console.log(line);
  return JSON.stringify({ tests });
}

async function runNonBrowser(selected: CatalogTest[], runKey: string): Promise<Execution> {
  if (!selected.length) return { name: 'passed', exitCode: 0, durationMs: 0, results: [] };
  const workers = vitestWorkerCount();
  const output = path.join(resultsDirectory, `raw-vitest-${runKey}.json`);
  const processResult = await runProcess(
    'npx',
    [
      '--no-install',
      'vitest',
      'run',
      ...sourceFiles(selected),
      '--reporter=json',
      '--reporter=tests/support/reporting/vitest-progress-reporter.ts',
      `--outputFile.json=${output}`,
      '--maxWorkers',
      String(workers),
    ],
    { TNC_TEST_RUN_PLAN: announceRun(selected, workers) },
  );
  const results = vitestResults(await readJson(output), selected, processResult.exitCode !== 0);
  return {
    ...executionStatus(selected, results),
    durationMs: processResult.durationMs,
    results,
  };
}

async function runBrowser(
  selected: CatalogTest[],
  mode: 'deterministic' | 'live',
  runKey: string,
): Promise<Execution> {
  if (!selected.length) return { name: 'passed', exitCode: 0, durationMs: 0, results: [] };
  const report = path.join(resultsDirectory, `raw-playwright-${runKey}-${mode}.json`);
  const workers = playwrightWorkerCount(mode);
  const processResult = await runProcess(
    'npx',
    [
      '--no-install',
      'playwright',
      'test',
      ...sourceFiles(selected),
      `--project=${mode}`,
      '--reporter=json,tests/support/reporting/quiet-stdio-reporter.ts',
    ],
    {
      TNC_TEST_RUN_PLAN: announceRun(selected, workers),
      VITE_TEST_MODE: 'true',
      VITE_TEST_RENDERER: mode === 'deterministic' ? 'three' : 'arcgis',
      TNC_TEST_PORT: process.env.TNC_TEST_PORT ?? String(42000 + (process.pid % 10000)),
      TNC_PLAYWRIGHT_OUTPUT_DIR: path.join(
        resultsDirectory,
        `playwright-artifacts-${runKey}-${mode}`,
      ),
      PLAYWRIGHT_JSON_OUTPUT_FILE: report,
    },
  );
  const results = playwrightResults(await readJson(report), selected, processResult.exitCode !== 0);
  return {
    ...executionStatus(selected, results),
    durationMs: processResult.durationMs,
    results,
  };
}

async function execute(selected: CatalogTest[], runKey: string): Promise<Execution> {
  const nonBrowser = await runNonBrowser(
    selected.filter(({ environment }) => environment === 'non-browser'),
    runKey,
  );
  const deterministic = await runBrowser(
    selected.filter(({ browserMode }) => browserMode === 'deterministic'),
    'deterministic',
    runKey,
  );
  const live = await runBrowser(
    selected.filter(({ browserMode }) => browserMode === 'live'),
    'live',
    runKey,
  );
  const runs = [nonBrowser, deterministic, live];
  const results = runs.flatMap((run) => run.results);
  return {
    ...executionStatus(selected, results),
    durationMs: runs.reduce((total, run) => total + run.durationMs, 0),
    results,
  };
}

function lifecycleFor(test: CatalogTest | undefined): string {
  return testCatalog.features.find(({ id }) => id === test?.owner)?.lifecycle ?? 'not-applicable';
}

function recordedTestResult(result: NormalizedResult, timestamp: string) {
  const test = testCatalog.tests.find(({ id }) => id === result.id);
  return {
    ...result,
    timestamp,
    lifecycle: lifecycleFor(test),
    enforcement: test?.enforcement,
    ...(test ? { definitionFingerprint: testDefinitionFingerprint(test) } : {}),
  };
}

function pruneRetiredTestResults(latestTests: Record<string, unknown>) {
  const permanentTestIds = new Set(testCatalog.tests.map(({ id }) => id));
  for (const storedId of Object.keys(latestTests)) {
    if (!permanentTestIds.has(storedId)) {
      delete latestTests[storedId];
    }
  }
}

async function recordRun(
  command: string,
  selector: string | null,
  selected: CatalogTest[],
  execution: Execution,
  gateStatus?: string,
) {
  const timestamp = new Date().toISOString();
  // durationMs is the final attempt. Earlier attempts stay in totalDurationMs.
  const budgetWarnings = execution.results.flatMap((result) => {
    const test = testCatalog.tests.find(({ id }) => id === result.id);
    return test && result.durationMs > test.durationBudgetMs
      ? [{ id: result.id, measuredMs: result.durationMs, budgetMs: test.durationBudgetMs }]
      : [];
  });
  const latestFile = path.join(resultsDirectory, 'latest.json');
  const storedLatest = asRecord(await readJson(latestFile));
  const latestTests = asRecord(storedLatest?.tests) ?? {};
  const selectedTestIds = selected.map(({ id }) => id);
  const latest = {
    ...(storedLatest ?? {}),
    generatedAt: timestamp,
    lastCommand: command,
    lastSelector: selector,
    lastSelectedTestIds: selectedTestIds,
    lastCommandStatus: execution.name,
    lastCommandDurationMs: execution.durationMs,
    tests: latestTests,
    ...(gateStatus
      ? {
          gateStatus,
          gateGeneratedAt: timestamp,
          gateDurationMs: execution.durationMs,
          requiredGateDefinitionFingerprint: requiredGateDefinitionFingerprint(testCatalog.tests),
        }
      : {}),
  };
  pruneRetiredTestResults(latestTests);
  for (const result of execution.results) {
    latestTests[result.id] = recordedTestResult(result, timestamp);
  }
  await writeFile(latestFile, `${JSON.stringify(latest, null, 2)}\n`);

  const historyFile = path.join(resultsDirectory, 'history.json');
  const storedHistory = await readJson(historyFile);
  const history = Array.isArray(storedHistory) ? storedHistory : [];
  history.push({
    timestamp,
    command,
    selector,
    selectedTestIds,
    status: execution.name,
    durationMs: execution.durationMs,
    budgetWarnings,
    results: execution.results.map((result) => recordedTestResult(result, timestamp)),
    ...(gateStatus
      ? {
          gateStatus,
          gateGeneratedAt: timestamp,
          gateDurationMs: execution.durationMs,
          requiredGateDefinitionFingerprint: requiredGateDefinitionFingerprint(testCatalog.tests),
        }
      : {}),
  });
  await writeFile(historyFile, `${JSON.stringify(history.slice(-20), null, 2)}\n`);

  console.log('');
  for (const line of commandReportLines(
    testCatalog.tests,
    execution.results,
    commandReportUsesColor(),
  )) {
    console.log(line);
  }
  console.log(`Total time: ${formatWallClock(execution.durationMs)}`);
  for (const line of passedAfterRetryLines(execution.results)) console.log(line);
  if (budgetWarnings.length) {
    console.warn(`Duration budget warnings: ${JSON.stringify(budgetWarnings)}.`);
  }
}

async function runGate(): Promise<number> {
  const coreRequired = requiredTests('critical-core');
  const featureRequired = requiredTests('feature-behavior');
  // An empty Critical Core phase stays allowed when required Feature Behavior tests exist.
  // Zero required tests across both phases is inconclusive and is never stored as Passed.
  if (coreRequired.length === 0 && featureRequired.length === 0) {
    console.error('Release gate inconclusive: no required tests are configured.');
    await recordRun(
      'gate',
      null,
      [],
      { name: 'inconclusive', exitCode: 2, durationMs: 0, results: [] },
      'inconclusive',
    );
    return 2;
  }

  const executed: Array<{ selected: CatalogTest[]; execution: Execution }> = [];
  const gate = await runReleaseGate(async (phase) => {
    const selected =
      phase === 'core' ? requiredTests('critical-core') : requiredTests('feature-behavior');
    console.log(
      phase === 'core'
        ? 'Release gate phase 1/2: Critical Core.'
        : 'Release gate phase 2/2: required Feature Behavior tests.',
    );
    const execution = await execute(selected, `gate-${phase}-${Date.now()}`);
    executed.push({ selected, execution });
    return { status: execution.name, durationMs: execution.durationMs };
  });

  if (gate.diagnosticCommand) {
    console.error(`Release gate ${gate.status}. Diagnose with: ${gate.diagnosticCommand}`);
  }

  const exitCode = gate.status === 'passed' ? 0 : gate.status === 'inconclusive' ? 2 : 1;
  await recordRun(
    'gate',
    null,
    executed.flatMap((entry) => entry.selected),
    {
      name: gate.status,
      exitCode,
      durationMs: gate.phases.reduce((total, phase) => total + phase.result.durationMs, 0),
      results: executed.flatMap((entry) => entry.execution.results),
    },
    gate.status,
  );
  return exitCode;
}

await mkdir(resultsDirectory, { recursive: true });
await mkdir(cacheDirectory, { recursive: true });
console.log(`Test cache: ${cacheDirectory}.`);

try {
  const foundationErrors = await validateTestingFoundations(root, testCatalog);
  if (foundationErrors.length) throw new Error(foundationErrors.join('\n'));

  const mode = process.argv[2];
  const selector = process.argv[3];
  if (mode === 'gate') {
    process.exitCode = await runGate();
  } else {
    const selected = selectTests(mode, selector);
    if (mode === 'fast-only') {
      const excluded = testCatalog.tests.filter(
        (test) => isExecutable(test) && test.environment === 'non-browser' && !test.fast,
      );
      console.log(
        `Fast-only rule: declarative fast=true for non-browser tests. Excluded: ${
          excluded.map(({ id }) => id).join(', ') || 'none'
        }.`,
      );
    }
    const execution = await execute(selected, `${mode}-${Date.now()}`);
    let lintExitCode = 0;
    if (mode === 'all') {
      lintExitCode = (await runProcess('npm', ['run', 'lint'])).exitCode;
      const requiredReleaseTests = [
        ...requiredTests('critical-core'),
        ...requiredTests('feature-behavior'),
      ];
      const releaseEligibility =
        requiredReleaseTests.length === 0
          ? 'inconclusive; not verified'
          : requiredReleaseTests.every((test) =>
                execution.results.some(
                  (result) => result.id === test.id && result.state === 'passed',
                ),
              )
            ? 'passed'
            : 'not passed';
      console.log(
        `Release eligibility: ${releaseEligibility}. Diagnostic health: ${
          execution.exitCode === 0 && lintExitCode === 0 ? 'passed' : 'unsuccessful'
        }.`,
      );
    }
    await recordRun(mode, selector ?? null, selected, execution);
    process.exitCode = lintExitCode ? 1 : execution.exitCode;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
