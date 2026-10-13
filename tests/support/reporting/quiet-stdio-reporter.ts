import type { Reporter } from '@playwright/test/reporter';

/**
 * Keeps test logs on the terminal and tells Playwright not to add its
 * truncating line reporter. The command summary is printed by the test runner.
 */
export default class QuietStdioReporter implements Reporter {
  printsToStdio(): boolean {
    return true;
  }

  onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }
}
