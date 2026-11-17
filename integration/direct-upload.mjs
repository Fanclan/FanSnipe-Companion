import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../dist/app.js';

// A real AWS SDK transfer to a disposable S3-compatible sink. No real credentials or media.
const work = await mkdtemp(path.join(tmpdir(), 'fansnipe-direct-upload-'));
const mediaRoot = path.join(work, 'original-media');
await mkdir(mediaRoot);
const media = path.join(mediaRoot, 'fixture.mp4');
const generated = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
  '-t', '2', '-c:v', 'mpeg4', '-y', media,
], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const original = await readFile(media);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const legacyPath = path.join(work, 'legacy.db');
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`CREATE TABLE channels (id TEXT, name TEXT, url TEXT);
  CREATE TABLE recordings (id TEXT, url TEXT, title TEXT, status TEXT, file_path TEXT, format TEXT);`);
legacy.prepare('INSERT INTO recordings VALUES(?,?,?,?,?,?)').run(
  'upload-fixture', 'https://www.youtube.com/watch?v=synthetic', 'Synthetic upload fixture', 'completed', media, 'mp4',
);
legacy.close();
const legacyHash = sha256(await readFile(legacyPath));
const received = [];
const sink = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({ method: req.method, path: req.url, host: req.headers.host,
    contentType: req.headers['content-type'], authorization: req.headers.authorization,
    bytes: Buffer.concat(chunks) });
  res.writeHead(200, { ETag: '"synthetic-test-object"', 'Content-Type': 'application/xml' });
  res.end('');
});
await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${sink.address().port}`;
let engine;
const report = { status: 'running', startedAt: new Date().toISOString(), platform: process.platform,
  engineSha256: sha256(await readFile(new URL('../dist/app.js', import.meta.url))) };
try {
  engine = createEngine({ dataDir: path.join(work, 'data'), recordingsPath: path.join(work, 'recordings'), port: 0, monitor: false,
    jobRunnerPath: process.env.JOB_RUNNER_PATH });
  const address = await engine.start();
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  let token;
  async function request(route, method = 'GET', body, expected = 200, extra = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  }
  const pairing = await request('/pairings', 'POST', { name: 'Synthetic upload validation' }, 201);
  engine.auth.approve(pairing.id);
  token = (await request(`/pairings/${pairing.id}`, 'GET', undefined, 200,
    { 'X-Pairing-Token': pairing.pollToken })).token;
  assert.ok(token);
  const imported = engine.local.importLegacy(legacyPath, mediaRoot);
  assert.equal(imported.recordings, 1);
  const record = (await request('/recordings')).find(row => row.title === 'Synthetic upload fixture');
  assert.ok(record);
  const destination = { s3Enabled: true, s3Bucket: 'synthetic-user-owned-bucket', s3Region: 'us-east-1', s3Endpoint: endpoint };
  await request('/settings', 'PUT', destination, 403);
  const approval = await request('/settings/s3-approvals', 'POST', destination, 201);
  const pending = engine.local.listUploadApprovals().find(row => row.id === approval.id);
  assert.deepEqual(pending.destination, destination);
  assert.equal(engine.local.resolveUploadApproval(approval.id, true), true);
  const approved = await request(`/settings/s3-approvals/${approval.id}`);
  assert.equal(approved.status, 'approved');
  const key = 'SYNTHETIC_ONLY_ACCESS_KEY';
  const secret = 'synthetic-only-secret-not-a-real-credential';
  await request('/settings', 'PUT', { ...destination, uploadDestinationApproval: approved.approvalToken,
    s3AccessKeyId: key, s3SecretAccessKey: secret });
  const settings = await request('/settings');
  assert.equal(settings.hasS3Credentials, true);
  assert.ok(!JSON.stringify(settings).includes(key));
  assert.ok(!JSON.stringify(settings).includes(secret));
  const forbiddenDestinations = ['https://fanclan.io', 'https://fansnipe.com', 'https://media.fansnipe.com.', 'https://streamsnipe-portal.vercel.app', 'https://vercel.com'];
  for (const forbidden of forbiddenDestinations) {
    await request('/settings', 'PUT', { s3Endpoint: forbidden }, 422);
  }
  const upload = await request(`/recordings/${record.id}/upload`, 'POST', {});
  assert.equal(upload.uploadedToCloud, true);
  assert.equal(received.length, 1, 'Expected exactly one direct upload');
  const transfer = received[0];
  assert.equal(transfer.method, 'PUT');
  assert.equal(transfer.host, new URL(endpoint).host);
  assert.ok(transfer.path.startsWith('/synthetic-user-owned-bucket/recordings/'));
  assert.ok(transfer.authorization.includes(key), 'Synthetic credentials must reach only the configured sink');
  assert.equal(sha256(transfer.bytes), sha256(original), 'Direct upload must contain the exact local media bytes');
  const completed = await request(`/recordings/${record.id}`);
  assert.equal(completed.uploadedToCloud, true);
  assert.equal(completed.uploadState, 'completed');
  const ticket = await request(`/recordings/${record.id}/media-ticket`, 'POST', { kind: 'download' });
  const ticketUrl = new URL(ticket.url, base);
  assert.equal(ticketUrl.origin, new URL(base).origin);
  const download = await fetch(ticketUrl);
  assert.ok(download.ok);
  assert.equal(sha256(Buffer.from(await download.arrayBuffer())), sha256(original));
  assert.equal(sha256(await readFile(legacyPath)), legacyHash, 'Legacy database must remain unchanged');
  assert.equal(sha256(await readFile(media)), sha256(original), 'Legacy media must remain unchanged');
  report.status = 'passed';
  report.directTransfers = received.length;
  report.bytes = original.length;
  report.mediaSha256 = sha256(original);
  report.localDownloadMatched = true;
  report.legacySourceUnchanged = true;
  report.forbiddenDestinationsRejected = forbiddenDestinations.length;
  console.log(JSON.stringify({ ...report, reportPath: path.join(work, 'report.json') }));
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
  console.error(report.error);
} finally {
  await engine?.stop();
  sink.closeAllConnections();
  await new Promise(resolve => sink.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2));
}
