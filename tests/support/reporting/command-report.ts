import type { CatalogTest } from '../catalog/test-catalog.ts';
import type { NormalizedTestResult } from './playwright-results.ts';

const green = '\u001b[32m';
const red = '\u001b[31m';
const reset = '\u001b[0m';
const durationColumnWidth = 7;

type StatusLabel = 'PASSED' | 'PASSED after retry' | 'FAILED' | 'INCONCLUSIVE' | 'NOT RUN';

interface StatusView {
  label: StatusLabel;
  passed: boolean;
  durationMs: number | null;
}

function paint(text: string, color: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${color}${text}${reset}`;
}

function statusView(result: NormalizedTestResult | undefined): StatusView {
  if (!result || result.state === 'unexecuted' || result.state === 'skipped') {
    return { label: 'NOT RUN', passed: false, durationMs: null };
  }
  if (result.state === 'passed' && result.passedAfterRetry) {
    return { label: 'PASSED after retry', passed: true, durationMs: result.durationMs };
  }
  if (result.state === 'passed') {
    return { label: 'PASSED', passed: true, durationMs: result.durationMs };
  }
  if (result.state === 'inconclusive') {
    return { label: 'INCONCLUSIVE', passed: false, durationMs: result.durationMs };
  }
  if (result.state === 'failed') {
    return { label: 'FAILED', passed: false, durationMs: result.durationMs };
  }
  return { label: 'NOT RUN', passed: false, durationMs: null };
}

function wrapWords(text: string, width: number): string[] {
  const limit = Math.max(width, 24);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > limit) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function testEntry(
  test: CatalogTest,
  status: StatusView,
  idWidth: number,
  columns: number,
  color: boolean,
): string[] {
  const duration =
    status.durationMs === null
      ? ''.padStart(durationColumnWidth)
      : formatSeconds(status.durationMs).padStart(durationColumnWidth);
  const heading = `${test.id.padEnd(idWidth)}  ${duration}  ${status.label}`;
  const titleLines = wrapWords(test.name, columns - 2).map((line) => `  ${line}`);
  return [heading, ...titleLines].map((line) => paint(line, status.passed ? green : red, color));
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds >= 1) return `${seconds.toFixed(1)} s`;
  return `${seconds.toFixed(3)} s`;
}

export function formatWallClock(milliseconds: number): string {
  if (milliseconds < 60000) return formatSeconds(milliseconds);
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${seconds} s`;
}

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function categoryOrder(category: CatalogTest['category']): number {
  if (category === 'feature-behavior') return 0;
  if (category === 'critical-core') return 1;
  if (category === 'feature-supporting') return 2;
  return 3;
}

interface Tally {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  notRun: number;
}

function tally(tests: CatalogTest[], resultsById: Map<string, NormalizedTestResult>): Tally {
  const counts: Tally = { total: tests.length, passed: 0, failed: 0, inconclusive: 0, notRun: 0 };
  for (const test of tests) {
    const label = statusView(resultsById.get(test.id)).label;
    if (label === 'PASSED' || label === 'PASSED after retry') counts.passed += 1;
    else if (label === 'FAILED') counts.failed += 1;
    else if (label === 'INCONCLUSIVE') counts.inconclusive += 1;
    else counts.notRun += 1;
  }
  return counts;
}

function outcomeLines(
  counts: Tally,
  singular: string,
  plural: string,
  includePassedRatio: boolean,
): string[] {
  const lines: string[] = [];
  if (includePassedRatio) {
    lines.push(
      `${counts.passed} / ${counts.total} ${counts.total === 1 ? singular : plural} passed`,
    );
  }
  if (counts.failed > 0) lines.push(`${countPhrase(counts.failed, singular, plural)} failed`);
  if (counts.inconclusive > 0) {
    lines.push(`${countPhrase(counts.inconclusive, singular, plural)} inconclusive`);
  }
  lines.push(`${countPhrase(counts.notRun, singular, plural)} not run`);
  return lines;
}

export function commandReportLines(
  tests: CatalogTest[],
  results: NormalizedTestResult[],
  color: boolean,
  columns = process.stdout.columns || 100,
): string[] {
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const ordered = [...tests].sort(
    (first, second) => categoryOrder(first.category) - categoryOrder(second.category),
  );
  const idWidth = ordered.reduce((width, test) => Math.max(width, test.id.length), 0);
  const lines = ordered.flatMap((test) =>
    testEntry(test, statusView(resultsById.get(test.id)), idWidth, columns, color),
  );
  const featureBehavior = tally(
    tests.filter((test) => test.category === 'feature-behavior'),
    resultsById,
  );
  const core = tally(
    tests.filter((test) => test.category === 'critical-core'),
    resultsById,
  );
  const supporting = tally(
    tests.filter(
      (test) =>
        test.category === 'feature-supporting' || test.category === 'shared-supporting',
    ),
    resultsById,
  );
  const summary = [
    ...outcomeLines(featureBehavior, 'FBT test', 'FBT tests', true),
    ...outcomeLines(core, 'Core test', 'Core tests', false),
    ...outcomeLines(supporting, 'Supporting test', 'Supporting tests', false),
  ];
  const last = summary.length - 1;
  summary[last] = `${summary[last]}.`;
  return [...lines, '', ...summary];
}

export function commandReportUsesColor(): boolean {
  if (process.env.NO_COLOR && !process.env.FORCE_COLOR) return false;
  return Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR);
}
