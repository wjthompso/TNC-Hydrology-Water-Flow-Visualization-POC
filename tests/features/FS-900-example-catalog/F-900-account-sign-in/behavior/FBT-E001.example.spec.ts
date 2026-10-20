import { expect, test } from '@playwright/test';

/**
 * EXAMPLE ONLY; excluded from test discovery; does not protect the application.
 *
 * Methodology: This example does not run. If promoted, the browser and
 * application flow would be real: the test would create a new account through
 * the user interface, enroll an authenticator second factor, sign out, and sign
 * back in with the password plus a current authenticator code before observing
 * the account page. The identity backend would need an isolated test tenant or
 * emulator, the authenticator-code helper would be test-only, and authentication
 * responses would not be mocked. SMS and email enrollment are not covered.
 */

declare const generateCurrentAuthenticatorCode: (
  enrolledSecret: string,
) => string;

test.skip(
  'A new user can sign in and register for multi-factor authentication.',
  async ({ page }) => {
    const emailAddress = `account-example-${Date.now()}@example.test`;
    const password = 'Example-only-password-42!';

    await page.goto('/sign-up');
    await page.getByLabel('Email address').fill(emailAddress);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(
      page.getByRole('heading', { name: 'Set up an authenticator' }),
    ).toBeVisible();

    const authenticatorSecret = (
      await page.getByTestId('authenticator-secret').textContent()
    )?.trim();
    if (!authenticatorSecret) {
      throw new Error('Authenticator enrollment did not provide a secret.');
    }

    // Test-only helper. Promotion requires a real helper supplied by the test system.
    const enrollmentCode =
      generateCurrentAuthenticatorCode(authenticatorSecret);
    await page.getByLabel('Authenticator code').fill(enrollmentCode);
    await page
      .getByRole('button', { name: 'Enable authenticator' })
      .click();

    await expect(
      page.getByRole('heading', { name: 'Account', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.getByLabel('Email address').fill(emailAddress);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const signInCode =
      generateCurrentAuthenticatorCode(authenticatorSecret);
    await page.getByLabel('Authenticator code').fill(signInCode);
    await page.getByRole('button', { name: 'Verify' }).click();

    await expect(page).toHaveURL(/\/account$/);
    await expect(
      page.getByRole('heading', { name: 'Account', exact: true }),
    ).toBeVisible();
  },
);
