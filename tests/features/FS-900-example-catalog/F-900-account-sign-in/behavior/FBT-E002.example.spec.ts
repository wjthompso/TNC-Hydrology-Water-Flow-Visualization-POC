import { expect, test } from '@playwright/test';

/**
 * EXAMPLE ONLY; excluded from test discovery; does not protect the application.
 *
 * Methodology: This example does not run. If promoted, it would use the real
 * browser and application flow with an isolated test account to submit a known
 * wrong password, observe the visible error, verify that account navigation and
 * multi-factor enrollment do not appear, then visit the protected account URL
 * directly and observe the sign-in page instead of account content. The account
 * credentials would be test-only, and authentication responses would not be
 * mocked. This checks browser-observable access and does not inspect the identity
 * provider's internal session storage.
 */

test.skip(
  'Signing in with a wrong password shows an error and does not open the account.',
  async ({ page }) => {
    await page.goto('/sign-in');
    await page
      .getByLabel('Email address')
      .fill('existing-account@example.test');
    await page.getByLabel('Password').fill('known-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(
      page.getByRole('alert'),
    ).toContainText('Email address or password is incorrect');
    await expect(page).not.toHaveURL(/\/account(?:\/|$)/);
    await expect(
      page.getByRole('heading', { name: 'Account', exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole('heading', { name: 'Set up an authenticator' }),
    ).toBeHidden();

    await page.goto('/account');

    await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
    await expect(
      page.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Account', exact: true }),
    ).toBeHidden();
  },
);
