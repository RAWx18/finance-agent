// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RouteError } from '../src/App';
import { Recovery } from '../src/Recovery';

describe('shared recovery treatment', () => {
  it('keeps keyboard focus and content stable when only the retry is pending', () => {
    const view = render(<Recovery title="Your saved plan is safe." message="Retry to see your figures.">
      <button>Retry connection</button>
    </Recovery>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    const retry = screen.getByRole('button', { name: 'Retry connection' });
    retry.focus();
    view.rerender(<Recovery title="Your saved plan is safe." message="Retry to see your figures." busy>
      <button>Trying again…</button>
    </Recovery>);
    expect(retry).toHaveFocus();
    expect(screen.getByRole('region')).toHaveAccessibleDescription('Retry to see your figures.');
    expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'true');
  });

  it('announces contextual recovery without moving focus away from a draft', () => {
    render(<><input aria-label="Draft" autoFocus /><Recovery inline title="Your saved plan is safe." message="Your draft is kept.">
      <button>Retry connection</button>
    </Recovery></>);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Your saved plan is safe.');
    expect(screen.getByRole('status')).toHaveTextContent('Your draft is kept.');
  });

  it('renders route recovery without needing the failed authentication provider', () => {
    render(<MemoryRouter><RouteError /></MemoryRouter>);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('link', { name: 'Cash flow home' }));
    expect(within(main).getByRole('heading', { name: 'Let’s try that again.' })).toHaveFocus();
    expect(within(main).getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('No payments are made.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});