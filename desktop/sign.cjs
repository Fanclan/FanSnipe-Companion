const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {validateManifest,verifyResources} = require('./security.cjs');
function signResources(resources, identity, keychain, timestamp = true) {
  if (!identity) throw new Error('A signing identity is required');
  const manifestPath=path.join(resources,'integrity.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')); validateManifest(manifest);
  for (const entry of manifest.files.filter(e=>e.path.startsWith('tools/'))) {
    const filename=path.join(resources,entry.path);
    const args=['--force','--sign',identity,'--options','runtime',timestamp?'--timestamp':'--timestamp=none'];
    if(keychain) args.push('--keychain',keychain);
    execFileSync('/usr/bin/codesign',[...args,filename],{stdio:'pipe'});
    execFileSync('/usr/bin/codesign',['--verify','--strict',filename],{stdio:'pipe'});
    entry.sha256=crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  }
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
}
async function sign(options) {
  if (!options.identity) throw new Error('No valid signing identity available');
  const resources=path.join(options.app,'Contents','Resources');
  verifyResources(resources);
  signResources(resources,options.identity,options.keychain);
  verifyResources(resources);
  const prior=options.ignore;
  const tools=path.join(resources,'tools')+path.sep;
  await require('@electron/osx-sign').signAsync({...options,ignore:file=>file.startsWith(tools)||(prior && prior(file))});
  verifyResources(resources);
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',options.app],{stdio:'inherit'});
}
module.exports=sign;
module.exports.signResources=signResources;
