// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signIn } from './authSupport';

const test = base.extend<{ recoverySafety: void }>({
  /** Keep recovery checks free of provider traffic, financial writes and browser errors. */
  recoverySafety: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    await context.setExtraHTTPHeaders({ Origin: origin });
    const blocked: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.routeWebSocket('**', socket => { blocked.push(socket.url()); socket.close(); });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/api/auth/')) {
        blocked.push(`${request.method()} ${url.pathname}`);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    try { await use(); }
    finally {
      expect(blocked, 'Recovery must not contact providers or change financial data').toEqual([]);
      expect(errors).toEqual([]);
    }
  }, { auto: true }],
});

/** Verify the recovery view stays centered and fits without nested scrolling. */
async function fits(page: Page) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    mainHeight: document.querySelector('main')!.clientHeight, mainScrollHeight: document.querySelector('main')!.scrollHeight }));
  expect(size.scrollWidth, 'No horizontal overflow').toBeLessThanOrEqual(size.width + 1);
  expect(size.scrollHeight, 'Standard viewports need no page scrolling').toBeLessThanOrEqual(size.height + 1);
  expect(size.mainScrollHeight, 'Recovery needs no nested scrolling').toBeLessThanOrEqual(size.mainHeight + 1);
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('contentinfo')).toBeInViewport({ ratio: 1 });
  const recovery = page.locator('main .recovery');
  const box = (await recovery.boundingBox())!;
  const main = (await page.getByRole('main').boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (main.x + main.width / 2)), 'Centered composition').toBeLessThanOrEqual(1);
  expect(await recovery.evaluate(element => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, background: style.backgroundImage, border: style.borderTopWidth };
  })).toEqual({ shadow: 'none', background: 'none', border: '0px' });
}

test('one balanced auth recovery keeps retry stable through pending and repeated failures', async ({ page }, info) => {
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const financialReads: string[] = [];
  page.on('request', request => {
    if (/\/api\/(settings|session|voice)/.test(request.url())) financialReads.push(request.url());
  });
  await page.route('**/api/auth/session', async route => {
    requests++;
    if (requests === 2) await pending;
    await route.fulfill({ status: 503, json: { code: 'authUnavailable', message: 'Private provider diagnostic' } });
  });
  await page.goto('/login?returnTo=/money');
  const heading = page.getByRole('heading', { name: 'Your saved plan is safe.', level: 1 });
  const recovery = page.getByRole('region', { name: 'Your saved plan is safe.' });
  const retry = page.getByRole('button', { name: 'Retry connection', exact: true });
  await expect(heading).toBeFocused();
  await expect(recovery).toContainText('We’ve lost the connection for a moment. Retry to see your figures.');
  await expect(retry).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveClass('quiet');
  await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
  await expect(page.locator('.card:visible')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/Private provider|sign-in connection|connection restored/i);
  await fits(page);
  await page.screenshot({ path: info.outputPath('connection-recovery.png'), fullPage: true });
  const before = await recovery.boundingBox();
  const button = await retry.boundingBox();
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  const trying = page.getByRole('button', { name: 'Trying again…' });
  try {
    await expect(trying).toBeDisabled();
    await expect(recovery).toHaveAttribute('aria-busy', 'true');
    expect(await recovery.boundingBox()).toEqual(before);
    expect(await trying.boundingBox()).toEqual(button);
    await expect(heading).toBeVisible();
    expect(financialReads).toEqual([]);
  } finally { release(); }
  await expect(retry).toBeEnabled();
  await expect(recovery).toHaveAttribute('aria-busy', 'false');
  expect(requests).toBe(2);
  expect(await recovery.boundingBox()).toEqual(before);
  await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
  await page.unroute('**/api/auth/session');
  await retry.click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(recovery).toHaveCount(0);
  expect(financialReads).toEqual([]);
});

test('auth outage hides private content and a real retry leaves the saved plan unchanged', async ({ page }, info) => {
  await signIn(page, '/account');
  expect((await page.request.get('/api/session')).status()).toBe(404);
  const created = await page.request.post('/api/session', { data: {} });
  expect(created.status()).toBe(200);
  const saved = await created.json();
  try {
    await page.route('**/api/auth/refresh', route => route.fulfill({ status: 503,
      json: { code: 'authUnavailable', message: 'Private provider diagnostic' } }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Your saved plan is safe.' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveCount(0);
    await expect(page.locator('audio')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
    await fits(page);
    await page.screenshot({ path: info.outputPath('saved-plan-recovery.png'), fullPage: true });
    await page.unroute('**/api/auth/refresh');
    await page.getByRole('button', { name: 'Retry connection' }).click();
    await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
    const current = await page.request.get('/api/session');
    expect(current.status()).toBe(200);
    expect(await current.json()).toEqual(saved);
  } finally { expect((await page.request.delete('/api/session')).ok()).toBe(true); }
});

test('uncertain sign-out uses one recovery view and remains secondary until confirmed', async ({ page }, info) => {
  await signIn(page, '/account');
  await page.route('**/api/auth/logout', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Profile menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s finish signing out.' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveCount(0);
  await expect(page.getByText('You’re signed out.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
  const signOut = page.getByRole('button', { name: 'Retry sign out' });
  await expect(signOut).toHaveClass('quiet');
  await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(1);
  await fits(page);
  await page.screenshot({ path: info.outputPath('sign-out-recovery.png'), fullPage: true });
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  await page.unroute('**/api/auth/logout');
  await signOut.click();
  await expect(page.getByText('You’re signed out.', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
});

for (const unreadable of [false, true]) test(`initial plan ${unreadable ? 'read' : 'connection'} failure offers the same compact recovery without a new plan`, async ({ page }, info) => {
  await page.route('**/api/session', route => route.fulfill({ status: unreadable ? 500 : 503,
    json: { code: unreadable ? 'invalidStoredState' : 'unavailable', message: 'Private storage diagnostic' } }));
  await signIn(page);
  const title = unreadable ? 'Your figures need another look.' : 'Your saved plan is safe.';
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start conversation' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Private storage diagnostic');
  await fits(page);
  await page.screenshot({ path: info.outputPath(`plan-${unreadable ? 'read' : 'connection'}-recovery.png`), fullPage: true });
  await page.unroute('**/api/session');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('button', { name: 'Start conversation' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: title })).toHaveCount(0);
  expect((await page.request.get('/api/session')).status()).toBe(404);
});

test('sign-in availability failure stays beside its only recovery action', async ({ page }, info) => {
  await page.route('**/api/auth/settings', route => route.abort('failed'));
  await page.goto('/login');
  const recovery = page.getByRole('region', { name: 'Let’s get you connected.' });
  await expect(recovery).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Retry connection' })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('sign-in-recovery.png'), fullPage: true });
  await page.unroute('**/api/auth/settings');
  await recovery.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeFocused();
  await expect(page).toHaveURL(/\/login$/);
  await expect(recovery).toHaveCount(0);
});

test('keyboard sign-in failure moves focus to its retry without opening another notification', async ({ page }) => {
  await page.route('**/api/auth/login', route => route.fulfill({ status: 503,
    json: { code: 'authUnavailable', message: 'Private provider diagnostic' } }));
  await page.goto('/login');
  const signIn = page.getByRole('button', { name: 'Continue with Google' });
  await expect(signIn).toBeEnabled();
  await signIn.focus();
  await page.keyboard.press('Enter');
  const retry = page.getByRole('button', { name: 'Retry sign in' });
  await expect(retry).toBeFocused();
  await expect(page.getByRole('region', { name: 'Let’s try signing in again.' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Notifications' })).toHaveCount(0);
  await page.unroute('**/api/auth/login');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('button', { name: 'Start conversation' })).toBeEnabled();
  expect((await page.request.get('/api/session')).status()).toBe(404);
});

test('small, landscape and enlarged-text recovery keeps every action reachable', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'One explicit viewport and text-size matrix');
  await page.route('**/api/auth/session', route => route.fulfill({ status: 503,
    json: { code: 'authUnavailable', message: 'Private diagnostic' } }));
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Your saved plan is safe.' })).toBeVisible();
  for (const size of [{ width: 320, height: 568, scale: 1 }, { width: 667, height: 375, scale: 1 },
    { width: 390, height: 844, scale: 2 }, { width: 320, height: 640, scale: 2 }]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, size.scale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (size.scale === 1) await fits(page);
    for (const control of [page.getByRole('heading', { level: 1 }), page.getByRole('button', { name: 'Retry connection' }),
      page.getByRole('button', { name: 'Sign out', exact: true })]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: info.outputPath(`recovery-${size.width}-${size.height}-${size.scale}.png`), fullPage: true });
  }
});