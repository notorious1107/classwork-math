import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';

export async function withLearning(run, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-learning-')), dbPath = join(dir, 'test.sqlite');
  if (seed) await seed(dbPath);
  let app, now = Date.parse('2026-11-24T10:00:00Z');
  const start = async () => {
    app = await createApp({ dbPath, clock: () => now });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  const request = async (path, cookie, method = 'GET', data) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, password = 'Teacher123!') => { const r = await request('/login', null, 'POST', { username, password }); assert.equal(r.status, 200); return r.cookie; };
  await start();
  try { await run({ request, login, db: () => app.db, now: value => { now = value; }, port: () => app.server.address().port, restart: async () => { await stop(); await start(); } }); }
  finally { await stop(); await rm(dir, { recursive: true, force: true }); }
}
