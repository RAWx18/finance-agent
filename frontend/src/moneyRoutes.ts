// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
export const moneyRoutes = {
  '/money': 'Money',
  '/money/income': 'Income',
  '/money/spending': 'Bills & spending',
  '/money/debts': 'Loans & cards',
  '/money/upcoming': 'Upcoming',
  '/money/changes': 'Plan changes',
} as const;

export type MoneyRoute = keyof typeof moneyRoutes;
/** Identifies paths belonging to the money workspace. */
export function isMoneyRoute(path: string): path is MoneyRoute {
  return Object.hasOwn(moneyRoutes, path);
}