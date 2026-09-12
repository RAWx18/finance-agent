// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import { test } from './authSupport';

test('shared branding survives navigation, reload and new tabs with accurate Privacy text', async ({ page, context }, info) => {
  const icon = page.locator('head link[rel="icon"]');
  const logo = page.locator('.site-header .brand img');
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute('type', 'image/svg+xml');
  await expect(icon).toHaveAttribute('href', /^\/assets\/brand-[\w-]+\.svg$/);
  const path = (await icon.getAttribute('href'))!;
  await expect(logo).toHaveAttribute('src', path);
  await expect(logo).toHaveCSS('width', '28px');
  await expect(logo).toHaveCSS('height', '28px');
  expect(await logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const asset = await page.request.get(path);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['content-type']).toContain('image/svg+xml');
  expect(await asset.text()).toContain('viewBox="0 0 32 32"');
  const geometry = await page.locator('.brand img, .brand span').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { middle: rect.y + rect.height / 2, right: rect.right, left: rect.left };
  }));
  expect(Math.abs(geometry[0].middle - geometry[1].middle)).toBeLessThan(1);
  expect(geometry[0].right).toBeLessThan(geometry[1].left);
  await expect(page).toHaveTitle('Your 30-day plan · Cash flow');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  for (const title of ['History', 'Money']) {
    await navigation.getByRole('link', { name: title, exact: true }).click();
    await expect(page).toHaveTitle(`${title} · Cash flow`);
    await page.reload();
    await expect(page).toHaveTitle(`${title} · Cash flow`);
    await expect(logo).toHaveAttribute('src', path);
    await expect(icon).toHaveAttribute('href', path);
  }
  await page.screenshot({ path: info.outputPath('brand-header.png'), fullPage: true });
  const privacy = page.getByRole('button', { name: 'Privacy', exact: true });
  await privacy.click();
  const dialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Information stored', 'Service providers', 'Retention and deletion']);
  for (const text of ['text conversations', 'does not save audio recordings', 'Google provides sign-in', 'Daily carries live calls',
    'Azure Speech', 'Azure OpenAI', 'does not guarantee deletion of provider-held data', 'Signing out does not delete saved data',
    'saved preferences remain until forgotten', 'does not erase the conversation']) await expect(dialog).toContainText(text);
  const settings = await (await page.request.get('/api/settings')).json() as { retentionHours: number };
  await expect(dialog).toContainText(`expire ${settings.retentionHours} hours after plan creation`);
  await expect(dialog).not.toContainText('kept for up to');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('privacy.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(privacy).toBeFocused();
  const tab = await context.newPage();
  await tab.goto('/money');
  await expect(tab).toHaveTitle('Money · Cash flow');
  await expect(tab.locator('head link[rel="icon"]')).toHaveAttribute('href', path);
  await tab.close();
  await page.getByRole('button', { name: 'Profile menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page).toHaveTitle('Cash flow');
  await page.reload(); await expect(page).toHaveTitle('Cash flow');
  await expect(logo).toHaveAttribute('src', path);
  await expect(icon).toHaveAttribute('href', path);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});