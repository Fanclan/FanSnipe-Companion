// Run only on Windows, against the exact staged helper and tools.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
if(process.platform!=='win32') throw Error('Windows is required');
const helper=path.resolve('staging/tools/StreamSnipe.JobRunner.exe');
const ffprobe=path.resolve('staging/tools/ffprobe.exe');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const probe=await new Promise((resolve,reject)=>{const p=spawn(helper,[String(process.pid),ffprobe,'-version']);let out='';p.stdout.on('data',b=>out+=b);p.on('error',reject);p.on('close',code=>resolve({code,out}));});
  if(probe.code!==0||!probe.out.includes('ffprobe version'))throw Error('JobRunner did not forward ffprobe output');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'streamsnipe-job-'));const mark=path.join(dir,'leaked');
  try {
    const code=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(mark)},'leak'),3000);setInterval(()=>{},1000)`;
    const runner=spawn(helper,[String(process.pid),process.execPath,'-e',code],{stdio:['pipe','ignore','inherit']});
    await delay(700); runner.stdin.write('stop\n');
    await new Promise((resolve,reject)=>{runner.on('close',resolve);runner.on('error',reject);});
    await delay(3500); if(fs.existsSync(mark))throw Error('JobRunner did not terminate its child on stop');
    const parentScript=`const {spawn}=require('child_process');spawn(${JSON.stringify(helper)},[String(process.pid),process.execPath,'-e',${JSON.stringify(code)}],{stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),700)`;
    const parent=spawnSync(process.execPath,['-e',parentScript],{stdio:'inherit',timeout:10000});
    if(parent.status!==0)throw Error('JobRunner parent fixture failed');
    await delay(3500);if(fs.existsSync(mark))throw Error('JobRunner did not contain child after parent exit');
    console.log('Windows helper output, stop and parent-exit smoke passed');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
