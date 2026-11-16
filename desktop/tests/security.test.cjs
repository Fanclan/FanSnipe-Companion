const test = require('node:test');
const assert = require('node:assert/strict');
const { isDashboardUrl, validateManifest } = require('../security.cjs');
test('only the configured loopback dashboard origin can navigate', () => {
  assert.equal(isDashboardUrl('http://127.0.0.1:47821/app/', 47821), true);
  for (const url of ['http://localhost:47821/app/', 'http://127.0.0.1:47822/', 'https://127.0.0.1:47821/', 'http://evil.test/', 'file:///tmp/a']) assert.equal(isDashboardUrl(url, 47821), false);
});
test('manifest rejects missing and unsafe paths', () => {
  assert.throws(() => validateManifest({files: []}));
  assert.throws(() => validateManifest({files:[{path:'../escape',sha256:'a'.repeat(64)}]}));
  assert.doesNotThrow(() => validateManifest({files:[{path:'dashboard/index.html',sha256:'a'.repeat(64)}]}));
});
test('resource verification detects a modified bundled tool', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
  const { verifyResources } = require('../security.cjs'); const dir = fs.mkdtempSync(path.join(os.tmpdir(),'streamsnipe-test-'));
  try {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const names = ['dashboard/index.html', ...['yt-dlp','ffmpeg','ffprobe','deno'].map(n => `tools/${n}${suffix}`)];
    const files = names.map(name => { const full = path.join(dir,name); fs.mkdirSync(path.dirname(full),{recursive:true}); fs.writeFileSync(full,'trusted'); return {path:name,sha256:crypto.createHash('sha256').update('trusted').digest('hex')}; });
    fs.writeFileSync(path.join(dir,'integrity.json'),JSON.stringify({files})); verifyResources(dir);
    fs.writeFileSync(path.join(dir,names[1]),'modified'); assert.throws(() => verifyResources(dir), /integrity failure/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
