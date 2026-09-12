// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { ConversationSummary, SavedConversation } from '../../src/api';
import { signIn } from './authSupport';

let conversations: ConversationSummary[];
let errors: string[];

test.beforeEach(async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
  expect(process.env.E2E_DATA_DIR).toBeTruthy();
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.setExtraHTTPHeaders({ Origin: origin });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname === '/api/session/call' && request.method() === 'POST') {
      errors.push(`Unexpected provider request: ${request.method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await signIn(page, '/history');
  expect((await context.request.delete('/api/session')).status()).toBe(200);
  const session = await (await context.request.get('/api/auth/session')).json();
  const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));
  const seeded = spawnSync('uv', ['run', '--project', backend, '--locked', 'python', '-m', 'tests.history_support', session.user.id], {
    cwd: backend, env: process.env, encoding: 'utf8',
  });
  expect(seeded.status, seeded.stderr).toBe(0);
  const response = await context.request.get('/api/history');
  expect(response.status()).toBe(200);
  conversations = (await response.json()).conversations;
  expect(conversations).toHaveLength(4);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Saved conversations' }).getByRole('link')).toHaveCount(4);
});

test.afterEach(async ({ context }) => {
  expect(errors).toEqual([]);
  expect((await context.request.delete('/api/session')).status()).toBe(200);
});

test('opens durable two-sided chats, deep-links on reload and downloads only stored captions', async ({ page, context }, info) => {
  const conversation = conversations[0];
  await page.locator(`[href="/history/${conversation.slug}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/history/${conversation.slug}$`));
  const saved = await (await context.request.get(`/api/history/${conversation.slug}`)).json() as SavedConversation;
  const viewport = page.getByRole('region', { name: 'Conversation messages' });
  await expect(viewport.getByRole('article')).toHaveCount(saved.messages.length);
  expect(await viewport.locator('.aui-message-text').allTextContents()).toEqual(saved.messages.map(message => message.text));
  expect(await viewport.getByRole('article').evaluateAll(elements => elements.map(element => element.getAttribute('data-role')))).toEqual(saved.messages.map(message => message.role));
  expect(await viewport.locator('time').evaluateAll(elements => elements.map(element => element.getAttribute('datetime')))).toEqual(saved.messages.map(message => message.createdAt));
  await expect(viewport.getByText('Isha', { exact: true }).first()).toBeVisible();
  await expect(viewport.getByText('You', { exact: true }).first()).toBeVisible();
  await expect(page.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send|Regenerate/ })).toHaveCount(0);
  await expect(page.locator('[data-slot="thread-list"]')).toHaveCount(1);
  await expect(page.locator('[data-slot="day-separator"]')).toHaveCount(1);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download captions' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${conversation.slug}-captions.txt`);
  const text = await readFile((await file.path())!, 'utf8');
  expect(text).toBe(await (await context.request.get(`/api/history/${conversation.slug}/transcript`)).text());
  expect(text).toContain('] Isha\n'); expect(text).toContain('] You\n');
  expect(text).not.toMatch(/sessionId|call_id|segment_id|provider|tool_call|amountPaise|voice_generation/);
  for (const message of saved.messages) expect(text).toContain(message.text);

  await page.reload();
  await expect(page.locator('.aui-message-text')).toHaveText(saved.messages.map(message => message.text));
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: info.outputPath('history.png') });
});

test('searches stored response content and dates, preserves selection, and keeps compact navigation', async ({ page }, info) => {
  const list = page.getByRole('navigation', { name: 'Saved conversations' });
  await expect(list.getByRole('link', { name: /Can I cover rent before payday/ })).toHaveCount(2);
  const search = page.getByRole('searchbox', { name: 'Search conversations' });
  await search.fill('commute');
  await expect(list.getByRole('link')).toHaveCount(1);
  await expect(list.getByRole('link')).toContainText('Help me plan groceries.');
  await list.getByRole('link').click();
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('including your commute');
  if (info.project.name === 'mobile') {
    await expect(search).not.toBeVisible();
    await page.getByRole('link', { name: 'All conversations', exact: true }).click();
    await expect(search).toBeVisible(); await expect(search).toHaveValue('commute');
  } else {
    await expect(search).toBeVisible();
    const url = page.url();
    await search.fill('not in any caption');
    await expect(list).toContainText('No matching conversations.');
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('including your commute');
    await page.getByRole('button', { name: 'Clear search' }).click();
  }
  await search.fill(conversations[0].startedAt.slice(0, 10));
  await expect(list.getByRole('link')).not.toHaveCount(0);
  await search.fill('definitely absent');
  await expect(list).toContainText('No matching conversations.');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(list.getByRole('link')).toHaveCount(4);
  await page.screenshot({ path: info.outputPath('historySearch.png') });
});

test('scrolls the conversation instead of the page and preserves reading on refresh', async ({ page }, info) => {
  await page.locator(`[href="/history/${conversations[0].slug}"]`).click();
  const viewport = page.getByRole('region', { name: 'Conversation messages' });
  await expect(viewport).toBeVisible();
  await expect.poll(async () => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(30);
  const before = await page.locator('.history-chat-heading').boundingBox();
  await viewport.evaluate(element => { element.scrollTop = 90; element.focus(); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => viewport.evaluate(element => element.scrollTop)).toBe(90);
  await expect(viewport).toBeFocused();
  expect(await page.locator('.history-chat-heading').boundingBox()).toEqual(before);
  await page.getByRole('button', { name: 'Latest messages' }).click();
  await expect.poll(async () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
  const size = await page.evaluate(() => ({ height: document.documentElement.scrollHeight - innerHeight, width: document.documentElement.scrollWidth - innerWidth }));
  expect(size.height).toBeLessThanOrEqual(1); expect(size.width).toBeLessThanOrEqual(1);
  if (info.project.name === 'mobile') await expect(page.locator('.history-sidebar')).not.toBeVisible();
  else await expect(page.locator('.history-sidebar')).toBeVisible();
});

test('handles empty, unavailable and deleted conversations without exposing implementation details', async ({ page, context }) => {
  const empty = conversations.find(item => item.messageCount === 0)!;
  await page.goto(`/history/${empty.slug}`);
  await expect(page.getByText('No captions saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download captions' })).toHaveCount(0);
  const route = `**/api/history/${conversations[0].slug}`;
  await page.route(route, handler => handler.fulfill({ status: 503, json: { code: 'unavailable', message: 'private-storage-diagnostic' } }));
  await page.goto(`/history/${conversations[0].slug}`);
  await expect(page.getByText('Couldn’t open this conversation')).toBeVisible();
  await expect(page.getByText('private-storage-diagnostic')).toHaveCount(0);
  await page.unroute(route);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible();
  expect((await context.request.delete('/api/session')).status()).toBe(200);
  await page.reload();
  await expect(page.getByText('Conversation unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download captions' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'All conversations', exact: true }).last()).toBeVisible();
});

test('auth protects nested deep links and sign-out hides captions without erasing the stored chat', async ({ page, context }) => {
  const path = `/history/${conversations[0].slug}`;
  await page.goto(path);
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible();
  await page.getByRole('button', { name: 'Profile menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByText('Can I cover rent before payday?')).toHaveCount(0);
  expect((await context.request.get(`/api/history/${conversations[0].slug}/transcript`, { maxRedirects: 0 })).status()).toBe(401);
  const response = await context.request.get(path, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe(`/login?returnTo=${path}`);
  await signIn(page, path);
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('My salary comes on the 20th');
});

test('keeps small-screen enlarged text usable without horizontal or full-page overflow', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'One narrow viewport check covers all desktop project variants.');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator(`[href="/history/${conversations[0].slug}"]`).click();
  const viewport = page.getByRole('region', { name: 'Conversation messages' });
  await expect(viewport).toBeVisible();
  expect(await viewport.evaluate(element => element.clientHeight)).toBeGreaterThan(180);
  const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth - innerWidth, height: document.documentElement.scrollHeight - innerHeight }));
  expect(size.width).toBeLessThanOrEqual(1); expect(size.height).toBeLessThanOrEqual(1);
  await expect(page.getByRole('link', { name: 'All conversations', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download captions' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('historyLargeText.png') });
});