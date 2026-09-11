// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { devices, expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Settings } from '../../src/api';
import { signIn } from './authSupport';

// Production assets and financial HTTP only; preparation must never start capture or a call.
const test = base.extend<{ preparation: void }>({
  preparation: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    await context.setExtraHTTPHeaders({ Origin: origin });
    await signIn(page);
    const blocked: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.routeWebSocket('**', socket => {
      blocked.push(socket.url());
      socket.close({ code: 1008, reason: 'Preparation tests prohibit provider connections' });
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET' && url.pathname !== '/api/auth/refresh' || url.pathname === '/api/session/call') {
        blocked.push(`${request.method()} ${request.url()}`);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    try { await use(); }
    finally {
      expect(blocked, 'Preparation must not contact providers or mutate financial data').toEqual([]);
      expect(errors).toEqual([]);
    }
  }, { auto: true }],
});

test.use({ serviceWorkers: 'block' });

async function geometry(page: Page) {
  return page.evaluate(() => ({
    y: scrollY, gutter: innerWidth - document.documentElement.clientWidth,
    boxes: ['.site-header', 'main', '.conversation', '.conversation-controls', '.financial-pane', '.context-scroll', '.site-footer'].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [];
      const { x, y, width, height } = element.getBoundingClientRect();
      return [{ selector, x, y, width, height }];
    }),
  }));
}

async function stable(page: Page, before: Awaited<ReturnType<typeof geometry>>) {
  const after = await geometry(page);
  expect(Math.abs(after.y - before.y), 'Page scroll position').toBeLessThanOrEqual(1);
  expect(Math.abs(after.gutter - before.gutter), 'Reserved scrollbar gutter').toBeLessThanOrEqual(1);
  for (const box of before.boxes) {
    const actual = after.boxes.find(item => item.selector === box.selector);
    expect(actual, box.selector).toBeDefined();
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(actual![key] - box[key]), `${box.selector} ${key}`).toBeLessThanOrEqual(1);
  }
}

async function fits(page: Page) {
  const size = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight, root: document.querySelector('#root')!.getBoundingClientRect().height,
  }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 1);
  expect(size.scrollHeight, 'Normal-sized screens need no document scrolling').toBeLessThanOrEqual(size.height + 1);
  expect(Math.abs(size.root - size.height)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.site-footer')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('details, summary, [aria-expanded]')).toHaveCount(0);
}

test('voice-first welcome prepares without opening a microphone or exposing technical setup', async ({ page }, testInfo) => {
  await page.goto('/');
  const response = await page.request.get('/api/settings', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const settings = await response.json() as Settings;
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Talk it through.');
  const start = page.getByRole('button', { name: 'Start conversation' });
  await expect(start).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('.intro-copy')).toHaveCount(0);
  await expect(page.locator('.welcome-layout')).not.toContainText(/English only|no camera|microphone/i);
  await expect(page.getByRole('article', { name: 'Plan focus' })).toHaveCount(0);
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath('production-empty.png'), fullPage: true });
  await start.click();
  await expect(page.locator('main')).toHaveAttribute('data-view', 'ready');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Let’s talk it through.');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.locator('.live-layout')).toBeVisible();
  await expect(page.locator('.voice-status')).toHaveText(settings.voiceAvailable ? 'Ready when you are' : 'Conversations unavailable');
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toHaveCount(0);
  const connect = page.getByRole('button', { name: 'Start talking' });
  if (settings.voiceAvailable) await expect(connect).toBeEnabled();
  else {
    await expect(connect).toBeDisabled();
    await expect(page.locator('.voice-status')).toHaveText('Conversations unavailable');
    await page.getByRole('button', { name: 'Check availability' }).click();
    await expect(page.locator('.conversation-controls').getByRole('button', { name: 'Check availability' })).toBeEnabled();
  }
  await expect(page.locator('body')).not.toContainText(/Missing setup|OPENAI_API_KEY|DAILY_API_KEY|AZURE_SPEECH|stack trace/i);
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  await expect(page.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath('production-ready.png'), fullPage: true });
  const before = await geometry(page);
  const privacy = page.getByRole('button', { name: 'Privacy', exact: true });
  await privacy.click();
  const dialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(dialog.getByRole('heading', { name: 'Privacy', exact: true })).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(dialog.locator('.dialog-body')).toHaveCSS('overflow-y', 'auto');
  await stable(page, before);
  // Native modal inertness must reject focus even on an otherwise available background action.
  await page.getByRole('button', { name: 'Prefer typing?', includeHidden: true }).focus();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    await expect(dialog.locator(':focus')).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(privacy).toBeFocused();
  await stable(page, before);
  await expect(page.getByRole('button', { name: 'Add figures' })).toBeHidden();
  const typing = page.getByRole('button', { name: 'Prefer typing?' });
  await typing.click();
  const figures = page.getByRole('region', { name: 'Your figures' });
  await expect(figures).toBeVisible();
  await expect(page).toHaveURL(/\/figures$/);
  await expect(page.getByRole('button', { name: 'Add figures' })).toBeVisible();
  await expect(figures.getByRole('article', { name: 'Money available' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(figures).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await stable(page, before);
  expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
});

test('empty and ready layouts fit desktop, tablet, mobile and shorter screens', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Explicit viewport matrix; device projects also cover preparation separately.');
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 1024 },
    mobile: devices['Pixel 7'].viewport, laptop: { width: 1366, height: 768 }, short: { width: 1200, height: 650 },
  })) {
    await test.step(name, async () => {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const start = page.getByRole('button', { name: 'Start conversation', exact: true });
      await expect(start).toBeEnabled();
      await expect(start).toBeInViewport({ ratio: 1 });
      await fits(page);
      await page.screenshot({ path: testInfo.outputPath(`production-empty-${name}.png`), fullPage: true });
      await start.click();
      await expect(page.locator('.voice-status')).toHaveText(/Ready when you are|Conversations unavailable/);
      await expect(page.getByRole('button', { name: 'Start talking' })).toBeInViewport({ ratio: 1 });
      await expect(page.locator('.financial-pane')).toBeInViewport({ ratio: 1 });
      expect(await page.locator('.caption-history-scroll').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(20);
      await fits(page);
      await page.screenshot({ path: testInfo.outputPath(`production-ready-${name}.png`), fullPage: true });
      expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
    });
  }
});

test('unavailable conversations preserve preparation and allow an availability retry', async ({ page }) => {
  let fail = false;
  await page.route('**/api/settings', async route => {
    if (fail) { await route.abort('failed'); return; }
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const settings = await response.json() as Settings;
    await route.fulfill({ response, json: { ...settings, voiceAvailable: false, voiceUnavailableReason: null } satisfies Settings });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  const connect = page.getByRole('button', { name: 'Start talking' });
  await expect(connect).toBeDisabled();
  await expect(page.locator('.voice-status')).toHaveText('Conversations unavailable');
  const before = await geometry(page);
  fail = true;
  await page.getByRole('button', { name: 'Check availability' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not check availability. Check your connection and try again.');
  await expect(connect).toBeDisabled();
  await stable(page, before);
  fail = false;
  await page.locator('.conversation-controls').getByRole('button', { name: 'Check availability' }).click();
  await expect(page.getByRole('alert', { name: 'Could not check availability' })).toHaveCount(0);
  await expect(page.locator('.conversation-controls').getByRole('button', { name: 'Check availability' })).toBeEnabled();
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  await stable(page, before);
  await fits(page);
  expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
});

test('narrow and short layouts allow natural scrolling and keyboard access without clipped controls', async ({ page }, testInfo) => {
  for (const { name, width, height, textSize } of [
    { name: 'narrow', width: 320, height: 700, textSize: '100%' },
    { name: 'enlarged', width: 320, height: 700, textSize: '200%' },
    { name: 'short', width: 1200, height: 540, textSize: '100%' },
  ]) {
    await test.step(name, async () => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Start conversation' })).toBeEnabled();
      // Typography is the only DOM style override; financial and voice state remain untouched.
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, textSize);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const skip = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skip).not.toBeInViewport();
      await skip.focus();
      await expect(skip).toBeInViewport({ ratio: 1 });
      const start = page.getByRole('button', { name: 'Start conversation' });
      await start.focus();
      await expect(start).toBeFocused();
      await expect(skip).not.toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page.locator('.voice-status')).toHaveText(/Ready when you are|Conversations unavailable/);
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      const typing = page.getByRole('button', { name: 'Prefer typing?' });
      for (let index = 0; index < 20 && !await typing.evaluate(element => element === document.activeElement); index++)
        await page.keyboard.press('Tab');
      await expect(typing).toBeFocused();
      await expect(typing).toBeInViewport({ ratio: 0.99 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const clipped = await page.locator('.conversation-controls button, .voice-feedback button, .journey-tools button').evaluateAll(elements => elements.flatMap(element => {
        const bounds = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        return Array.from(range.getClientRects()).some(text => text.left < bounds.left - 1 || text.right > bounds.right + 1 || text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1)
          ? [element.textContent] : [];
      }));
      expect(clipped, 'Control labels must wrap, not clip').toEqual([]);
      expect(await page.locator('.conversation-controls').evaluate(element => {
        const bottom = element.getBoundingClientRect().bottom;
        return [...element.querySelectorAll('button')].every(button => button.getBoundingClientRect().bottom <= bottom + 1);
      }), 'Wrapped controls must not overlap feedback or captions').toBe(true);
      expect(await page.locator('.conversation-controls').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Availability controls fit without horizontal scrolling').toBe(true);
      expect(await page.evaluate(() => !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY))).toBe(true);
      const before = await geometry(page);
      await page.keyboard.press('Enter');
      const figures = page.getByRole('region', { name: 'Your figures' });
      await expect(figures).toBeVisible();
      await expect(figures.getByRole('heading', { name: 'Your figures', exact: true })).toBeFocused();
      await expect(page).toHaveURL(/\/figures$/);
      await page.getByRole('link', { name: 'Back to conversation' }).click();
      await expect(figures).toBeHidden();
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      expect((await geometry(page)).gutter).toBe(before.gutter);
      await page.screenshot({ path: testInfo.outputPath(`production-ready-${name}-text.png`), fullPage: true });
      expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
    });
  }
});