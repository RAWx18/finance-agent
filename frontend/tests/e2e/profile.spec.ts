// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import type { AuthSession } from '../../src/api';
import { signIn } from './authSupport';

test('profile menu and minimal settings', async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'One explicit desktop and mobile viewport matrix.');
  const origin = new URL(baseURL!).origin;
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
  await context.setExtraHTTPHeaders({ Origin: origin });
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.routeWebSocket('**', socket => {
    blocked.push(socket.url());
    socket.close({ code: 1008, reason: 'Settings must not contact voice providers' });
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const allowed = url.origin === origin && (request.method() === 'GET'
      || url.pathname.startsWith('/api/auth/') && request.method() === 'POST'
      || url.pathname === '/api/account' && request.method() === 'PATCH');
    if (allowed) await route.continue();
    else { blocked.push(`${request.method()} ${url.href}`); await route.abort('blockedbyclient'); }
  });
  // Count real capture attempts without substituting media or application behavior.
  await page.addInitScript(() => {
    const state = window as typeof window & { profileCaptureRequests: number };
    state.profileCaptureRequests = 0;
    navigator.mediaDevices.getUserMedia = new Proxy(navigator.mediaDevices.getUserMedia, {
      apply(target, receiver, args: Parameters<MediaDevices['getUserMedia']>) {
        state.profileCaptureRequests++;
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await signIn(page);
  const response = await page.request.get('/api/auth/session');
  expect(response.status()).toBe(200);
  const original = await response.json() as AuthSession;
  const trigger = page.getByRole('button', { name: 'Profile menu', exact: true });
  const menu = page.getByRole('menu', { name: 'Profile', exact: true });
  const header = page.getByRole('banner');
  const name = page.getByRole('textbox', { name: 'Display name', exact: true });
  const geometry = () => page.locator('.site-header, .brand, .profile-trigger, main, .site-footer').evaluateAll(elements =>
    elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
  try {
    expect((await page.request.get('/api/session')).status()).toBe(404);
    for (const [label, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
      await test.step(label, async () => {
        await page.setViewportSize(viewport);
        await page.getByRole('link', { name: 'Conversation', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeEnabled();
        await expect(header.getByRole('navigation', { name: 'Main navigation' }).getByRole('link')).toHaveText(['Conversation', 'History', 'Money']);
        await expect(header.getByRole('link', { name: 'Account', exact: true })).toHaveCount(0);
        await expect(header.getByText('Sign out', { exact: true })).toHaveCount(0);
        await expect(trigger).toHaveAttribute('title', 'Profile menu');
        await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).toHaveText('');
        await expect(trigger.locator('svg')).toHaveCount(1);
        await trigger.scrollIntoViewIfNeeded();
        const brand = (await page.getByRole('link', { name: 'Cash flow home' }).boundingBox())!;
        const icon = (await trigger.boundingBox())!;
        expect(brand.x).toBeLessThan(viewport.width / 2);
        expect(icon.x).toBeGreaterThan(viewport.width / 2);
        expect(brand.x + brand.width).toBeLessThanOrEqual(icon.x);
        expect(Math.abs(brand.y + brand.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(2);
        expect(icon.width).toBeGreaterThanOrEqual(44); expect(icon.height).toBeGreaterThanOrEqual(44);
        const before = await geometry();
        await trigger.click();
        await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
        await expect(header.getByText(original.user.displayName, { exact: true })).toBeVisible();
        await expect(header.getByText(original.user.email, { exact: true })).toBeVisible();
        const after = await geometry();
        expect(after).toHaveLength(before.length);
        for (const [index, box] of before.entries()) for (const key of ['x', 'y', 'width', 'height'] as const)
          expect(Math.abs(after[index][key] - box[key]), `${label}: menu leaves ${index} ${key} unchanged`).toBeLessThanOrEqual(1);
        await expect(page.locator('.profile-dropdown')).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: info.outputPath(`profile-menu-${label}.png`), fullPage: true });
        await page.keyboard.press('End');
        await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
        await page.getByRole('heading', { level: 1 }).click();
        await expect(menu).toHaveCount(0);
        await trigger.focus(); await page.keyboard.press('Enter');
        await expect(menu.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/account');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/account$/);
        await expect(page).toHaveTitle('Settings · Cash flow');
        await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeFocused();
        await expect(menu).toHaveCount(0);
        const settings = page.getByRole('region', { name: 'Settings', exact: true });
        await expect(settings.getByRole('form', { name: 'Display name' })).toBeVisible();
        await expect(settings.getByRole('textbox')).toHaveCount(1);
        await expect(settings.getByRole('heading')).toHaveText(['Settings', 'Account Google']);
        await expect(settings.getByText(original.user.email, { exact: true })).toBeVisible();
        if (original.user.googleName) await expect(settings.getByText(original.user.googleName, { exact: true })).toBeVisible();
        else await expect(settings.getByText('Google name', { exact: true })).toHaveCount(0);
        await expect(settings.locator('.card')).toHaveCount(0);
        expect(await page.getByRole('main').innerText()).not.toMatch(/Your account|Your profile|retention|session|privacy|kept for/i);
        await trigger.click(); await name.focus();
        await expect(menu).toHaveCount(0); await expect(name).toBeFocused();
        await trigger.click(); await page.keyboard.press('Tab');
        await expect(menu).toHaveCount(0); await expect(name).toBeFocused();
        await trigger.click(); await page.keyboard.press('Shift+Tab');
        await expect(menu).toHaveCount(0);
        await expect(header.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toBeFocused();
        for (const displayName of [`Profile ${label}`, original.user.displayName]) {
          await name.fill(displayName);
          const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account' && response.request().method() === 'PATCH');
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          const result = await saved;
          expect(result.status()).toBe(200);
          expect((await result.json() as AuthSession['user']).displayName).toBe(displayName);
          await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
          await trigger.click();
          await expect(header.getByText(displayName, { exact: true })).toBeVisible();
          await page.keyboard.press('Escape');
        }
        const privacy = page.getByRole('contentinfo').getByRole('button', { name: 'Privacy', exact: true });
        await privacy.click();
        const privacyDialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
        await expect(privacyDialog).toContainText('Do not provide passwords, bank account numbers or full payment-card details.');
        await privacyDialog.getByRole('button', { name: 'Close privacy', exact: true }).click();
        await expect(privacy).toBeFocused();
        const remove = settings.getByRole('button', { name: 'Delete app account', exact: true });
        await expect(remove).toHaveClass(/quiet/);
        await expect(remove).not.toHaveClass(/primary/);
        await remove.click();
        const dialog = page.getByRole('dialog', { name: 'Delete your app account?', exact: true });
        expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
        await expect(dialog).toContainText('Your Google account will not be deleted.');
        await expect(dialog.getByRole('button', { name: 'Permanently delete app account' })).toBeDisabled();
        await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
        await expect(dialog.getByRole('button', { name: 'Permanently delete app account' })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Keep account' }).click();
        await expect(dialog).toBeHidden(); await expect(remove).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(await page.evaluate(() => (window as typeof window & { profileCaptureRequests: number }).profileCaptureRequests)).toBe(0);
        expect(await page.locator('audio').evaluateAll(elements => elements.every(element =>
          element instanceof HTMLAudioElement && element.srcObject === null && element.paused))).toBe(true);
        expect((await page.request.get('/api/session')).status()).toBe(404);
        await page.screenshot({ path: info.outputPath(`profile-settings-${label}.png`), fullPage: true });
      });
    }
    const displayName = 'Alexandria'.repeat(8);
    const saved = await page.request.patch('/api/account', { data: { displayName } });
    expect(saved.status()).toBe(200);
    await page.reload();
    await expect(name).toHaveValue(displayName);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await trigger.click();
    await expect(header.getByText(displayName, { exact: true })).toBeVisible();
    await expect(header.getByText(original.user.email, { exact: true })).toBeVisible();
    await expect(page.locator('.profile-dropdown')).toBeInViewport({ ratio: 1 });
    await expect(header.getByText(displayName, { exact: true })).toHaveAttribute('title', displayName);
    await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeInViewport({ ratio: .99 });
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeInViewport({ ratio: .99 });
    expect(await page.locator('.profile-identity').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('profile-long-identity-enlarged.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    for (const control of [name, page.getByRole('button', { name: 'Save', exact: true }),
      page.getByRole('button', { name: 'Delete app account', exact: true }), page.getByRole('button', { name: 'Privacy', exact: true })]) {
      await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport({ ratio: .99 });
      const bounds = (await control.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(-1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    }
    expect(await page.evaluate(() => (window as typeof window & { profileCaptureRequests: number }).profileCaptureRequests)).toBe(0);
    expect((await page.request.get('/api/session')).status()).toBe(404);
  } finally {
    const restored = await page.request.patch('/api/account', { data: { displayName: original.user.displayName } });
    expect(restored.status()).toBe(200);
    await page.reload();
    await expect(name).toHaveValue(original.user.displayName);
    await trigger.click();
    await expect(header.getByText(original.user.displayName, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { profileCaptureRequests: number }).profileCaptureRequests)).toBe(0);
    expect(blocked, 'No provider connections or financial/account deletion mutations').toEqual([]);
    expect(errors).toEqual([]);
  }
});