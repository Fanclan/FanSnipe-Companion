const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOutput } = require('../../scripts/packaging-ffmpeg-validation.cjs');
test('rejects nonredistributable and GPL FFmpeg builds', () => {
  for (const configuration of ['--enable-nonfree', '--enable-gpl', '--enable-version3']) assert.throws(() => validateOutput('GNU Lesser General Public License', `configuration: ${configuration}`, ' https\n'));
  assert.throws(() => validateOutput('This version has nonfree parts and is not redistributable', 'configuration:', ' https\n'));
});
test('requires LGPL and HTTPS support', () => {
  assert.throws(() => validateOutput('GNU Lesser General Public License', 'configuration:', ' http\n'));
  assert.doesNotThrow(() => validateOutput('GNU Lesser General Public\nLicense', 'configuration: --enable-gnutls', ' https\n'));
});
