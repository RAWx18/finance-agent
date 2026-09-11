// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { signIn } from './authSupport';

test.beforeEach(async ({ context, baseURL }) => {
  await context.setExtraHTTPHeaders({ Origin: new URL(baseURL!).origin });
});

test('anonymous routes and APIs are gated; Google callback creates only an HttpOnly login and preserves deep navigation', async ({ page, context }, testInfo) => {
  const protectedCalls: string[] = [];
  page.on('request', request => {
    if (/\/api\/(settings|session)/.test(request.url())) protectedCalls.push(request.url());
  });
  expect((await page.request.get('/api/settings')).status()).toBe(401);
  expect((await page.request.post('/api/session', { data: {} })).status()).toBe(401);
  for (const path of ['/app', '/figures', '/account']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=${path}$`));
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Start talking' })).toHaveCount(0);
  }
  expect(protectedCalls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('auth-login.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  expect((await page.request.get('/api/session')).status()).toBe(404);
  const session = await page.request.get('/api/auth/session');
  expect(session.status()).toBe(200);
  const profile = await session.json();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue(profile.user.displayName);
  await expect(page.getByText(profile.user.email, { exact: true })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.some(cookie => cookie.httpOnly && cookie.expires > Date.now() / 1000)).toBe(true);
  expect(await page.evaluate(() => ({ cookie: document.cookie, local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ cookie: '', local: 0, session: 0 });
  await page.getByRole('link', { name: 'Your figures', exact: true }).click();
  await expect(page).toHaveURL(/\/figures$/);
  await expect(page.getByRole('region', { name: 'Your figures', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Your figures' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add figures' })).toBeVisible();
  await page.reload(); await expect(page).toHaveURL(/\/figures$/);
  expect((await page.request.get('/api/session')).status()).toBe(404);
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goBack(); await expect(page).toHaveURL(/\/figures$/);
  await page.goForward(); await expect(page).toHaveURL(/\/app$/);
  expect((await page.request.get('/api/session')).status()).toBe(404);
});

test('profile updates survive reload and logout clears sibling tabs but not an independent browser login', async ({ page, context, browser, baseURL }, testInfo) => {
  await signIn(page, '/account');
  const original = await (await page.request.get('/api/auth/session')).json();
  const name = page.getByRole('textbox', { name: 'Display name' });
  await name.fill('  Browser account name  ');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(name).toHaveValue('Browser account name');
  await page.reload(); await expect(name).toHaveValue('Browser account name');
  await expect(page.getByText(original.user.googleName, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('auth-account.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const sibling = await context.newPage(); await sibling.goto('/account');
  await expect(sibling.getByRole('textbox', { name: 'Display name' })).toHaveValue('Browser account name');
  const independent = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL!).origin } });
  try {
    const other = await independent.newPage(); await signIn(other, '/account');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(sibling.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(sibling.getByRole('textbox', { name: 'Display name' })).toHaveCount(0);
    expect((await context.request.get('/api/auth/session')).status()).toBe(401);
    expect((await independent.request.get('/api/auth/session')).status()).toBe(200);
    const reset = await independent.request.patch('/api/account', { data: { displayName: original.user.displayName } });
    expect(reset.status()).toBe(200);
    await expect(other.getByRole('button', { name: 'Sign out' })).toBeVisible();
  } finally { await independent.close(); await sibling.close(); }
});

test('expired login and transient auth errors remove private views and offer the correct recovery', async ({ page }) => {
  await signIn(page, '/account');
  await page.route('**/api/auth/refresh', route => route.fulfill({ status: 503, json: { code: 'authUnavailable', message: 'Internal auth service diagnostic' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Sign-in connection unavailable' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Internal auth service diagnostic');
  await page.unroute('**/api/auth/refresh');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
  await page.route('**/api/auth/refresh', route => route.fulfill({ status: 401, json: { code: 'sessionExpired', message: 'Internal expiry diagnostic' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/login\?returnTo=\/account$/);
  await expect(page.getByText('Your sign-in has expired. Sign in again to continue.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveCount(0);
});

test('lost logout response never claims success until the real server check confirms it', async ({ page }) => {
  await signIn(page, '/account');
  await page.route('**/api/auth/logout', async route => {
    const response = await route.fetch(); expect(response.status()).toBe(204);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign-out not confirmed' })).toBeVisible();
  await expect(page.getByText('You’re signed out.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check sign-in' }).click();
  await expect(page.getByText('You’re signed out.', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
});

test('explicit app deletion requires re-sign-in when requested and never deletes automatically on return', async ({ page }, testInfo) => {
  await signIn(page, '/account');
  const initial = await page.request.post('/api/session', { data: {} }); expect(initial.status()).toBe(200);
  let attempts = 0;
  await page.route('**/api/account', async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return; }
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'DELETE' });
    if (attempts === 1) await route.fulfill({ status: 428, json: { code: 'requiresSignin', message: 'Sign in again' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Delete app account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your app account?' });
  await expect(dialog).toContainText('Your Google account will not be deleted.');
  const remove = dialog.getByRole('button', { name: 'Permanently delete app account' });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await remove.click();
  await expect(dialog).toContainText('signing in does not delete anything');
  expect((await page.request.get('/api/session')).status()).toBe(200);
  await dialog.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(dialog).toHaveCount(0);
  expect(attempts).toBe(1); expect((await page.request.get('/api/session')).status()).toBe(200);
  await page.getByRole('button', { name: 'Delete app account' }).click();
  await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue('');
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.screenshot({ path: testInfo.outputPath('auth-delete-confirmation.png'), fullPage: true });
  await remove.click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByText(/Your app account and its saved figures have been deleted/)).toBeVisible();
  expect(attempts).toBe(2); expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  expect((await page.request.get('/api/session')).status()).toBe(401);
});