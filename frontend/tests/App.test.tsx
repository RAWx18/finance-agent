// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { RouterProvider } from 'react-router';
import { App, appRouter, mockAuth } from './appSupport';
import { api, ApiError } from '../src/api';
import { planningSnapshot, settings, snapshot, Stream, unconfirmedSnapshot } from './fixtures';

beforeEach(() => {
  mockAuth(); Stream.instances = []; vi.stubGlobal('EventSource', Stream);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  vi.spyOn(api, 'call').mockResolvedValue({ callId: null, status: 'idle', cleanupConfirmed: true, message: null });
  vi.spyOn(api, 'current').mockResolvedValue(snapshot());
  vi.spyOn(api, 'start').mockResolvedValue(snapshot());
  vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
  vi.spyOn(api, 'save').mockResolvedValue({ ...snapshot(), revision: 1, sequence: 1 });
});
const moneyLink = () => within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Money' });
/** Opens a live Money fixture and leaves an exact starting-cash correction unsaved. */
async function cashDraft(value: string) {
  const router = appRouter('/money'); render(<RouterProvider router={router} />);
  await waitFor(() => expect(Stream.instances).toHaveLength(1)); act(() => Stream.instances[0].emit('snapshot', snapshot()));
  await userEvent.click(screen.getByRole('button', { name: 'Correct starting cash' }));
  await userEvent.selectOptions(screen.getByLabelText('Amount certainty'), 'exact');
  await userEvent.type(screen.getByLabelText('Amount (₹)'), value);
  return router;
}
it('passes loaded identity to history even while the financial session is unavailable', async () => {
  let resolve!: (value: typeof settings) => void;
  vi.mocked(api.settings).mockReturnValue(new Promise(done => { resolve = done; }));
  vi.mocked(api.current).mockRejectedValue(new TypeError('network'));
  vi.spyOn(api.history, 'list').mockResolvedValue({ conversations: [] });
  render(<RouterProvider router={appRouter('/history')} />);
  await screen.findByRole('heading', { name: 'Your conversations with Assistant' });
  await act(async () => resolve({ ...settings, assistantName: 'Maya' }));
  expect(screen.getByRole('heading', { name: 'Your conversations with Maya' })).toBeVisible();
  expect(screen.getAllByRole('link', { name: 'Talk to Maya' })).toHaveLength(2);
  expect(screen.queryByRole('link', { name: 'Talk to Isha' })).not.toBeInTheDocument();
  expect(api.start).not.toHaveBeenCalled();
});

it('explains shared and chat-only memory without creating a plan', async () => {
  render(<App />);
  await screen.findByRole('button', { name: 'Start conversation' });
  await userEvent.click(screen.getByRole('button', { name: 'Privacy' }));
  const privacy = screen.getByRole('dialog', { name: 'Privacy' });
  expect(privacy).toHaveTextContent('display name and saved notes');
  expect(privacy).toHaveTextContent('Account-level context expires separately');
  expect(privacy).toHaveTextContent('Deleting a plan removes its conversations and chat notes, but not account-level preferences or context');
  expect(privacy).toHaveTextContent('forget a saved note');
  expect(privacy).toHaveTextContent('Deleting your account removes its saved application records');
  expect(privacy).toHaveTextContent('does not save audio recordings');
  expect(privacy).toHaveTextContent('does not guarantee deletion of provider-held data');
  expect(api.start).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
});

it('keeps one persistent Money link through conversation stages without creating data', async () => {
  vi.mocked(api.current).mockResolvedValue(planningSnapshot()); render(<App />);
  await screen.findByRole('button', { name: 'Start conversation' });
  await waitFor(() => expect(Stream.instances).toHaveLength(1)); act(() => Stream.instances[0].emit('snapshot', planningSnapshot()));
  const link = moneyLink(); await waitFor(() => expect(link).not.toHaveAttribute('aria-disabled', 'true'));
  for (const action of ['Start conversation', 'Back to welcome', 'Start conversation']) {
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${action}`) }));
    expect(moneyLink()).toBe(link); expect(link).toHaveAttribute('href', '/money');
  }
  await userEvent.click(link); expect(link).toHaveAttribute('aria-current', 'page');
  await userEvent.click(screen.getByRole('button', { name: 'Plan tools' }));
  const tools = screen.getByRole('dialog', { name: 'Plan tools' });
  expect(within(tools).getByRole('link', { name: 'Download saved plan' })).toHaveAttribute('href', '/api/session/export');
  await userEvent.click(within(tools).getByRole('button', { name: 'Close plan tools' }));
  await userEvent.click(screen.getByRole('link', { name: 'Continue conversation' }));
  expect(moneyLink()).toBe(link); expect(link).not.toHaveAttribute('aria-current');
  expect(api.start).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
});
it('does not create a plan on StrictMode mount or pretend unavailable voice works', async () => {
  vi.mocked(api.current).mockRejectedValue(new ApiError(404, { code: 'notFound', message: 'No session' }));
  render(<StrictMode><App /></StrictMode>);
  const start = await screen.findByRole('button', { name: 'Start conversation' }); await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start); expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check availability' })).toBeEnabled();
  for (const element of screen.queryAllByText(/AZURE|DAILY_API_KEY|Missing setup/)) expect(element).not.toBeVisible();
  expect(api.start).not.toHaveBeenCalled(); await userEvent.click(moneyLink());
  await userEvent.click(screen.getByRole('button', { name: 'Start a blank plan' }));
  expect(api.start).toHaveBeenCalledOnce(); expect(screen.getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('Unknown');
  expect(api.save).not.toHaveBeenCalled();
});
it('reopens saved unavailable answers without claiming missing money is zero', async () => {
  vi.mocked(api.current).mockResolvedValue(unconfirmedSnapshot()); render(<App />);
  await screen.findByRole('button', { name: 'Start conversation' });
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  act(() => Stream.instances[0].emit('snapshot', unconfirmedSnapshot()));
  await userEvent.click(moneyLink());
  const picture = await screen.findByRole('region', { name: 'Money content' });
  expect(within(picture).getByRole('region', { name: 'Money in this plan' })).toHaveTextContent('Unknown');
  expect(picture).not.toHaveTextContent(/₹0\.00|Known commitments look covered/);
  await userEvent.click(within(picture).getByRole('button', { name: '2 details to review' }));
  const checks = screen.getByRole('dialog', { name: 'Needs your check' });
  expect(checks).toHaveTextContent('Have we covered all your income and commitments for these 30 days?');
  expect(checks).toHaveTextContent('What cash was available at the original cash basis?');
  expect(api.save).not.toHaveBeenCalled();
});
it('distinguishes unreadable stored state from connectivity and retries without deleting', async () => {
  vi.mocked(api.current).mockRejectedValueOnce(new ApiError(500, { code: 'invalidStoredState', message: 'private input' })).mockResolvedValue(planningSnapshot());
  render(<App />); const recovery = await screen.findByRole('region', { name: 'Your figures need another look.' });
  expect(recovery).toHaveTextContent('Nothing has been deleted.'); expect(screen.queryByText('private input')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start conversation' })).not.toBeInTheDocument();
  await userEvent.click(within(recovery).getByRole('button', { name: 'Retry connection' }));
  await screen.findByRole('button', { name: 'Start conversation' }); expect(api.current).toHaveBeenCalledTimes(2);
  expect(api.delete).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
});
it('retains a focused draft on disconnect and rejects stale overwrites after reconnect', async () => {
  await cashDraft('99'); act(() => Stream.instances[0].onerror?.());
  expect(screen.getByLabelText('Amount (₹)')).toHaveValue('99'); expect(screen.getByLabelText('Amount (₹)')).toBeDisabled();
  const latest = snapshot(); latest.revision = 1; latest.sequence = 1; latest.facts.opening = { status: 'exact', amountPaise: 20000 };
  act(() => Stream.instances[0].emit('snapshot', latest));
  expect(screen.getByLabelText('Amount (₹)')).toHaveValue('99'); expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Close and reopen');
});
it.each(['expired', 'deleted', 'notFound', 'unavailable'])('closes the stream on %s and preserves the correction', async name => {
  await cashDraft('12'); const stream = Stream.instances[0]; act(() => stream.emit(name, {}));
  expect(stream.closed).toBe(true); expect(screen.getByLabelText('Amount (₹)')).toHaveValue('12'); expect(screen.getByLabelText('Amount (₹)')).toBeDisabled();
});
it('retains contextual retry until a replacement stream supplies a current snapshot', async () => {
  await cashDraft('12'); act(() => Stream.instances[0].emit('unavailable', {}));
  const recovery = screen.getByRole('region', { name: 'Your saved plan is safe.' }); expect(recovery).toHaveClass('recovery-inline');
  await userEvent.click(within(recovery).getByRole('button', { name: 'Retry connection' }));
  await waitFor(() => expect(Stream.instances).toHaveLength(2)); act(() => Stream.instances[1].onopen?.());
  expect(recovery).toBeVisible(); expect(screen.getByLabelText('Amount (₹)')).toHaveValue('12');
  act(() => Stream.instances[1].emit('snapshot', snapshot()));
  expect(screen.queryByRole('region', { name: 'Your saved plan is safe.' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Amount (₹)')).toHaveValue('12'); expect(api.save).not.toHaveBeenCalled();
});
it('rejects excessive precision and sends zero only when explicitly reported', async () => {
  await cashDraft('1.234'); await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(screen.getByRole('alert')).toHaveTextContent('up to two decimal places'); expect(api.save).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText('Amount (₹)')); await userEvent.type(screen.getByLabelText('Amount (₹)'), '0');
  await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(vi.mocked(api.save).mock.calls[0][0].operation).toEqual({ type: 'updateFacts', changes: { expectedRevision: 0, opening: { amount: '0', status: 'exact' } } });
});
it('distinguishes service failure from empty and deletes expired state before explicit restart', async () => {
  vi.mocked(api.current).mockRejectedValueOnce(new ApiError(503, { code: 'unavailable', message: 'Storage error' })); render(<App />);
  const recovery = await screen.findByRole('region', { name: 'Your saved plan is safe.' }); expect(recovery).not.toHaveTextContent('Storage error');
  expect(screen.queryByRole('button', { name: 'Start a blank plan' })).not.toBeInTheDocument();
  vi.mocked(api.current).mockRejectedValueOnce(new ApiError(410, { code: 'expired', message: 'Expired' }));
  await userEvent.click(within(recovery).getByRole('button', { name: 'Retry connection' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Start again' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(vi.mocked(api.delete).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.start).mock.invocationCallOrder[0]);
});
it('prevents duplicate load requests while retry settles', async () => {
  let resolve!: (value: ReturnType<typeof planningSnapshot>) => void;
  vi.mocked(api.current).mockRejectedValueOnce(new TypeError('private network')).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<App />); const recovery = await screen.findByRole('region', { name: 'Your saved plan is safe.' });
  const retry = within(recovery).getByRole('button', { name: 'Retry connection' }); await userEvent.click(retry);
  expect(recovery).toHaveAttribute('aria-busy', 'true'); expect(retry).toBeDisabled(); await userEvent.click(retry); expect(api.current).toHaveBeenCalledTimes(2);
  await act(async () => resolve(planningSnapshot())); await screen.findByRole('button', { name: 'Start conversation' });
  expect(screen.queryByRole('region', { name: 'Your saved plan is safe.' })).not.toBeInTheDocument(); expect(api.start).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
});