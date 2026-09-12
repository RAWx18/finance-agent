// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
const paths = {
  edit: 'm15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z',
  remove: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7',
  back: 'm12 5-7 7 7 7M5 12h15',
  close: 'm6 6 12 12M6 18 18 6',
  expand: 'm9 5 7 7-7 7',
  search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
  filter: 'M4 6h16M7 12h10M10 18h4',
  more: 'M5 11v2m7-2v2m7-2v2',
  print: 'M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7v-7Z',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  add: 'M12 5v14M5 12h14',
  talk: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 10h8M8 14h5',
} as const;

export function MoneyIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}