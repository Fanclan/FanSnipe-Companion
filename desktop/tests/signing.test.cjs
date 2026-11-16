const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
test('hashes the final signed resource bytes before sealing', {skip:process.platform!=='darwin'}, () => {
  const {signResources}=require('../sign.cjs'); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'streamsnipe-sign-'));
  try { fs.mkdirSync(path.join(dir,'tools')); fs.copyFileSync('/usr/bin/true',path.join(dir,'tools','tool')); const sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'tools','tool'))).digest('hex');fs.writeFileSync(path.join(dir,'integrity.json'),JSON.stringify({files:[{path:'tools/tool',sha256:sha}]})); signResources(dir,'-',undefined,false); const entry=JSON.parse(fs.readFileSync(path.join(dir,'integrity.json'))).files[0]; assert.equal(entry.sha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'tools','tool'))).digest('hex')); } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
