import type { Reporter, TestCase } from 'vitest/node';
import { readableErrorLines, readRunPlan, RunProgress } from './run-progress.ts';

/** Prints catalog progress for a non-browser batch. The test runner prints the introduction. */
export default class VitestProgressReporter implements Reporter {
  private readonly progress = new RunProgress(readRunPlan(process.env.TNC_TEST_RUN_PLAN));

  onTestCaseResult(testCase: TestCase): void {
    if (this.progress.total === 0) return;
    const result = testCase.result();
    if (result.state === 'pending') return;
    const outcome = result.state === 'passed' ? 'passed' : result.state === 'skipped' ? 'skipped' : 'failed';
    const line = this.progress.finish(testCase.name, outcome);
    console.log(line ?? `A test finished outside this run: ${testCase.name}`);
    if (result.state !== 'failed') return;
    const message = result.errors?.[0]?.message;
    for (const errorLine of readableErrorLines(message)) console.log(errorLine);
  }
}
