// Run only on Windows, against the exact staged helper and tools.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
if(process.platform!=='win32') throw Error('Windows is required');
const helper=path.resolve('staging/tools/FanSnipe.JobRunner.exe');
const ffprobe=path.resolve('staging/tools/ffprobe.exe');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fansnipe-job-'));const mark=path.join(dir,'leaked');const started=path.join(dir,'started');const lease=path.join(dir,'lease.sqlite');
  const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(lease);db.exec('CREATE TABLE gate(id INTEGER)');db.close();
  try {
    const probe=await new Promise((resolve,reject)=>{const p=spawn(helper,[String(process.pid),lease,ffprobe,'-version']);let out='';p.stdout.on('data',b=>out+=b);p.on('error',reject);p.on('close',code=>resolve({code,out}));});
    if(probe.code!==0||!probe.out.includes('ffprobe version'))throw Error('JobRunner did not forward ffprobe output');
    const code=`require('fs').writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(mark)},'leak'),7000);setInterval(()=>{},1000)`;
    const runner=spawn(helper,[String(process.pid),lease,process.execPath,'-e',code],{stdio:['pipe','ignore','inherit']});
    for(let i=0;i<50&&!fs.existsSync(started);i++) await delay(100);
    if(!fs.existsSync(started)) throw Error('JobRunner child never started');
    runner.stdin.write('stop\n');
    await new Promise((resolve,reject)=>{runner.on('close',resolve);runner.on('error',reject);});
    await delay(7500); if(fs.existsSync(mark))throw Error('JobRunner did not terminate its child on stop');
    fs.rmSync(started);
    const parentScript=`const {spawn}=require('child_process'),fs=require('fs');spawn(${JSON.stringify(helper)},[String(process.pid),${JSON.stringify(lease)},process.execPath,'-e',${JSON.stringify(code)}],{stdio:['pipe','ignore','ignore']}).unref();let n=0;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(started)})){clearInterval(t);process.exit(0)}if(++n>50)process.exit(1)},100)`;
    const parent=spawnSync(process.execPath,['-e',parentScript],{stdio:'inherit',timeout:10000});
    if(parent.status!==0)throw Error('JobRunner parent fixture failed');
    await delay(7500);if(fs.existsSync(mark))throw Error('JobRunner did not contain child after parent exit');
    console.log('Windows helper output, stop and parent-exit smoke passed');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
