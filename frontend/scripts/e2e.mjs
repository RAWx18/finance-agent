// SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.cache'), { recursive: true });
const data = await mkdtemp(path.join(root, '.cache', 'browser-'));
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const backend = path.resolve(root, '../backend');
const server = spawn('uv', ['run', '--project', backend, '--locked', 'uvicorn', 'tests.auth_support:browser_app', '--factory', '--app-dir', backend, '--host', '127.0.0.1', '--port', String(port), '--no-proxy-headers', '--no-access-log', '--timeout-graceful-shutdown', '10'], {
  cwd: backend, env: { ...process.env, PUBLIC_ORIGIN: origin, DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
});
let runner;
function stop() { runner?.kill('SIGTERM'); server.kill('SIGTERM'); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated test backend did not start')), 30000);
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Backend exited ${code}`)); });
    server.stderr.on('data', (chunk) => {
      if (chunk.toString().includes('Uvicorn running on')) { clearTimeout(timer); resolve(); }
    });
  });
  console.log(`Isolated authenticated backend ready at ${origin}; storage and Google identity are synthetic.`);
  if (process.argv.includes('--serve')) {
    console.log(`Isolated storage: ${data}`);
    await once(server, 'exit');
  } else {
    runner = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], {
      cwd: root, env: { ...process.env, E2E_BASE_URL: origin, E2E_DATA_DIR: data }, stdio: 'inherit',
    });
    const [code] = await once(runner, 'exit');
    process.exitCode = code ?? 1;
  }
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
  await rm(data, { recursive: true, force: true });
  console.log('Isolated backend stopped; synthetic storage removed.');
}