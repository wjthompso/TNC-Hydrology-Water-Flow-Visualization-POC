import path from 'node:path';

/**
 * A bounded, ANSI-free record of why a test did not pass. It is stored on a
 * failed or inconclusive result (the final attempt) and on a passed-after-retry
 * result (the last failed attempt). The catalog page renders it under
 * "Error logs" and copies it as Markdown for an LLM.
 */
export interface FailureLog {
  attempt: number;
  status: string;
  durationMs: number;
  /** Error text without stack frames. */
  errorMessage: string;
  /** Repository-relative `file:line` of the failing step, when known. */
  errorLocation?: string;
  /** Up to `stackLineLimit` frames, repository code first, node_modules and node internals removed. */
  stackLines?: string[];
  stdoutTail?: string;
  stderrTail?: string;
  screenshotPath?: string;
  tracePath?: string;
  /** Playwright's page snapshot at failure (error-context.md). */
  errorContextPath?: string;
  /** Stamped by the runner: the command that produced this result. */
  command?: string;
  /** Stamped by the runner: the raw report and artifact key for this run. */
  runId?: string;
  /** Stamped by the runner: the result timestamp. */
  recordedAt?: string;
}

const messageLineLimit = 40;
const stackLineLimit = 12;
const stdioLineLimit = 40;
/** Hard cap per text field so latest.json and history.json stay small. */
const fieldCharacterLimit = 4000;

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const stackFramePattern = /^\s*at\s/;

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '');
}

export function limitedLines(value: string, limit: number, fromEnd: boolean): string {
  const lines = stripAnsi(value).split(/\r?\n/);
  const selected = fromEnd ? lines.slice(-limit) : lines.slice(0, limit);
  return selected.join('\n');
}

function capCharacters(value: string, fromEnd: boolean): string {
  if (value.length <= fieldCharacterLimit) return value;
  return fromEnd
    ? `…${value.slice(-fieldCharacterLimit)}`
    : `${value.slice(0, fieldCharacterLimit)}…`;
}

export function toRepoRelative(filePath: string, repoRoot: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

/**
 * Error text with stack frames removed, trimmed and bounded. Playwright repeats
 * the same message in `message`, `stack`, and a `[cause]:` line, so a nonblank
 * line already shown is dropped; the code frame and first occurrence stay.
 */
export function failureMessageText(texts: string[]): string {
  const unique = [...new Set(texts.map((text) => stripAnsi(text).trimEnd()).filter(Boolean))];
  const seenLines = new Set<string>();
  const withoutFrames = unique
    .join('\n\n')
    .split(/\r?\n/)
    .filter((line) => !stackFramePattern.test(line))
    .map((line) => line.replace(/^\[cause\]: /, ''))
    .filter((line) => {
      const key = line.trim();
      if (!key) return true;
      if (seenLines.has(key)) return false;
      seenLines.add(key);
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return capCharacters(limitedLines(withoutFrames, messageLineLimit, false), false);
}

/** The most relevant stack frames: repository code, without node_modules or node internals. */
export function relevantStackLines(texts: string[], repoRoot: string): string[] {
  const frames = texts
    .flatMap((text) => stripAnsi(text).split(/\r?\n/))
    .filter((line) => stackFramePattern.test(line))
    .map((line) => line.trim())
    .filter(
      (line) =>
        !line.includes('node_modules') &&
        !line.includes('node:internal') &&
        !line.includes('<anonymous>'),
    )
    .map((line) => line.split(repoRoot + path.sep).join(''));
  return [...new Set(frames)].slice(0, stackLineLimit);
}

/** The last lines of captured stdout or stderr, bounded. */
export function outputTail(text: string): string | undefined {
  const tail = limitedLines(text, stdioLineLimit, true);
  return tail.trim() ? capCharacters(tail, true) : undefined;
}

/** First repository `file:line` found in stack frames, for runners that report no location. */
export function locationFromStack(stackLines: string[]): string | undefined {
  for (const line of stackLines) {
    const match = /\(?([^\s()]+\.(?:ts|js|mjs)):(\d+):\d+\)?$/.exec(line);
    if (match && match[1].startsWith('tests/')) return `${match[1]}:${match[2]}`;
  }
  return undefined;
}

/** The npm command the runner was invoked through, such as `npm run test:id -- FBT-009`. */
export function runnerCommandText(
  mode: string,
  selector: string | undefined,
  headed: boolean,
): string {
  const extra = [selector, headed ? '--headed' : undefined].filter(Boolean);
  return `npm run test:${mode}${extra.length ? ` -- ${extra.join(' ')}` : ''}`;
}
