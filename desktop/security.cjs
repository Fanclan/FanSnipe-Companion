const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
function isDashboardUrl(value, port) {
  try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(port) && !u.username && !u.password; } catch { return false; }
}
function validateManifest(manifest) {
  if (!Array.isArray(manifest?.files) || !manifest.files.length) throw new Error('Empty integrity manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || path.posix.isAbsolute(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) throw new Error('Invalid integrity manifest entry');
    seen.add(file.path);
  }
}
function verifyResources(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'integrity.json'), 'utf8'));
  validateManifest(manifest);
  const entries = new Map(manifest.files.map(f => [f.path, f.sha256]));
  for (const required of ['dashboard/index.html', `tools/yt-dlp${process.platform === 'win32' ? '.exe' : ''}`, `tools/ffmpeg${process.platform === 'win32' ? '.exe' : ''}`, `tools/ffprobe${process.platform === 'win32' ? '.exe' : ''}`, `tools/deno${process.platform === 'win32' ? '.exe' : ''}`]) if (!entries.has(required)) throw new Error(`Missing required resource: ${required}`);
  if (process.platform === 'win32' && !entries.has('tools/FanSnipe.JobRunner.exe')) throw new Error('Missing Windows containment helper');
  for (const [rel, expected] of entries) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    if (actual !== expected) throw new Error(`Resource integrity failure: ${rel}`);
  }
}
function parseTestEnvironment(env) {
  const origin=env.FANSNIPE_TEST_FIXTURE_ORIGIN || env.STREAMSNIPE_TEST_FIXTURE_ORIGIN, dataDir=env.FANSNIPE_TEST_DATA_DIR || env.STREAMSNIPE_TEST_DATA_DIR;
  if (!origin && !dataDir) return null;
  if (!origin || !dataDir || !path.isAbsolute(dataDir) || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(origin)) throw new Error('Invalid isolated test environment');
  const parsed = new URL(origin);
  if (parsed.origin !== origin || Number(parsed.port) < 1 || Number(parsed.port) > 65535) throw new Error('Invalid isolated test origin');
  return {origin,dataDir};
}
module.exports = { isDashboardUrl, validateManifest, verifyResources, parseTestEnvironment };
