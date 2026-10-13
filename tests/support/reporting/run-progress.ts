import { formatWallClock } from './command-report.ts';

export interface PlannedTest {
  id: string;
  name: string;
  durationBudgetMs: number;
}

function testsWord(count: number): string {
  return count === 1 ? 'test' : 'tests';
}

function formatBudget(milliseconds: number): string {
  if (milliseconds <= 0) return '0 s';
  return formatWallClock(milliseconds);
}

export function maximumDurationMs(tests: readonly PlannedTest[]): number {
  return tests.reduce((total, test) => total + test.durationBudgetMs, 0);
}

export function introductionLines(tests: readonly PlannedTest[], workers: number): string[] {
  const total = tests.length;
  const budgetMs = maximumDurationMs(tests);
  return [
    `About to run ${total} ${testsWord(total)}.`,
    `Maximum duration is ${formatBudget(budgetMs)}.`,
    `Running with ${workers} ${workers === 1 ? 'worker' : 'workers'}.`,
    progressSentence({ completed: 0, total, remainingBudgetMs: budgetMs }),
  ];
}

export function progressSentence(input: {
  completed: number;
  total: number;
  remainingBudgetMs: number;
  finished?: { id: string; outcome: string };
}): string {
  const count = `${input.completed} / ${input.total} ${testsWord(input.total)} complete.`;
  const remaining = `Up to ${formatBudget(input.remainingBudgetMs)} remaining.`;
  if (!input.finished) return `${count} ${remaining}`;
  return `${count} ${input.finished.id} ${input.finished.outcome}. ${remaining}`;
}

export function readableErrorLines(message: string | undefined): string[] {
  if (!message) return [];
  const ansiPattern = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
  const lines = message
    .replace(ansiPattern, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('at '));
  return lines.slice(0, 8).map((line) => `  ${line}`);
}

export function readRunPlan(raw: string | undefined): PlannedTest[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { tests?: unknown };
    if (!Array.isArray(parsed.tests)) return [];
    return parsed.tests.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as Record<string, unknown>;
      if (
        typeof record.id !== 'string' ||
        typeof record.name !== 'string' ||
        typeof record.durationBudgetMs !== 'number'
      ) {
        return [];
      }
      return [
        {
          id: record.id,
          name: record.name,
          durationBudgetMs: record.durationBudgetMs,
        },
      ];
    });
  } catch {
    return [];
  }
}

export class RunProgress {
  private readonly waiting = new Map<string, PlannedTest[]>();
  private remainingBudgetMs: number;
  private completed = 0;
  readonly total: number;

  constructor(tests: readonly PlannedTest[]) {
    this.total = tests.length;
    this.remainingBudgetMs = maximumDurationMs(tests);
    for (const test of tests) {
      const queue = this.waiting.get(test.name) ?? [];
      queue.push(test);
      this.waiting.set(test.name, queue);
    }
  }

  idFor(name: string): string | undefined {
    return this.waiting.get(name)?.[0]?.id;
  }

  finish(name: string, outcome: string): string | null {
    const queue = this.waiting.get(name);
    const test = queue?.shift();
    if (!test) return null;
    if (queue && queue.length === 0) this.waiting.delete(name);
    this.remainingBudgetMs = Math.max(0, this.remainingBudgetMs - test.durationBudgetMs);
    this.completed += 1;
    return progressSentence({
      completed: this.completed,
      total: this.total,
      remainingBudgetMs: this.remainingBudgetMs,
      finished: { id: test.id, outcome },
    });
  }
}
