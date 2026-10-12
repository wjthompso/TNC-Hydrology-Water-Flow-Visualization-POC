import { defineConfig, devices } from '@playwright/test';
import { deterministicRequestAllowlist } from './tests/support/browser/deterministic-allowlist';

type DeterministicProjectOptions = {
  deterministicRequestAllowlist: string[];
};

const testPort = process.env.TNC_TEST_PORT ?? '4177';
const testBaseUrl = `http://127.0.0.1:${testPort}`;
const artifactDirectory =
  process.env.TNC_PLAYWRIGHT_OUTPUT_DIR ??
  '.test-results/playwright-artifacts';

export default defineConfig<DeterministicProjectOptions>({
  testDir: './tests',
  testIgnore: '**/*.example.spec.ts',
  outputDir: artifactDirectory,
  fullyParallel: false,
  // Keep every attempt directory. A failed attempt's trace and screenshot stay
  // when a later retry passes; see TESTING.md.
  preserveOutput: 'always',
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [['line']],
  use: {
    baseURL: testBaseUrl,
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    // Playwright 1.64 keeps a failed attempt's trace when a later retry passes.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -w creek-visualization-browser -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: testBaseUrl,
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [
    {
      name: 'deterministic',
      testMatch: '**/*.deterministic.spec.ts',
      retries: 0,
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        // Explicit external exceptions. Same-origin recorded fixtures and mocks stay allowed.
        deterministicRequestAllowlist: [...deterministicRequestAllowlist],
      },
    },
    {
      name: 'live',
      testMatch: '**/*.live.spec.ts',
      timeout: 90000,
      retries: 1,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
