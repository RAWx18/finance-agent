// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only

/** Emit one structured browser console line sharing the server's correlation labels. */
export function log(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' = 'info') {
  console[level](event, { component: 'browser', time: new Date().toISOString(), ...fields });
}

/** Describe a failure by type, status, code and server request ID, never by message payloads. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: error === undefined ? undefined : typeof error };
  const fields: Record<string, unknown> = { errorType: error.name };
  if ('status' in error) fields.errorStatus = error.status;
  if ('body' in error && error.body && typeof error.body === 'object' && 'code' in error.body) fields.errorCode = error.body.code;
  if ('requestId' in error) fields.requestId = error.requestId;
  if ('type' in error) fields.errorKind = error.type;
  return fields;
}
