import { expect, test as base } from '@playwright/test';
import { deterministicRequestAllowlist } from './deterministic-allowlist';

type DeterministicFixtures = {
  deterministicRequestAllowlist: string[];
  unexpectedExternalRequests: string[];
};

function isDeterministicRequestAllowed(
  url: URL,
  baseURL: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (baseURL) {
    try {
      if (url.origin === new URL(baseURL).origin) return true;
    } catch {
      return false;
    }
  }
  const identity = `${url.origin}${url.pathname}`;
  return allowlist.some(
    (entry) => entry === url.origin || entry === identity || url.href.startsWith(entry),
  );
}

export const test = base.extend<DeterministicFixtures>({
  deterministicRequestAllowlist: [[...deterministicRequestAllowlist], { option: true }],
  unexpectedExternalRequests: [
    async ({ page, baseURL, deterministicRequestAllowlist: allowlist }, use, testInfo) => {
      const unexpected: string[] = [];
      if (testInfo.project.name === 'deterministic') {
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (isDeterministicRequestAllowed(url, baseURL, allowlist)) {
            await route.fallback();
            return;
          }
          unexpected.push(`${url.origin}${url.pathname}`);
          await route.abort('blockedbyclient');
        });
      }
      await use(unexpected);
      if (testInfo.project.name === 'deterministic' && unexpected.length > 0) {
        throw new Error(`Unexpected external requests:\n${unexpected.join('\n')}`);
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { Page, TestInfo } from '@playwright/test';
