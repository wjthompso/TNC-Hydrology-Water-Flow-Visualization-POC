import path from 'node:path';

export type FailedAttemptStatus = 'failed' | 'timedOut' | 'interrupted' | 'inconclusive';

export interface FailedAttemptRecord {
  attempt: number;
  status: FailedAttemptStatus;
  durationMs: number;
  errorMessage: string;
  errorLocation?: string;
  stdoutTail?: string;
  stderrTail?: string;
  artifacts: string[];
}

export interface NormalizedTestResult {
  id: string;
  state: string;
  durationMs: number;
  totalDurationMs: number;
  passedAfterRetry?: true;
  failedAttempts?: FailedAttemptRecord[];
}

export interface PlaywrightCatalogTarget {
  id: string;
  sourceFile: string;
  name: string;
}

const errorLineLimit = 20;
const stdioLineLimit = 40;
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '');
}

function limitedLines(value: string, limit: number, fromEnd: boolean): string {
  const lines = stripAnsi(value).split(/\r?\n/);
  const selected = fromEnd ? lines.slice(-limit) : lines.slice(0, limit);
  return selected.join('\n');
}

function toRepoRelative(filePath: string, repoRoot: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

function flattenPlaywrightSuites(
  suites: unknown,
  inheritedFile = '',
): Array<Record<string, unknown>> {
  if (!Array.isArray(suites)) return [];
  return suites.flatMap((suite) => {
    const record = asRecord(suite);
    const file = typeof record?.file === 'string' ? record.file : inheritedFile;
    const specs = Array.isArray(record?.specs) ? record.specs : [];
    return [
      ...specs.map((spec) => {
        const specRecord = asRecord(spec) ?? {};
        return {
          ...specRecord,
          file: typeof specRecord.file === 'string' ? specRecord.file : file,
        };
      }),
      ...flattenPlaywrightSuites(record?.suites, file),
    ];
  });
}

function errorEntries(attempt: Record<string, unknown>): Array<Record<string, unknown> | string> {
  const entries: Array<Record<string, unknown> | string> = [];
  if (typeof attempt.error === 'string' || asRecord(attempt.error)) {
    entries.push(attempt.error as Record<string, unknown> | string);
  }
  if (Array.isArray(attempt.errors)) {
    for (const error of attempt.errors) {
      if (typeof error === 'string' || asRecord(error)) {
        entries.push(error as Record<string, unknown> | string);
      }
    }
  }
  return entries;
}

function errorText(entry: Record<string, unknown> | string): string {
  if (typeof entry === 'string') return entry;
  return typeof entry.message === 'string' ? entry.message : '';
}

function attemptErrorMessage(attempt: Record<string, unknown>): string {
  return limitedLines(
    errorEntries(attempt).map(errorText).filter((text) => text.trim()).join('\n'),
    errorLineLimit,
    false,
  );
}

function attemptIsInconclusive(attempt: Record<string, unknown>): boolean {
  return errorEntries(attempt).some((entry) => errorText(entry).includes('INCONCLUSIVE:'));
}

function locationText(location: unknown, repoRoot: string): string | undefined {
  const record = asRecord(location);
  if (record && typeof record.file === 'string' && typeof record.line === 'number') {
    return `${toRepoRelative(record.file, repoRoot)}:${record.line}`;
  }
  if (typeof location === 'string' && location.includes(':')) return location;
  return undefined;
}

function attemptErrorLocation(
  attempt: Record<string, unknown>,
  repoRoot: string,
): string | undefined {
  for (const entry of errorEntries(attempt)) {
    if (typeof entry === 'string') continue;
    const fromEntry = locationText(entry.location, repoRoot);
    if (fromEntry) return fromEntry;
  }
  return locationText(attempt.errorLocation, repoRoot);
}

function stdioText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = asRecord(entry);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .join('');
}

function stdioTail(value: unknown): string | undefined {
  const text = limitedLines(stdioText(value), stdioLineLimit, true).trim();
  return text ? limitedLines(stdioText(value), stdioLineLimit, true) : undefined;
}

function isArtifactAttachment(attachment: Record<string, unknown>): boolean {
  const name = typeof attachment.name === 'string' ? attachment.name.toLowerCase() : '';
  if (name === 'stdout' || name === 'stderr') return false;
  if (name === 'trace' || name === 'screenshot' || name === 'video') return true;
  const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : '';
  return contentType.startsWith('image/') || contentType.startsWith('video/');
}

function attemptArtifacts(attempt: Record<string, unknown>, repoRoot: string): string[] {
  if (!Array.isArray(attempt.attachments)) return [];
  return attempt.attachments.flatMap((attachment) => {
    const record = asRecord(attachment);
    if (!record || typeof record.path !== 'string' || !isArtifactAttachment(record)) return [];
    return [toRepoRelative(record.path, repoRoot)];
  });
}

type AttemptClass = 'passed' | 'skipped' | FailedAttemptStatus | 'unknown';

function classifyAttempt(attempt: Record<string, unknown>): AttemptClass {
  if (attemptIsInconclusive(attempt)) return 'inconclusive';
  const status = attempt.status;
  if (
    status === 'passed' ||
    status === 'failed' ||
    status === 'timedOut' ||
    status === 'interrupted' ||
    status === 'skipped'
  ) {
    return status;
  }
  return 'unknown';
}

function attemptNumber(attempt: Record<string, unknown>, index: number): number {
  return typeof attempt.retry === 'number' ? attempt.retry + 1 : index + 1;
}

function failedAttemptRecord(
  attempt: Record<string, unknown>,
  index: number,
  repoRoot: string,
): FailedAttemptRecord {
  const status = classifyAttempt(attempt);
  const record: FailedAttemptRecord = {
    attempt: attemptNumber(attempt, index),
    status: status === 'passed' || status === 'skipped' || status === 'unknown' ? 'failed' : status,
    durationMs: Math.round(typeof attempt.duration === 'number' ? attempt.duration : 0),
    errorMessage: attemptErrorMessage(attempt),
    artifacts: attemptArtifacts(attempt, repoRoot),
  };
  const errorLocation = attemptErrorLocation(attempt, repoRoot);
  const stdoutTail = stdioTail(attempt.stdout);
  const stderrTail = stdioTail(attempt.stderr);
  if (errorLocation) record.errorLocation = errorLocation;
  if (stdoutTail) record.stdoutTail = stdoutTail;
  if (stderrTail) record.stderrTail = stderrTail;
  return record;
}

function specAttempts(spec: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const tests = Array.isArray(spec?.tests) ? spec.tests : [];
  return tests
    .flatMap((test) => {
      const results = asRecord(test)?.results;
      return Array.isArray(results) ? results : [];
    })
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .sort((first, second) => attemptNumber(first, 0) - attemptNumber(second, 0));
}

function durationOf(attempt: Record<string, unknown> | undefined): number {
  return Math.round(typeof attempt?.duration === 'number' ? attempt.duration : 0);
}

/**
 * A browser test's stored state is its final attempt. An earlier failure,
 * timeout, interruption, or inconclusive attempt stays on the result when
 * that final attempt passed.
 */
export function normalizePlaywrightResults(
  report: unknown,
  selected: PlaywrightCatalogTarget[],
  processFailed: boolean,
  repoRoot: string,
): NormalizedTestResult[] {
  const specs = flattenPlaywrightSuites(asRecord(report)?.suites);
  return selected.map((catalogTest) => {
    const spec = specs.find((candidate) => {
      const file = typeof candidate.file === 'string' ? candidate.file : '';
      return (
        (file.endsWith(catalogTest.sourceFile) || catalogTest.sourceFile.endsWith(file)) &&
        candidate.title === catalogTest.name
      );
    });
    const attempts = specAttempts(spec);
    const totalDurationMs = attempts.reduce((total, attempt) => total + durationOf(attempt), 0);
    const finalAttempt = attempts.at(-1);
    const base = {
      id: catalogTest.id,
      durationMs: durationOf(finalAttempt),
      totalDurationMs,
    };
    if (!finalAttempt) {
      return {
        ...base,
        state: processFailed ? 'failed' : 'unexecuted',
      };
    }

    const finalClass = classifyAttempt(finalAttempt);
    if (finalClass === 'passed') {
      const failedAttempts = attempts.slice(0, -1).flatMap((attempt, index) => {
        const status = classifyAttempt(attempt);
        if (status !== 'failed' && status !== 'timedOut' && status !== 'interrupted' && status !== 'inconclusive') {
          return [];
        }
        return [failedAttemptRecord(attempt, index, repoRoot)];
      });
      if (failedAttempts.length) {
        return {
          ...base,
          state: 'passed',
          passedAfterRetry: true,
          failedAttempts,
        };
      }
      return { ...base, state: 'passed' };
    }
    if (finalClass === 'inconclusive') return { ...base, state: 'inconclusive' };
    if (finalClass === 'skipped') return { ...base, state: 'skipped' };
    if (finalClass === 'failed' || finalClass === 'timedOut' || finalClass === 'interrupted') {
      return { ...base, state: 'failed' };
    }
    return { ...base, state: processFailed ? 'failed' : 'unexecuted' };
  });
}

export function executionStatus(
  selected: Array<{ id: string; enforcement: string }>,
  results: Array<{ id: string; state: string }>,
): { name: 'passed' | 'failed' | 'inconclusive'; exitCode: number } {
  const requiredStates = results
    .filter(({ id }) => selected.some((test) => test.id === id && test.enforcement === 'required'))
    .map(({ state }) => state);
  if (results.some(({ state }) => state === 'failed')) {
    return { name: 'failed', exitCode: 1 };
  }
  if (requiredStates.some((state) => ['inconclusive', 'skipped', 'unexecuted'].includes(state))) {
    return { name: 'inconclusive', exitCode: 2 };
  }
  return { name: 'passed', exitCode: 0 };
}

function firstErrorLine(errorMessage: string): string {
  return errorMessage.split(/\r?\n/).find((line) => line.trim()) ?? '';
}

export function passedAfterRetryLines(results: NormalizedTestResult[]): string[] {
  return results.flatMap((result) => {
    if (!result.passedAfterRetry) return [];
    return (result.failedAttempts ?? []).map((attempt) => {
      const artifacts = attempt.artifacts.length ? attempt.artifacts.join(', ') : 'none';
      return `PASSED AFTER RETRY ${result.id}: attempt ${attempt.attempt} failed (${attempt.status}) - ${firstErrorLine(attempt.errorMessage)} - artifacts: ${artifacts}`;
    });
  });
}
