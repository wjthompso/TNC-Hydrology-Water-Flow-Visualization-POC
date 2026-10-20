import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import {
  ProgressLine,
  readableErrorLines,
  readRunPlan,
  runPlanUsesInPlaceProgress,
  RunProgress,
} from './run-progress.ts';

/**
 * Prints run progress for a catalog batch and keeps Playwright's truncating
 * line reporter off. Scene measurement logs stay out of the live log.
 * The closing catalog summary is printed by the test runner.
 */
export default class QuietStdioReporter implements Reporter {
  private readonly progress: RunProgress;
  private readonly output: ProgressLine;

  constructor() {
    const runPlan = process.env.TNC_TEST_RUN_PLAN;
    this.progress = new RunProgress(readRunPlan(runPlan));
    this.output = new ProgressLine(
      this.progress.initialLine(),
      runPlanUsesInPlaceProgress(runPlan) && this.progress.total > 0,
    );
  }

  printsToStdio(): boolean {
    return true;
  }

  onStdOut(chunk: string | Buffer): void {
    if (this.progress.total === 0) process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    if (this.progress.total === 0) process.stderr.write(chunk);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.progress.total === 0) return;
    const id = this.progress.idFor(test.title) ?? test.title;
    if (attemptWillRetry(test, result)) {
      this.output.writePersistentLine(`${id} did not pass. Trying again.`);
      return;
    }
    const line = this.progress.finish(test.title, outcomeWord(result.status));
    if (line) {
      this.output.update(line, this.progress.isComplete());
    } else {
      this.output.writePersistentLine(`A test finished outside this run: ${test.title}`);
    }
    if (result.status !== 'passed' && result.status !== 'skipped') {
      for (const errorLine of readableErrorLines(result.error?.message)) {
        this.output.writePersistentLine(errorLine);
      }
    }
  }

  onEnd(): void {
    this.output.finish();
  }
}

function attemptWillRetry(test: TestCase, result: TestResult): boolean {
  if (result.status === 'passed' || result.status === 'skipped') return false;
  return result.retry < test.retries;
}

function outcomeWord(status: TestResult['status']): string {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  if (status === 'timedOut') return 'timed out';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}
