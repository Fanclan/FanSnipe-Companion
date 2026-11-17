// Use disposable containers and generated pairing data; never touch user volumes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
if (!image) throw Error('Usage: node scripts/packaging-docker-smoke.mjs <image>');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hosted = 'https://fansnipe.com';
for (const enabled of [false, true]) {
  const name = `fansnipe-bridge-smoke-${randomUUID()}`;
  try {
    docker('run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::47821',
      '-e', `FANSNIPE_HOSTED_DASHBOARD=${enabled}`, image);
    const binding = docker('port', name, '47821/tcp');
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const base = `http://${binding}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(base + '/api/v1/info')).ok) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready, 'Packaged engine did not become ready');
    const api = (route, init = {}) => fetch(base + '/api/v1' + route, init);
    const info = await api('/info', { headers: { Origin: hosted } });
    assert.equal(info.status, enabled ? 200 : 403);
    if (!enabled) continue;
    assert.equal(info.headers.get('Access-Control-Allow-Origin'), hosted);
    assert.equal((await info.json()).mode, 'docker');
    assert.equal((await api('/info', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await api('/status', { headers: { Origin: hosted } })).status, 401);
    const setup = docker('exec', name, 'cat', '/data/setup-token');
    assert.ok(setup.length >= 32);
    const localHeaders = { Origin: base, 'X-Setup-Token': setup };
    const pairResponse = await api('/pairings', { method: 'POST', headers: { Origin: hosted, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Packaged bridge smoke' }) });
    assert.equal(pairResponse.status, 201);
    const pair = await pairResponse.json();
    const pendingPath = `/pairings/${pair.id}/pending`;
    assert.equal((await api(pendingPath, { headers: { Origin: hosted, 'X-Setup-Token': setup } })).status, 403);
    assert.equal((await api(pendingPath, { headers: { Origin: base, 'X-Setup-Token': 'wrong' } })).status, 403);
    const pendingResponse = await api(pendingPath, { headers: localHeaders });
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    assert.equal(pending.code, pair.code);
    assert.equal(pending.origin, hosted);
    assert.equal(pending.pollToken, undefined);
    assert.equal(pending.token, undefined);
    const approvalPath = `/pairings/${pair.id}/approve`;
    assert.equal((await api(approvalPath, { method: 'POST', headers: { Origin: hosted, 'X-Setup-Token': setup } })).status, 403);
    assert.equal((await api(approvalPath, { method: 'POST', headers: localHeaders })).status, 200);
    const poll = await api(`/pairings/${pair.id}`, { headers: { Origin: hosted, 'X-Pairing-Token': pair.pollToken } });
    assert.equal(poll.status, 200);
    const session = await poll.json();
    assert.equal(session.status, 'approved');
    assert.ok(session.token);
    assert.equal((await api('/status', { headers: { Origin: hosted, Authorization: `Bearer ${session.token}` } })).status, 200);
    const html = await (await fetch(base + '/app/')).text();
    assert.match(html, /name="fansnipe-transport" content="local"/);
    assert.match(html, /FanSnipe/);
    // Verify the shipped dashboard and tools match the release integrity manifest.
    docker('exec', name, 'node', '-e', "const fs=require('fs'),c=require('crypto');if(process.getuid()===0)throw Error('Root user');if((fs.statSync('/data/setup-token').mode&0o777)!==0o600)throw Error('Token permissions');for(const f of JSON.parse(fs.readFileSync('integrity.json')).files){if(c.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw Error('Integrity mismatch: '+f.path)}");
    docker('exec', name, '/opt/fansnipe/tools/yt-dlp', '--version');
    docker('exec', name, '/opt/fansnipe/tools/deno', '--version');
    const license = docker('exec', name, '/opt/fansnipe/tools/ffmpeg', '-L');
    assert.match(license, /Lesser General Public/);
    const protocols = docker('exec', name, '/opt/fansnipe/tools/ffmpeg', '-protocols');
    assert.match(protocols, /^\s*https\s*$/m);
  } finally {
    try { docker('stop', '--time', '30', name); } catch {}
  }
}
console.log('Packaged Docker bridge: default isolation, explicit opt-in, local approval, authentication, dashboard integrity and media tools passed.');
