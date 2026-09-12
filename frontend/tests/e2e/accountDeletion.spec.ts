// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AuthSession, Snapshot } from '../../src/api';
import { signIn } from './authSupport';
import { command } from './moneySupport';

test.use({ serviceWorkers: 'block' });

for (const [index, mode] of ['cancel callback', 'Back without callback', 'close OAuth tab'].entries()) {
  test(`account deletion stays anonymous after ${mode}; explicit same-Google signup starts empty (provider double)`, async ({ page, context, baseURL }, info) => {
    test.skip(!['desktop', 'mobile'].includes(info.project.name), 'Three OAuth exit paths on desktop and mobile.');
    const origin = new URL(baseURL!).origin;
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(origin).hostname);
    expect(process.env.E2E_DATA_DIR, 'Use the isolated e2e server and its synthetic Google identity').toBeTruthy();
    await context.setExtraHTTPHeaders({ Origin: origin });

    const email = 'google-user-one@example.com';
    const displayName = `Deletion ${info.project.name} ${index} ${randomUUID().slice(0, 8)}`;
    const cash = 47183 + index * 1000 + (info.project.name === 'mobile' ? 100 : 0);
    const cashText = `₹${cash.toLocaleString('en-IN')}`;
    const callbacks = new Map<string, string>();
    const callbackRequests: { state: string | null; code: boolean; error: string | null }[] = [];
    const silentSuccesses: string[] = [];
    const blocked: string[] = [];
    let choosing = false;
    let selected = false;
    let loginRequests = 0;
    let releaseDeletion: (() => void) | undefined;

    context.on('request', request => {
      const url = new URL(request.url());
      if (!choosing || url.origin !== origin) return;
      if (url.pathname === '/api/auth/login' && request.method() === 'POST') loginRequests++;
      if (url.pathname === '/auth/callback') callbackRequests.push({
        state: url.searchParams.get('state'), code: url.searchParams.has('code'), error: url.searchParams.get('error'),
      });
    });
    context.on('response', response => {
      const url = new URL(response.url());
      if (choosing && !selected && url.origin === origin && response.ok()
        && ['/api/auth/session', '/api/auth/refresh'].includes(url.pathname)) silentSuccesses.push(url.pathname);
    });
    await context.routeWebSocket('**', socket => {
      blocked.push(socket.url());
      socket.close({ code: 1008, reason: 'Account deletion tests prohibit provider connections' });
    });
    await context.addInitScript(() => {
      const state = window as typeof window & { accountDeletionCaptureRequests: number };
      state.accountDeletionCaptureRequests = 0;
      /** Record and reject microphone requests during account deletion checks. */
      navigator.mediaDevices.getUserMedia = async () => {
        state.accountDeletionCaptureRequests++;
        throw new DOMException('Account deletion tests prohibit audio capture', 'NotAllowedError');
      };
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/api/auth/login' && request.method() === 'POST' && choosing) {
        // BrowserGoogle preissues a valid callback; only the chooser navigation is substituted.
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.status()).toBe(200);
        const body = await response.json() as { url: string };
        const callback = new URL(body.url);
        expect(callback.origin).toBe(origin);
        expect(callback.pathname).toBe('/auth/callback');
        expect(callback.searchParams.get('code')).toBeTruthy();
        const state = callback.searchParams.get('state');
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        callbacks.set(state!, callback.href);
        const chooser = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        chooser.searchParams.set('state', state!);
        await route.fulfill({ response, json: { ...body, url: chooser.href } });
      } else if (url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
        && request.isNavigationRequest() && request.method() === 'GET' && callbacks.has(url.searchParams.get('state') ?? '')) {
        const callback = callbacks.get(url.searchParams.get('state')!)!;
        const cancel = new URL('/auth/callback', origin);
        cancel.searchParams.set('state', url.searchParams.get('state')!);
        cancel.searchParams.set('error', 'access_denied');
        // This provider double does not verify Google's consent UI or the outgoing prompt parameter.
        await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'Cache-Control': 'no-store' }, body: `<!doctype html>
          <html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Google chooser provider double</title></head>
          <body><main><h1>Google chooser provider double</h1><p>Available Google account: ${email}</p>
          <p>No sign-in completes until you explicitly continue with this account.</p>
          <p><a href="${callback.replaceAll('&', '&amp;')}">Continue as ${email}</a></p>
          <p><a href="${cancel.href.replaceAll('&', '&amp;')}">Cancel sign-in</a></p></main></body></html>` });
      } else if (url.origin !== origin || url.pathname === '/api/session/call' && request.method() !== 'GET') {
        blocked.push(`${request.method()} ${url.href}`);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });

    /** Verify the login page exposes no deleted account or financial information. */
    async function expectAnonymous(tab: Page) {
      await expect(tab).toHaveURL(url => url.origin === origin && url.pathname === '/login');
      await expect(tab.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled();
      await expect(tab.getByRole('button', { name: 'Profile menu', exact: true })).toHaveCount(0);
      await expect(tab.getByRole('navigation', { name: 'Main navigation', exact: true })).toHaveCount(0);
      await expect(tab.getByRole('textbox', { name: 'Display name', exact: true })).toHaveCount(0);
      await expect(tab.getByRole('region', { name: 'Money', exact: true })).toHaveCount(0);
      await expect(tab.getByRole('link', { name: 'Continue to your plan', exact: true })).toHaveCount(0);
      for (const text of [displayName, email, cashText]) await expect(tab.locator('body')).not.toContainText(text);
    }

    /** Verify private APIs and session refresh remain inaccessible before account selection. */
    async function expectUnauthorized() {
      // An abandoned chooser may retain its flow-binding cookie, never an authenticated session.
      expect((await context.cookies(origin)).filter(cookie => /(?:^|-)financeSession$/.test(cookie.name))).toEqual([]);
      for (const path of ['/api/auth/session', '/api/settings', '/api/session', '/api/history']) {
        expect((await context.request.get(path, { maxRedirects: 0 })).status(), path).toBe(401);
      }
      expect((await context.request.post('/api/auth/refresh', { data: {} })).status()).toBe(401);
      expect(callbackRequests.filter(request => request.code), 'No successful callback request before explicit account selection').toEqual([]);
      expect(silentSuccesses, 'No browser session or refresh success while anonymous').toEqual([]);
    }

    /** Verify the provider-double chooser awaits explicit selection without authenticating. */
    async function expectChooser(tab: Page) {
      await expect(tab).toHaveURL(url => url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth');
      await expect(tab.getByRole('heading', { name: 'Google chooser provider double', exact: true })).toBeVisible();
      await expect(tab.getByText(`Available Google account: ${email}`, { exact: true })).toBeVisible();
      await expect(tab.getByRole('link', { name: `Continue as ${email}`, exact: true })).toHaveAttribute('href',
        callbacks.get(new URL(tab.url()).searchParams.get('state')!)!);
      await expectUnauthorized();
    }

    try {
      await signIn(page, '/account');
      const session = await context.request.get('/api/auth/session');
      expect(session.status()).toBe(200);
      const original = await session.json() as AuthSession;
      expect(original.user.email).toBe(email);
      expect(original.user.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      expect(original.user.displayName, 'Do not reuse a customized account from another workstream').toBe(original.user.googleName);
      expect((await context.request.get('/api/session')).status(), 'Each case owns a fresh synthetic account').toBe(404);
      const history = await context.request.get('/api/history');
      expect(history.status()).toBe(200);
      expect(await history.json()).toEqual({ conversations: [] });

      const created = await context.request.post('/api/session', { data: {} });
      expect(created.status()).toBe(200);
      const saved = await command(page, { type: 'replaceFacts', facts: {
        opening: { amount: String(cash), status: 'exact' }, reserve: '0', records: [],
        coverage: { income: 'none', essential: 'none', optional: 'none', debt: 'none' },
      } });
      expect(saved.facts.opening.amountPaise).toBe(cash * 100);
      await page.getByRole('textbox', { name: 'Display name', exact: true }).fill(displayName);
      const renamed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account' && response.request().method() === 'PATCH');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await renamed).status()).toBe(200);
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await page.reload();
      await expect(page.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue(displayName);
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Money in this plan', exact: true })).toContainText(cashText);
      const sibling = await context.newPage();
      await sibling.goto('/money');
      await expect(sibling.getByRole('region', { name: 'Money in this plan', exact: true })).toContainText(cashText);
      await sibling.getByRole('button', { name: 'Profile menu', exact: true }).click();
      await expect(sibling.locator('.profile-identity')).toContainText(displayName);
      await sibling.keyboard.press('Escape');
      const cookies = await context.cookies(origin);
      expect(cookies.some(cookie => cookie.name === 'financeSession' && cookie.httpOnly)).toBe(true);

      await page.bringToFront();
      await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Delete app account', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete your app account?', exact: true });
      await expect(dialog).toContainText('Your Google account will not be deleted.');
      const remove = dialog.getByRole('button', { name: 'Permanently delete app account', exact: true });
      await expect(remove).toBeDisabled();
      await dialog.getByRole('textbox', { name: 'Type DELETE to confirm', exact: true }).fill('DELETE');
      let committed!: () => void;
      const commit = new Promise<void>(resolve => { committed = resolve; });
      const acknowledgement = new Promise<void>(resolve => { releaseDeletion = resolve; });
      await page.route('**/api/account', async route => {
        if (route.request().method() !== 'DELETE') { await route.fallback(); return; }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        committed();
        await acknowledgement;
        await route.fulfill({ response });
      });
      const deletion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account' && response.request().method() === 'DELETE');
      await remove.click();
      await commit;
      // The committed SSE event must win safely over a delayed DELETE acknowledgment.
      await expect(page).toHaveURL(`${origin}/login`);
      await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeDisabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Profile menu', exact: true })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(/Your saved plan is safe|Opening your plan|Please sign in again|Your sign-in|have been deleted/);
      await expect(sibling).toHaveURL(`${origin}/login`);
      releaseDeletion!();
      const deleted = await deletion;
      expect(deleted.request().postDataJSON()).toEqual({ confirmation: 'DELETE' });
      expect(deleted.status()).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
      await page.unroute('**/api/account');
      await expectAnonymous(page);
      await expectAnonymous(sibling);
      await expect(page).toHaveURL(`${origin}/login`);
      await expect(sibling).toHaveURL(`${origin}/login`);
      expect(await context.cookies(origin), 'Deletion clears the app session and OAuth flow cookies').toEqual([]);
      choosing = true;
      await expectUnauthorized();
      expect(loginRequests).toBe(0);

      // OAuth replaces the current document; closing it requires a separate landing tab, not a popup.
      const oauth = mode === 'close OAuth tab' ? await context.newPage() : page;
      if (oauth !== page) { await oauth.goto('/login'); await expectAnonymous(oauth); }
      await oauth.getByRole('button', { name: 'Continue with Google', exact: true }).click();
      await expectChooser(oauth);
      expect(loginRequests).toBe(1);
      expect(callbackRequests).toEqual([]);
      const state = new URL(oauth.url()).searchParams.get('state')!;
      if (mode === 'cancel callback') {
        await oauth.getByRole('link', { name: 'Cancel sign-in', exact: true }).click();
        await expect(oauth).toHaveURL(`${origin}/login?error=cancelled`);
        await expect(oauth.getByText('Sign-in was cancelled. You can try again when you’re ready.', { exact: true })).toBeVisible();
        expect(callbackRequests).toEqual([{ state, code: false, error: 'access_denied' }]);
      } else if (mode === 'Back without callback') await oauth.goBack();
      else { await oauth.close(); expect(oauth.isClosed()).toBe(true); }

      for (const tab of [page, sibling]) {
        await tab.bringToFront();
        await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expectAnonymous(tab);
        await tab.reload();
        await expectAnonymous(tab);
        await tab.goto('/money');
        await expectAnonymous(tab);
        await tab.goBack();
        await expectAnonymous(tab);
        await tab.goForward();
        await expectAnonymous(tab);
      }
      await expectUnauthorized();
      expect(loginRequests, 'Focus, reload and history navigation must not initiate another sign-in').toBe(1);
      expect(callbackRequests).toEqual(mode === 'cancel callback' ? [{ state, code: false, error: 'access_denied' }] : []);

      await page.bringToFront();
      await page.goto('/login');
      await expectAnonymous(page);
      await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
      await expectChooser(page);
      expect(loginRequests).toBe(2);
      const signupState = new URL(page.url()).searchParams.get('state')!;
      expect(signupState).not.toBe(state);
      selected = true;
      const callback = page.waitForResponse(response => response.url() === callbacks.get(signupState));
      await page.getByRole('link', { name: `Continue as ${email}`, exact: true }).click();
      expect((await callback).status()).toBe(303);
      await expect(page).toHaveURL(`${origin}/app`);
      await expect(page.getByRole('button', { name: 'Profile menu', exact: true })).toBeVisible();
      expect(callbackRequests.filter(request => request.code)).toEqual([{ state: signupState, code: true, error: null }]);
      expect(silentSuccesses).toEqual([]);
      const signedIn = await context.request.get('/api/auth/session');
      expect(signedIn.status()).toBe(200);
      const fresh = await signedIn.json() as AuthSession;
      expect(fresh.user.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      expect(fresh.user.id).not.toBe(original.user.id);
      expect(fresh.user.email).toBe(original.user.email);
      expect(fresh.user.googleName).toBe(original.user.googleName);
      expect(fresh.user.displayName).toBe(original.user.googleName);
      expect(fresh.user.displayName).not.toBe(displayName);
      expect((await context.request.get('/api/session')).status()).toBe(404);
      const emptyHistory = await context.request.get('/api/history');
      expect(emptyHistory.status()).toBe(200);
      expect(await emptyHistory.json()).toEqual({ conversations: [] });
      await page.goto('/account');
      await expect(page.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue(fresh.user.displayName);
      await expect(page.getByText(email, { exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(displayName);

      const blank = await context.request.post('/api/session', { data: {} });
      expect(blank.status()).toBe(200);
      const snapshot = await blank.json() as Snapshot;
      expect(snapshot.sessionId).not.toBe(saved.sessionId);
      expect(snapshot.facts.opening).toMatchObject({ amountPaise: null, status: 'unknown' });
      expect(snapshot.facts.records).toEqual([]);
      expect(snapshot.preview).toBeNull();
      expect(snapshot.accepted).toBeNull();
      await page.goto('/money');
      await expect(page.getByRole('button', { name: 'Add starting cash', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Money in this plan', exact: true })).not.toContainText(cashText);
      for (const tab of context.pages()) {
        expect(await tab.evaluate(() => (window as typeof window & { accountDeletionCaptureRequests: number }).accountDeletionCaptureRequests)).toBe(0);
      }
      expect(blocked, 'No external traffic, voice sessions or WebSockets are permitted').toEqual([]);
    } finally {
      releaseDeletion?.();
      await Promise.all(context.pages().map(tab => tab.close()));
      const session = await context.request.get('/api/auth/session');
      if (session.status() === 200) {
        expect((await session.json() as AuthSession).user.email).toBe(email);
        const deletion = await context.request.delete('/api/account', { data: { confirmation: 'DELETE' } });
        expect(deletion.status()).toBe(200);
        expect(await deletion.json()).toEqual({ deleted: true });
        expect((await context.request.get('/api/auth/session')).status()).toBe(401);
      } else expect(session.status()).toBe(401);
    }
  });
}