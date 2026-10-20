import { defineConfig, devices } from '@playwright/test';
import { deterministicRequestAllowlist } from './tests/support/browser/deterministic-allowlist.ts';

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
  reporter: [['./tests/support/reporting/quiet-stdio-reporter.ts']],
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
    // Test mode adds the camera command to the page's test seam; see TESTING.md.
    env: { VITE_TEST_MODE: 'true' },
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
      timeout: 20000,
      retries: 1,
      workers: 3,
      // The chromium channel draws WebGL on the GPU. The default headless shell uses
      // SwiftShader, a CPU renderer that made each scene test about 5× slower.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
