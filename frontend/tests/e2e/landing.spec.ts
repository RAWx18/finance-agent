// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

declare global { interface Window { landingCaptureRequests: number } }

test('pre-login hero aligns content and keeps one clear sign-in action without starting voice', async ({ page, context, baseURL }, info) => {
  const origin = new URL(baseURL!).origin;
  await context.setExtraHTTPHeaders({ Origin: origin });
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin || /\/api\/(settings|session)/.test(url.pathname)) unexpected.push(url.pathname);
  });
  await page.addInitScript(() => {
    window.landingCaptureRequests = 0;
    /** Record and reject microphone requests before sign-in. */
    navigator.mediaDevices.getUserMedia = async () => {
      window.landingCaptureRequests++;
      throw new Error('The landing page must not request microphone access');
    };
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/settings', async route => { await pending; await route.continue(); });
  try {
    await page.goto('/login');
    const main = page.getByRole('main');
    const headline = main.getByRole('heading', { level: 1 });
    const cta = main.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(headline).toHaveText('Your money. Let’s talk it through.');
    await expect(main).toContainText('A personal AI financial assistant you can talk to.');
    await expect(cta).toBeDisabled();
    const loading = await cta.boundingBox();
    release();
    await expect(cta).toBeEnabled();
    expect(await cta.boundingBox()).toEqual(loading);
    await expect(main.getByRole('button')).toHaveCount(1);
    await expect(main.getByRole('figure')).toContainText('Example conversation');
    await expect(main.getByRole('figure').getByRole('button')).toHaveCount(0);
    await expect(cta).toBeInViewport({ ratio: 1 });
    const geometry = await page.evaluate(() => {
      /** Capture a landing element's bounds for alignment checks. */
      const box = (selector: string) => {
        const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
        return { x, y, width, height };
      };
      return { brand: box('.site-header .brand'), hero: box('.login-hero'), preview: box('.login-preview'),
        cta: box('.login-signin .primary'), footer: box('.site-footer'),
        width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
        main: box('main'), mainScroll: document.querySelector('main')!.scrollHeight,
        gradient: [...document.querySelectorAll('.login-page, .login-page *')].some(element => getComputedStyle(element).backgroundImage.includes('gradient')) };
    });
    expect(Math.abs(geometry.brand.x - geometry.hero.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.hero.x - geometry.cta.x)).toBeLessThanOrEqual(1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.mainScroll).toBeLessThanOrEqual(geometry.main.height + 1);
    expect(geometry.gradient).toBe(false);
    if (info.project.name === 'desktop') {
      expect(geometry.preview.x).toBeGreaterThan(geometry.hero.x + geometry.hero.width);
      expect(Math.abs(geometry.preview.y + geometry.preview.height / 2 - geometry.hero.y - geometry.hero.height / 2)).toBeLessThanOrEqual(1);
      expect(geometry.footer.y + geometry.footer.height).toBeLessThanOrEqual(geometry.height + 1);
    } else {
      expect(geometry.preview.y).toBeGreaterThan(geometry.hero.y + geometry.hero.height);
      expect(Math.abs(geometry.preview.x - geometry.hero.x)).toBeLessThanOrEqual(1);
    }
    await page.getByRole('link', { name: 'Skip to main content' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Cash flow home' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cta).toBeFocused();
    await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await cta.scrollIntoViewIfNeeded();
      await expect(cta).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('landing-large-text.png'), fullPage: true });
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await page.setViewportSize({ width: 844, height: 390 });
      await cta.scrollIntoViewIfNeeded();
      await expect(cta).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await page.evaluate(() => window.landingCaptureRequests)).toBe(0);
    expect(unexpected).toEqual([]); expect(errors).toEqual([]);
  } finally { release(); }
});

test('landing sign-in failure stays inline and preserves the original destination on retry', async ({ page, context, baseURL }) => {
  await context.setExtraHTTPHeaders({ Origin: new URL(baseURL!).origin });
  let attempts = 0;
  await page.route('**/api/auth/login', async route => {
    expect(route.request().postDataJSON()).toEqual({ returnTo: '/account' });
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, json: { code: 'authUnavailable', message: 'Private provider detail' } });
    else await route.continue();
  });
  await page.goto('/login?returnTo=/account');
  const signIn = page.getByRole('button', { name: 'Continue with Google', exact: true });
  await expect(signIn).toBeEnabled();
  await signIn.focus(); await page.keyboard.press('Enter');
  const retry = page.getByRole('button', { name: 'Retry sign in', exact: true });
  await expect(retry).toBeFocused();
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your money. Let’s talk it through.');
  await expect(page.getByRole('main')).not.toContainText('Private provider detail');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  expect((await page.request.get('/api/session')).status()).toBe(404);
});