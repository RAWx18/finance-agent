// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

export async function signIn(page: Page, returnTo = '/app') {
  await page.goto(`/login${returnTo === '/app' ? '' : `?returnTo=${returnTo}`}`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(url => url.pathname === returnTo && !url.search);
  await expect(page.getByRole('button', { name: 'Profile menu' })).toBeVisible();
}

export const test = base.extend<{ authenticated: void }>({
  authenticated: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    await context.setExtraHTTPHeaders({ Origin: origin });
    await signIn(page);
    await use();
  }, { auto: true }],
});