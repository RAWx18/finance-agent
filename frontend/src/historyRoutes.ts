// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
export function isHistoryRoute(path: string): boolean {
  return path.length <= 128 && /^\/history(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(path)?.[0] === path;
}