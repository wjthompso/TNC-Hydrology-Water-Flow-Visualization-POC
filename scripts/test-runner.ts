import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
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
  failureMessageText,
  locationFromStack,
  relevantStackLines,
  runnerCommandText,
  type FailureLog,
} from '../tests/support/reporting/failure-log.ts';
import {
  requiredGateDefinitionFingerprint,
  testDefinitionFingerprint,
} from '../tests/support/reporting/test-definition-fingerprint.ts';
import {
  introductionLines,
  type PlannedTest,
} from '../tests/support/reporting/run-progress.ts';
import { RESPONSE_CACHE_FOLDERS } from '../tests/support/browser/response-cache/cache-location.ts';
import { validateTestingFoundations } from '../tests/support/validation/foundations.ts';

const root = process.cwd();
const resultsDirectory = path.join(root, '.test-results');
const cacheDirectory = process.env.TNC_TEST_CACHE_DIR
  ? path.resolve(process.env.TNC_TEST_CACHE_DIR)
  : path.join(root, '.test-cache');
const testCatalog = JSON.parse(
  await readFile(path.join(root, 'tests/support/catalog/test-catalog.json'), 'utf8'),
) as TestCatalog;

interface CommandLine {
  /** Same typing as the former `process.argv[2]`; `selectTests` rejects a missing mode. */
  mode: string;
  selector: string | undefined;
  /** Playwright opens visible browser windows, one per worker. Selection and recording are unchanged. */
  headed: boolean;
  /** Playwright UI mode opens the selected browser tests interactively. Nothing is recorded. */
  ui: boolean;
  /** With `--ui`, press UI mode's "Run all" button as soon as the window opens. */
  autorun: boolean;
}

const browserViewingFlags = new Set(['--headed', '--ui', '--autorun']);

// `--headed`, `--ui`, and `--autorun` may appear before or after the selector. Other arguments keep their positions.
function parseCommandLine(argv: string[]): CommandLine {
  const positional = argv.filter((argument) => !browserViewingFlags.has(argument));
  return {
    mode: positional[0],
    selector: positional[1],
    headed: argv.includes('--headed'),
    ui: argv.includes('--ui'),
    autorun: argv.includes('--autorun'),
  };
}

const commandLine = parseCommandLine(process.argv.slice(2));

type ExecutionStateName = 'passed' | 'failed' | 'inconclusive';

type NormalizedResult = NormalizedTestResult;

interface Execution {
  name: ExecutionStateName;
  exitCode: number;
  durationMs: number;
  results: NormalizedResult[];
}

const isExecutable = (test: CatalogTest) => test.enforcement !== 'disabled';
const catalogTestIdentifier = /^(?:FBT|FST|CCT|SST)-\d+$/;

function explicitCatalogTest(selector: string | undefined): CatalogTest | null {
  if (!selector || !catalogTestIdentifier.test(selector)) return null;
  const test = testCatalog.tests.find(({ id }) => id === selector);
  if (!test) throw new Error(`Unknown test identifier: ${selector}.`);
  return test;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
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
    case 'refresh-map-cache':
      return enabled.filter((test) => test.browserMode === 'live');
    case 'browser-all':
      return enabled.filter((test) => test.environment === 'browser');
    case 'id': {
      const named = explicitCatalogTest(selector);
      if (!named) {
        throw new Error(`Unknown test identifier: ${selector ?? '(missing)'}.`);
      }
      return [named];
    }
    case 'feature': {
      const named = explicitCatalogTest(selector);
      if (named) return [named];
      if (!testCatalog.features.some(({ id }) => id === selector)) {
        throw new Error(`Unknown Feature selector: ${selector ?? '(missing)'}.`);
      }
      return enabled.filter((test) => associatedWithFeature(test, selector ?? ''));
    }
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
    const state =
      status === 'passed'
        ? 'passed'
        : status === 'pending' || status === 'skipped'
          ? 'skipped'
          : processFailed
            ? 'failed'
            : 'unexecuted';
    const result: NormalizedResult = { id: test.id, state, durationMs, totalDurationMs: durationMs };
    if (state === 'failed') {
      result.failureLog = vitestFailureLog(assertion, file, durationMs);
    }
    return result;
  });
}

/** Vitest has no attempts or artifacts; its failure messages carry the error and stack. */
function vitestFailureLog(
  assertion: Record<string, unknown> | null | undefined,
  file: Record<string, unknown> | null | undefined,
  durationMs: number,
): FailureLog {
  const failureMessages = Array.isArray(assertion?.failureMessages)
    ? assertion.failureMessages.filter((text): text is string => typeof text === 'string')
    : [];
  // A file-level error (such as an import failure) has no assertion entry.
  const texts = failureMessages.length
    ? failureMessages
    : typeof file?.message === 'string'
      ? [file.message]
      : [];
  const stackLines = relevantStackLines(texts, root);
  const log: FailureLog = {
    attempt: 1,
    status: 'failed',
    durationMs,
    errorMessage: failureMessageText(texts) || 'Vitest reported a failure without a message.',
  };
  const errorLocation = locationFromStack(stackLines);
  if (errorLocation) log.errorLocation = errorLocation;
  if (stackLines.length) log.stackLines = stackLines;
  return log;
}

/** Records which run produced each error log, so the catalog can find its raw report and artifacts. */
function stampRunId(results: NormalizedResult[], runId: string): NormalizedResult[] {
  return results.map((result) =>
    result.failureLog ? { ...result, failureLog: { ...result.failureLog, runId } } : result,
  );
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
  const inPlaceProgress = process.stdout.isTTY === true;
  for (const line of introductionLines(tests, workers, !inPlaceProgress)) console.log(line);
  return JSON.stringify({ tests, inPlaceProgress });
}

async function runNonBrowser(
  selected: CatalogTest[],
  runKey: string,
  titlePattern?: string,
): Promise<Execution> {
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
      ...(titlePattern ? ['--testNamePattern', titlePattern] : []),
      '--reporter=json',
      '--reporter=tests/support/reporting/vitest-progress-reporter.ts',
      `--outputFile.json=${output}`,
      '--maxWorkers',
      String(workers),
    ],
    { TNC_TEST_RUN_PLAN: announceRun(selected, workers) },
  );
  const results = stampRunId(
    vitestResults(await readJson(output), selected, processResult.exitCode !== 0),
    runKey,
  );
  return {
    ...executionStatus(selected, results),
    durationMs: processResult.durationMs,
    results,
  };
}

function playwrightSelectionArguments(
  selected: CatalogTest[],
  mode: 'deterministic' | 'live',
  titlePattern?: string,
): string[] {
  return [
    '--no-install',
    'playwright',
    'test',
    ...sourceFiles(selected),
    `--project=${mode}`,
    ...(titlePattern ? ['--grep', titlePattern] : []),
    ...(commandLine.headed ? ['--headed'] : []),
  ];
}

function playwrightEnvironment(
  mode: 'deterministic' | 'live',
  runKey: string,
): Record<string, string> {
  return {
    TNC_TEST_CACHE_DIR: cacheDirectory,
    VITE_TEST_MODE: 'true',
    VITE_TEST_RENDERER: mode === 'deterministic' ? 'three' : 'arcgis',
    TNC_TEST_PORT: process.env.TNC_TEST_PORT ?? String(42000 + (process.pid % 10000)),
    TNC_PLAYWRIGHT_OUTPUT_DIR: path.join(resultsDirectory, `playwright-artifacts-${runKey}-${mode}`),
  };
}

async function runBrowser(
  selected: CatalogTest[],
  mode: 'deterministic' | 'live',
  runKey: string,
  titlePattern?: string,
): Promise<Execution> {
  if (!selected.length) return { name: 'passed', exitCode: 0, durationMs: 0, results: [] };
  const report = path.join(resultsDirectory, `raw-playwright-${runKey}-${mode}.json`);
  const workers = playwrightWorkerCount(mode);
  const processResult = await runProcess(
    'npx',
    [
      ...playwrightSelectionArguments(selected, mode, titlePattern),
      '--reporter=json,tests/support/reporting/quiet-stdio-reporter.ts',
    ],
    {
      ...playwrightEnvironment(mode, runKey),
      TNC_TEST_RUN_PLAN: announceRun(selected, workers),
      PLAYWRIGHT_JSON_OUTPUT_FILE: report,
    },
  );
  const results = stampRunId(
    playwrightResults(await readJson(report), selected, processResult.exitCode !== 0),
    `${runKey}-${mode}`,
  );
  return {
    ...executionStatus(selected, results),
    durationMs: processResult.durationMs,
    results,
  };
}

/**
 * Playwright UI mode has no run-on-open setting. This serves the same UI app on a free local port
 * (`--ui-port=0`), opens it in a Chromium app window, and presses its "Run all" button.
 * Playwright skips its own browser tab when COPILOT_CLI is set, so only our window opens.
 */
async function openUiModeAndRun(
  playwrightArguments: string[],
  environment: Record<string, string>,
): Promise<number> {
  const server = spawn('npx', [...playwrightArguments, '--ui', '--ui-port=0'], {
    cwd: root,
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, ...environment, COPILOT_CLI: '1' },
  });
  const serverExit = new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.on('exit', (code) => resolve(code ?? 1));
  });
  const uiAddress = new Promise<string>((resolve, reject) => {
    let output = '';
    server.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString();
      const match = /Listening on (http:\/\/\S+)/.exec(output);
      if (match) resolve(match[1]);
    });
    void serverExit.then(() => reject(new Error('Playwright UI mode exited before it started.')));
  });

  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'tnc-playwright-ui-'));
  try {
    const address = await uiAddress;
    const context = await chromium.launchPersistentContext(profileDirectory, {
      headless: false,
      viewport: null,
      args: [`--app=${address}`, '--window-size=1280,800'],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    // The button is disabled until the test list has loaded; click retries until it is enabled.
    await page.getByTitle(/^Run all/).click({ timeout: 60_000 });
    console.log('Pressed Run all in Playwright UI mode. Close the window to finish.');
    await new Promise<void>((resolve) => context.on('close', () => resolve()));
  } finally {
    server.kill('SIGINT');
    await serverExit.catch(() => 1);
    await rm(profileDirectory, { recursive: true, force: true });
  }
  return 0;
}

/**
 * Opens Playwright UI mode for the browser tests this command selected, one browser mode at a time.
 * UI mode is interactive and has no machine-readable report, so nothing is recorded.
 */
async function openUiMode(
  selected: CatalogTest[],
  runKey: string,
  titlePattern?: string,
): Promise<number> {
  const nonBrowserCount = selected.filter(({ environment }) => environment === 'non-browser').length;
  if (nonBrowserCount) {
    console.log(`UI mode opens browser tests only. ${nonBrowserCount} non-browser tests do not run.`);
  }
  let exitCode = 0;
  for (const mode of ['deterministic', 'live'] as const) {
    const browserTests = selected.filter(({ browserMode }) => browserMode === mode);
    if (!browserTests.length) continue;
    console.log(
      `Opening Playwright UI mode for ${browserTests.length} ${mode} browser tests. Close the window to continue.`,
    );
    const selectionArguments = playwrightSelectionArguments(browserTests, mode, titlePattern);
    const environment = playwrightEnvironment(mode, runKey);
    if (commandLine.autorun) {
      exitCode ||= await openUiModeAndRun(selectionArguments, environment);
      continue;
    }
    const processResult = await runProcess('npx', [...selectionArguments, '--ui'], environment);
    exitCode ||= processResult.exitCode;
  }
  console.log(
    'The UI-mode session was interactive. Its results are not recorded and never count toward release.',
  );
  return exitCode;
}

async function execute(
  selected: CatalogTest[],
  runKey: string,
  titlePattern?: string,
): Promise<Execution> {
  const nonBrowser = await runNonBrowser(
    selected.filter(({ environment }) => environment === 'non-browser'),
    runKey,
    titlePattern,
  );
  const deterministic = await runBrowser(
    selected.filter(({ browserMode }) => browserMode === 'deterministic'),
    'deterministic',
    runKey,
    titlePattern,
  );
  const live = await runBrowser(
    selected.filter(({ browserMode }) => browserMode === 'live'),
    'live',
    runKey,
    titlePattern,
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

/** The npm command this process was started as, recorded on each error log. */
const invokedCommand = runnerCommandText(
  commandLine.mode,
  commandLine.selector,
  commandLine.headed,
);

function recordedTestResult(result: NormalizedResult, timestamp: string) {
  const test = testCatalog.tests.find(({ id }) => id === result.id);
  return {
    ...result,
    ...(result.failureLog
      ? {
          failureLog: { ...result.failureLog, command: invokedCommand, recordedAt: timestamp },
        }
      : {}),
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

  const { mode, selector } = commandLine;
  if (mode === 'gate') {
    if (commandLine.ui || commandLine.autorun) {
      throw new Error('test:gate does not accept --ui. Release verification cannot be interactive.');
    }
    if (commandLine.headed) {
      console.log('Headed release gate: browser windows are visible, so browser tests run slower.');
    }
    process.exitCode = await runGate();
  } else {
    const selected = selectTests(mode, selector);
    const selectsBrowserTests = selected.some(({ environment }) => environment === 'browser');
    if (commandLine.autorun && !commandLine.ui) {
      throw new Error('--autorun needs --ui. It presses Run all in Playwright UI mode.');
    }
    if (commandLine.ui && !selectsBrowserTests) {
      throw new Error('--ui opens browser tests only, and this command selected none.');
    }
    if (commandLine.headed && !commandLine.ui && !selectsBrowserTests) {
      console.log('--headed has no effect: this command selected no browser tests.');
    }
    if (mode === 'refresh-map-cache') {
      // Clear every source in the live response cache (Esri and USGS 3DEP terrain).
      for (const folder of RESPONSE_CACHE_FOLDERS) {
        const savedResponses = path.join(cacheDirectory, folder);
        await rm(savedResponses, { recursive: true, force: true });
        console.log(`Deleted saved responses in ${savedResponses}.`);
      }
      console.log('Every live browser test will download them again.');
    }
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
    const directTest =
      selected.length === 1 && selected[0]?.id === selector ? selected[0] : undefined;
    if (directTest?.enforcement === 'disabled') {
      console.log(
        `${directTest.id} is disabled. This direct check runs it and leaves feature commands and the release gate unchanged.`,
      );
    }
    const titlePattern = directTest ? escapeRegExp(directTest.name) : undefined;
    if (commandLine.ui) {
      process.exitCode = await openUiMode(selected, `${mode}-ui-${Date.now()}`, titlePattern);
    } else {
      const execution = await execute(selected, `${mode}-${Date.now()}`, titlePattern);
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
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
