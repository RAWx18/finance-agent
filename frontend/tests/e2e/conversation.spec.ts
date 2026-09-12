// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Settings } from '../../src/api';
import { signIn } from './authSupport';

// Production assets and financial HTTP only; preparation must never start capture or a call.
const test = base.extend<{ preparation: void }>({
  /** Isolate preparation checks from provider traffic and financial mutations. */
  preparation: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    await context.setExtraHTTPHeaders({ Origin: origin });
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
      const allowed = request.method() === 'GET' && (['/', '/login', '/app', '/history', '/money', '/money/income', '/money/spending', '/money/debts', '/money/upcoming', '/money/changes', '/account', '/auth/callback', '/api/settings', '/api/session', '/api/account'].includes(url.pathname)
        || /^\/(?:api\/)?history(?:\/[^/]+)?$/.test(url.pathname)
        || /^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname))
        || url.pathname.startsWith('/api/auth/') && ['GET', 'POST'].includes(request.method());
      if (url.origin !== origin || !allowed) {
        blocked.push(`${request.method()} ${request.url()}`);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await signIn(page);
    try { await use(); }
    finally {
      expect(blocked, 'Preparation must not contact providers or mutate financial data').toEqual([]);
      expect(errors).toEqual([]);
    }
  }, { auto: true }],
});

test.use({ serviceWorkers: 'block', launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

/** Capture the conversation layout and page offsets for stability comparisons. */
async function geometry(page: Page) {
  return page.evaluate(() => ({
    y: scrollY, gutter: innerWidth - document.documentElement.clientWidth,
    boxes: ['.site-header', 'main', '.journey-intro h1', '.conversation', '.call-orb', '.conversation-controls', '.live-caption', '.financial-pane', '.context-scroll', '.site-footer'].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [];
      const { x, y, width, height } = element.getBoundingClientRect();
      return [{ selector, x, y, width, height }];
    }),
  }));
}

/** Verify a transition preserves conversation geometry and page positioning. */
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

/** Verify preparation layouts keep essential content visible, usable and uncluttered. */
async function fits(page: Page) {
  const size = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight, root: document.querySelector('#root')!.getBoundingClientRect().height,
  }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 1);
  const natural = await page.locator('.live-layout:visible').count() > 0 && (size.height <= 700 || size.width <= 700 && size.height <= 780);
  if (natural) {
    expect(size.root).toBeGreaterThanOrEqual(size.height);
    expect(await page.evaluate(() => !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY))).toBe(true);
    await page.locator('.site-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.site-footer')).toBeInViewport({ ratio: 1 });
    await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
  } else {
    expect(size.scrollHeight, 'Standard layouts fit without document scrolling').toBeLessThanOrEqual(size.height + 1);
    expect(Math.abs(size.root - size.height)).toBeLessThanOrEqual(1);
    await expect(page.locator('.site-footer')).toBeInViewport({ ratio: 1 });
  }
  if (await page.locator('.live-layout:visible').count()) {
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('.voice-status')).toBeVisible();
  } else await expect(page.getByRole('heading', { level: 1 })).toBeInViewport({ ratio: 1 });
  await expect(page.locator('details, summary, [aria-expanded]:not(.toast-viewport *):not(button[aria-label="Profile menu"][aria-haspopup="menu"])')).toHaveCount(0);
  const money = page.getByRole('link', { name: 'Money', exact: true });
  await expect(money).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true })).toHaveCount(1);
  await expect(money).toBeInViewport({ ratio: 1 });
  await expect(money).toBeEnabled();
  await expect(page.getByRole('button', { name: /^(Money|Prefer typing\?)$/ })).toHaveCount(0);
  await expect(page.locator('.journey-tools')).toHaveCount(0);
  if (await page.locator('.call-orb').count()) {
    const orb = page.locator('.call-orb');
    await expect(orb.locator('canvas.aui-voice-orb')).toHaveCount(1);
    await expect(orb.locator('svg')).toHaveCount(0);
    const bounds = (await orb.locator('canvas.aui-voice-orb').boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(150);
    expect(Math.abs(bounds.height - bounds.width)).toBeLessThanOrEqual(1);
    const wrapper = (await orb.boundingBox())!;
    expect(Math.abs(bounds.width - wrapper.width * 2)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('region', { name: 'Live caption', exact: true })).toContainText('Captions appear here');
    await expect(page.locator('.captions, [class*="caption-history"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
  }
  const surfaces = page.locator('.site-header, .welcome-aside, .conversation, .financial-pane, .live-caption, .conversation-controls button');
  expect(await surfaces.evaluateAll(elements => elements.flatMap(element => {
    const style = getComputedStyle(element);
    return style.backgroundImage.includes('gradient(') || Number.parseFloat(style.borderLeftWidth) > Number.parseFloat(style.borderRightWidth)
      || style.borderLeftColor !== style.borderRightColor || style.boxShadow.includes('inset') ? [element.className] : [];
  })), 'Representative surfaces use solid fills and no left-accent rails').toEqual([]);
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
    const notifications = page.getByRole('complementary', { name: 'Notifications' });
    await expect(notifications).toHaveCSS('pointer-events', 'none');
    const stack = notifications.getByRole('list', { name: 'Notification list' });
    await expect(stack).toHaveCSS('pointer-events', 'auto');
    await expect(notifications.getByRole('alert')).toHaveCSS('pointer-events', 'auto');
    expect(await stack.evaluate(element => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.right - 1, box.y + box.height / 2));
    }), 'Notification scroll edge receives pointer input').toBe(true);
    const toggle = notifications.getByRole('button', { name: 'Minimize notifications', exact: true });
    await expect(toggle).toHaveCSS('pointer-events', 'auto');
    await toggle.click({ trial: true });
    expect(await notifications.evaluate(element => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + 1, box.y + 1)?.closest('.toast-viewport') !== null;
    }), 'Empty space beside the notification toggle does not intercept underlying controls').toBe(false);
  }
  await expect(page.locator('body')).not.toContainText(/Missing setup|OPENAI_API_KEY|DAILY_API_KEY|AZURE_SPEECH|stack trace/i);
  await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
  await expect(page.locator('.voice-emblem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect microphone', exact: true })).toHaveCount(0);
  const orb = page.locator('.call-orb');
  await expect(orb).toHaveAttribute('role', 'img');
  await expect(orb).toHaveAccessibleName(settings.voiceAvailable ? 'Ready when you are' : 'Conversations unavailable');
  await expect(orb).toHaveAttribute('data-volume', '0');
  const canvas = orb.locator('canvas.aui-voice-orb');
  await expect(canvas).toHaveAttribute('data-state', 'idle');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext('webgl2');
    const program = gl?.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    return gl && program ? gl.getUniform(program, gl.getUniformLocation(program, 'u_time')!) as number : 0;
  })).toBeGreaterThan(0);
  const uniforms = await canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext('webgl2')!;
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    return { linked: gl.getProgramParameter(program, gl.LINK_STATUS) as boolean,
      speed: gl.getUniform(program, gl.getUniformLocation(program, 'u_speed')!) as number,
      amplitude: gl.getUniform(program, gl.getUniformLocation(program, 'u_amplitude')!) as number,
      color: Array.from(gl.getUniform(program, gl.getUniformLocation(program, 'u_color0')!) as Float32Array) };
  });
  expect(uniforms.linked).toBe(true);
  expect(uniforms.speed).toBeCloseTo(.15, 6);
  expect(uniforms.amplitude).toBeCloseTo(.04, 6);
  for (const [index, value] of [.15, .75, .55].entries()) expect(uniforms.color[index]).toBeCloseTo(value, 6);
  await expect(page.getByRole('heading', { name: 'No figures yet' })).toBeVisible();
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath('production-ready.png'), fullPage: true });
  const before = await geometry(page);
  const privacy = page.locator('.site-footer').getByRole('button', { name: 'Privacy', exact: true });
  const minimize = page.getByRole('button', { name: 'Minimize notifications', exact: true });
  if (await minimize.isVisible()) {
    await minimize.click();
    const toggle = page.getByRole('button', { name: 'Notifications (1)', exact: true });
    await expect(toggle).toBeInViewport({ ratio: 1 });
    const bounds = (await toggle.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual((await privacy.boundingBox())!.y);
    await page.screenshot({ path: testInfo.outputPath('production-minimized-notifications.png'), fullPage: true });
  }
  await privacy.click();
  const dialog = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(dialog.getByRole('heading', { name: 'Privacy', exact: true })).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(dialog.locator('.dialog-body')).toHaveCSS('overflow-y', 'auto');
  await stable(page, before);
  // Native modal inertness must reject focus even on an otherwise available background action.
  await page.getByRole('navigation', { name: 'Main navigation', includeHidden: true }).getByRole('link', { name: 'Money', exact: true, includeHidden: true }).focus();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    await expect(dialog.locator(':focus')).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(privacy).toBeFocused();
  await stable(page, before);
  await expect(page.getByRole('button', { name: 'Start a blank plan' })).toBeHidden();
  if (await minimize.isVisible()) await minimize.click();
  const typing = page.getByRole('link', { name: 'Money', exact: true });
  await typing.click();
  const money = page.getByRole('region', { name: 'Money', exact: true });
  await expect(money).toBeVisible();
  await expect(page).toHaveURL(/\/money$/);
  await expect(money.getByRole('heading', { name: 'No plan yet' })).toBeVisible();
  await expect(money.getByRole('button', { name: 'Start a blank plan' })).toBeEnabled();
  await expect(money.getByRole('region', { name: 'Money in this plan' })).toHaveCount(0);
  await money.getByRole('link', { name: 'Continue conversation' }).click();
  await expect(money).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await stable(page, before);
  expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
});

test('Money, settings and history return to preparation without starting a conversation', async ({ page }) => {
  for (const path of ['/money', '/account', '/history']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(path === '/money' ? 'Money' : path === '/history' ? 'History' : 'Settings');
    if (path === '/history') {
      const saved = page.getByRole('navigation', { name: 'Saved conversations', exact: true });
      await expect(saved).toHaveAttribute('aria-busy', 'false');
      await expect(saved).toHaveText('No conversations yet.');
      await expect(saved.getByRole('link')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toHaveCount(0);
      await expect(page.locator('canvas')).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^(Start talking|Start conversation|Reconnect)$/ })).toHaveCount(0);
    expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
    if (path === '/history') await page.getByRole('region', { name: 'History', exact: true }).getByRole('link', { name: 'Talk to Isha', exact: true }).last().click();
    else await page.getByRole('link', { name: path === '/money' ? 'Continue conversation' : 'Conversation', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Start talking', exact: true })).toHaveCount(0);
    expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start talking', exact: true })).toBeVisible();
    await expect(page.locator('.voice-status-panel')).toHaveAttribute('data-capturing', 'false');
    expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
  }
});

test('empty and ready layouts fit desktop, tablet, mobile and shorter screens', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Explicit viewport matrix; device projects also cover preparation separately.');
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 1024 },
    mobile: { width: 390, height: 844 }, laptop: { width: 1366, height: 768 }, short: { width: 1200, height: 650 },
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
      await page.locator('.financial-pane').scrollIntoViewIfNeeded();
      await expect(page.locator('.financial-pane')).toBeInViewport({ ratio: .99 });
      await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('region', { name: 'Live caption', exact: true })).toContainText('Captions appear here');
      await expect(page.getByRole('region', { name: 'Earlier captions', exact: true })).toHaveCount(0);
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
  await expect(page.getByRole('alert', { name: 'Could not check availability' })).toContainText('Check your connection and try again.');
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
      const typing = page.getByRole('link', { name: 'Money', exact: true });
      for (let index = 0; index < 20 && !await typing.evaluate(element => element === document.activeElement); index++)
        await page.keyboard.press('Shift+Tab');
      await expect(typing).toBeFocused();
      await expect(typing).toBeInViewport({ ratio: 0.99 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const clipped = await page.locator('.conversation-controls button, .site-navigation a, .site-navigation button').evaluateAll(elements => elements.flatMap(element => {
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
      const money = page.getByRole('region', { name: 'Money', exact: true });
      await expect(money).toBeVisible();
      await expect(money.getByRole('heading', { name: 'Money', exact: true })).toBeFocused();
      await expect(page).toHaveURL(/\/money$/);
      await expect(money.getByRole('button', { name: 'Start a blank plan' })).toBeEnabled();
      await money.getByRole('link', { name: 'Continue conversation' }).click();
      await expect(money).toBeHidden();
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      expect((await geometry(page)).gutter).toBe(before.gutter);
      await page.screenshot({ path: testInfo.outputPath(`production-ready-${name}-text.png`), fullPage: true });
      expect((await page.request.get('/api/session', { maxRedirects: 0 })).status()).toBe(404);
    });
  }
});