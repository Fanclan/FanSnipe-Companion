import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../dist/app.js';

// A real elapsed-time test. Short runs are smoke tests and cannot satisfy the release soak gate.
const seconds = Number(process.env.SOAK_SECONDS ?? 8 * 60 * 60);
assert.ok(Number.isFinite(seconds) && seconds >= 10, 'SOAK_SECONDS must be at least 10');
const work = process.env.SOAK_DIRECTORY ?? await mkdtemp(path.join(tmpdir(), 'streamsnipe-soak-'));
const source = path.join(work, 'source');
const recordingsPath = path.join(work, 'recordings');
mkdirSync(source, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const enginePath = fileURLToPath(new URL('../dist/app.js', import.meta.url));
const report = {
  kind: seconds >= 28800 ? 'release-soak' : 'smoke',
  startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.version, plannedSeconds: seconds,
  engineSha256: createHash('sha256').update(readFileSync(enginePath)).digest('hex'),
  status: 'running', samples: [], recordings: [], media: [],
};
const reportPath = path.join(work, 'report.json');
const persist = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
persist();
console.log(JSON.stringify({ event: 'started', reportPath, ...report, samples: undefined }));
const generator = spawn(ffmpeg, ['-hide_banner','-loglevel','error','-re','-f','lavfi','-i',
  'testsrc2=size=320x180:rate=15','-f','lavfi','-i','sine=frequency=1000:sample_rate=48000',
  '-c:v','mpeg2video','-b:v','400k','-g','30','-c:a','aac','-b:a','64k','-f','hls',
  '-hls_time','2','-hls_list_size','12','-hls_flags','delete_segments',path.join(source,'index.m3u8')],
  { stdio: ['ignore','ignore','pipe'] });
let sourceError = '';
generator.stderr.on('data', data => { sourceError = (sourceError + data.toString()).slice(-4000); });
const sourceServer = createServer((req,res) => {
  const name = path.basename(new URL(req.url, 'http://fixture').pathname);
  if (!/^(index\.m3u8|index\d+\.ts)$/.test(name)) { res.writeHead(404).end(); return; }
  const file = path.join(source, name);
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
let engine;
try {
  for (let i = 0; i < 200 && !existsSync(path.join(source,'index.m3u8')); i++) {
    assert.equal(generator.exitCode, null, sourceError); await delay(100);
  }
  assert.ok(existsSync(path.join(source,'index.m3u8')), `Source did not start: ${sourceError}`);
  await new Promise(resolve => sourceServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${sourceServer.address().port}`;
  engine = createEngine({dataDir:path.join(work,'data'),recordingsPath,port:0,monitor:false,
    ffmpegPath:ffmpeg,ffprobePath:ffprobe,jobRunnerPath:process.env.JOB_RUNNER_PATH,fixtureOrigins:[origin]});
  const address = await engine.start();
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  let token;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {method,headers:{'Content-Type':'application/json',
      ...(token ? {Authorization:`Bearer ${token}`} : {})},body:body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const pairing = await request('/pairings','POST',{name:'Synthetic soak harness'});
  engine.auth.approve(pairing.id);
  const paired = await fetch(base + '/pairings/' + pairing.id,{headers:{'X-Pairing-Token':pairing.pollToken}});
  token = (await paired.json()).token;
  assert.ok(token, 'Pairing did not issue a token');
  await request('/settings','PUT',{maxConcurrentRecordings:3,autoCleanupEnabled:false});
  for (let i=0;i<3;i++) {
    const url = `${origin}/stream-${i}/index.m3u8`;
    const channel = await request('/channels','POST',{name:`Synthetic stream ${i+1}`,url,autoRecord:false});
    const recording = await request('/recordings/start','POST',{url,channelId:channel.id,title:`Soak ${i+1}`,format:'mkv'});
    report.recordings.push({id:recording.id});
  }
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await delay(Math.min(30000, Math.max(1000, seconds * 1000 - (Date.now()-started))));
    assert.equal(generator.exitCode,null,`Fixture exited: ${sourceError}`);
    const rows = await Promise.all(report.recordings.map(r => request('/recordings/'+r.id)));
    for (const row of rows) assert.ok(['starting','recording'].includes(row.status),JSON.stringify(row));
    const sample = {elapsedSeconds:Math.round((Date.now()-started)/1000),rssBytes:process.memoryUsage().rss,
      statuses:rows.map(r=>r.status),sizes:rows.map(r=>r.fileSize)};
    report.samples.push(sample);persist();console.log(JSON.stringify({event:'sample',...sample}));
  }
  for (const r of report.recordings) await request('/recordings/'+r.id+'/stop','POST',{});
  for (let n=0;n<600;n++) {
    const rows = await Promise.all(report.recordings.map(r => request('/recordings/'+r.id)));
    if (rows.every(r=>['completed','interrupted','failed'].includes(r.status))) {
      report.recordings=rows;
      for(const row of rows){assert.equal(row.status,'completed',JSON.stringify(row));assert.ok(row.duration>0);assert.ok(row.fileSize>0)}
      break;
    }
    assert.ok(n<599,'Finalization timed out');await delay(100);
  }
  for (const name of readdirSync(recordingsPath).filter(n=>n.endsWith('.mkv'))) {
    const result=spawnSync(ffprobe,['-v','error','-show_format','-show_streams','-of','json',path.join(recordingsPath,name)],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const probed=JSON.parse(result.stdout);
    assert.ok(probed.format.format_name.includes('matroska'));
    assert.ok(probed.streams.some(stream => stream.codec_type === 'video'), 'Video stream was lost');
    assert.ok(probed.streams.some(stream => stream.codec_type === 'audio'), 'Audio stream was lost');
    assert.ok(Number(probed.format.duration)>=seconds*0.75,`Unexpected short output ${name}: ${probed.format.duration}`);
    report.media.push({name,duration:Number(probed.format.duration),format:probed.format.format_name,streams:probed.streams.length});
  }
  assert.equal(report.media.length,3,'Expected three independently finalized recordings');
  report.status='passed'; report.finishedAt=new Date().toISOString();persist();
  console.log(JSON.stringify({event:'passed',reportPath,kind:report.kind}));
} catch(error) {
  report.status='failed';report.error=String(error?.stack??error);report.finishedAt=new Date().toISOString();persist();
  console.error(report.error);process.exitCode=1;
} finally {
  await engine?.stop();generator.kill('SIGTERM');
  sourceServer.closeAllConnections();await new Promise(resolve=>sourceServer.close(()=>resolve()));
}
