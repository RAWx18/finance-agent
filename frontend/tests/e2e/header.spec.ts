// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from '@playwright/test';
import { test } from './authSupport';

test('clean header hover, focus and responsive navigation', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'One explicit responsive header matrix.');
  const header = page.locator('.site-header');
  const brand = header.getByRole('link', { name: 'Cash flow home' });
  const navigation = header.getByRole('navigation', { name: 'Main navigation' });
  const profile = header.getByRole('button', { name: 'Profile menu' });
  /** Capture header geometry for responsive and interaction stability checks. */
  const bounds = () => page.locator('.site-header, .brand, .site-navigation, .site-navigation > a, .profile-trigger').evaluateAll(elements =>
    elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
  await expect(navigation.getByRole('link')).toHaveText(['Conversation', 'History', 'Money']);
  await expect(navigation.getByRole('link', { name: 'Conversation' })).toHaveAttribute('aria-current', 'page');
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const [name, width, height, fontSize] of [
    ['wide', 1920, 1080, '100%'], ['ultrawide', 2560, 1080, '100%'],
    ['desktop', 1440, 900, '100%'], ['tablet', 768, 1024, '100%'],
    ['mobile', 390, 844, '100%'], ['enlarged', 320, 700, '200%'],
  ] as const) {
    await test.step(name, async () => {
      await page.setViewportSize({ width, height });
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
      await profile.scrollIntoViewIfNeeded();
      const initial = await bounds();
      const available = (await page.locator('#root').boundingBox())!;
      expect(initial[0].x, `${name}: header starts at the viewport edge`).toBeCloseTo(available.x, 1);
      expect(initial[0].width, `${name}: header fills the application viewport`).toBeCloseTo(available.width, 1);
      await expect(header).toHaveCSS('max-width', 'none');
      const contentLeft = await page.locator('main').evaluate(element => element.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(element).paddingLeft));
      expect(initial[1].x, `${name}: brand remains aligned with page content`).toBeCloseTo(contentLeft, 1);
      for (const link of await navigation.getByRole('link').all()) {
        await expect(link).toBeInViewport({ ratio: .99 });
        await link.hover();
        await expect(link).toHaveCSS('text-decoration-line', 'none');
        await expect(link).toHaveCSS('border-bottom-width', '0px');
        await expect(link).toHaveCSS('background-image', 'none');
        const current = await bounds();
        for (const [index, box] of initial.entries()) for (const key of ['x', 'y', 'width', 'height'] as const)
          expect(Math.abs(current[index][key] - box[key]), `${name}: hover does not move ${index} ${key}`).toBeLessThanOrEqual(1);
      }
      await brand.hover();
      await expect(brand).toHaveCSS('text-decoration-line', 'none');
      await expect(brand.locator('span')).toHaveCSS('white-space', 'nowrap');
      const logo = (await brand.boundingBox())!;
      const avatar = (await profile.boundingBox())!;
      expect(logo.x + logo.width).toBeLessThanOrEqual(avatar.x);
      expect(Math.abs(logo.y + logo.height / 2 - avatar.y - avatar.height / 2)).toBeLessThanOrEqual(1);
      expect(avatar.width).toBeGreaterThanOrEqual(44);
      expect(avatar.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await profile.focus(); await page.keyboard.press('Shift+Tab');
      await expect(navigation.getByRole('link', { name: 'Money' })).toBeFocused();
      await expect(navigation.getByRole('link', { name: 'Money' })).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: 'Profile' });
      await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
      await menu.getByRole('menuitem', { name: 'Settings' }).hover();
      await expect(menu.getByRole('menuitem', { name: 'Settings' })).toHaveCSS('text-decoration-line', 'none');
      await expect(page.locator('.profile-dropdown')).toBeInViewport({ ratio: .99 });
      const opened = await bounds();
      for (const [index, box] of initial.entries()) for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(opened[index][key] - box[key]), `${name}: menu does not move ${index} ${key}`).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`header-${name}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(profile).toBeFocused();
      await expect(menu).toHaveCount(0);
    });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await profile.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(0);
  await profile.click();
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveCSS('text-decoration-line', 'none');
  await page.keyboard.press('Escape');
  await navigation.getByRole('link', { name: 'Money' }).click();
  await expect(page).toHaveURL(/\/money$/);
  const money = navigation.getByRole('link', { name: 'Money' });
  await expect(money).toHaveAttribute('aria-current', 'page');
  await money.hover();
  await expect(money).toHaveCSS('text-decoration-line', 'none');
  await expect(money).toHaveCSS('border-bottom-width', '0px');
  await expect(money).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('header geometry stays stable across routes, preparation and modal scroll locking', async ({ page }) => {
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  /** Capture header geometry for route and modal stability comparisons. */
  const bounds = () => page.locator('.site-header, .site-header .brand, .site-navigation, .site-navigation > a, .profile-trigger').evaluateAll(elements =>
    elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
  const initial = await bounds();
  /** Verify the header retains its initial geometry without horizontal overflow. */
  const unchanged = async () => {
    const current = await bounds();
    expect(current).toHaveLength(initial.length);
    for (const [index, box] of initial.entries()) for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(current[index][key] - box[key]), `Header ${index} ${key} stays stable`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'ready');
  await unchanged();
  await navigation.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/); await unchanged();
  await navigation.getByRole('link', { name: 'Money', exact: true }).click();
  await expect(page).toHaveURL(/\/money$/); await unchanged();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Privacy', exact: true })).toBeVisible();
  await unchanged();
  await page.keyboard.press('Escape'); await unchanged();
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/); await unchanged();
  await navigation.getByRole('link', { name: 'Conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/); await unchanged();
});