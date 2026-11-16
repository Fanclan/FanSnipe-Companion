const { execFileSync } = require('node:child_process');
function validateOutput(license, configuration, protocols) {
  if (!/GNU\s+Lesser\s+General\s+Public\s+License/i.test(license) || /nonfree|not redistributable/i.test(license)) throw new Error('FFmpeg must report a redistributable LGPL license');
  if (/--enable-(?:nonfree|gpl|version3)(?:\s|$)/.test(configuration)) throw new Error('Forbidden FFmpeg configuration');
  if (!/^\s*https\s*$/m.test(protocols)) throw new Error('FFmpeg HTTPS protocol is missing');
}
function verify(binary) {
  const run = arg => execFileSync(binary,[arg],{encoding:'utf8', maxBuffer:10*1024*1024, stdio:['ignore','pipe','pipe']});
  validateOutput(run('-L'),run('-buildconf'),run('-protocols'));
}
module.exports = {validateOutput,verify};
if (require.main === module) for (const binary of process.argv.slice(2)) {verify(binary); process.stdout.write(`Verified ${binary}\n`);}
