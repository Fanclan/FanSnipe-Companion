// Stage only reviewed, hash-pinned inputs. The lock is maintained by the release operator.
import { readFile, mkdir, cp, rm, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { verify } = createRequire(import.meta.url)('./packaging-ffmpeg-validation.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = process.argv[2];
if (!lockPath) throw new Error('Usage: node scripts/packaging-stage.mjs <reviewed-inputs.json>');
const lock = JSON.parse(await readFile(lockPath,'utf8'));
if (lock.protocolVersion !== 1 || !lock.dashboardDir || !Array.isArray(lock.files)) throw new Error('Invalid input lock');
const required = ['yt-dlp','ffmpeg','ffprobe'];
if (!lock.files.some(f => f.destination === 'archive/deno')) throw new Error('Standalone Deno runtime required');
const executable = lock.target?.startsWith('win32-') ? '.exe' : '';
for (const name of required) if (!lock.files.some(f => f.destination === `tools/${name}${executable}`)) throw new Error(`Missing ${name}`);
if (!lock.files.some(f => f.destination.startsWith('licenses/'))) throw new Error('License attribution required');
if (executable && !lock.files.some(f => f.destination === 'tools/FanSnipe.JobRunner.exe')) throw new Error('Windows containment helper required');
const stage = path.join(root,'staging'); await rm(stage,{recursive:true,force:true}); await mkdir(stage,{recursive:true});
const manifest = [];
async function add(source, destination, expected) {
  if (!/^(tools|licenses|dashboard)\/[A-Za-z0-9._/-]+$/.test(destination) || destination.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid destination or digest: ${destination}`);
  const data = await readFile(source); const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`Digest mismatch: ${destination}`);
  const out = path.join(stage,destination); await mkdir(path.dirname(out),{recursive:true}); await writeFile(out,data,{mode:destination.startsWith('tools/') ? 0o755 : 0o644}); manifest.push({path:destination,sha256:actual});
}
for (const item of lock.files) {
  let source = item.source;
  if (source.startsWith('https://')) { const response = await fetch(source); if (!response.ok || !response.url.startsWith('https://')) throw new Error(`Download failed ${source}: ${response.status}`); const tmp = path.join(stage, '.download'); await writeFile(tmp,Buffer.from(await response.arrayBuffer())); source=tmp; }
  if (item.destination === 'archive/deno') {
    const archive = await readFile(source);
    if (createHash('sha256').update(archive).digest('hex') !== item.sha256) throw new Error('Deno archive digest mismatch');
    const entry = item.windows ? 'deno.exe' : 'deno';
    // Git Bash tar interprets a Windows drive prefix as a remote host. Read the
    // verified ZIP entry directly, without depending on the runner's tar variant.
    const data = process.platform === 'win32'
      ? execFileSync('python3', ['-c', 'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', source, entry], {maxBuffer: 250 * 1024 * 1024})
      : execFileSync('unzip', ['-p', source, entry], {maxBuffer: 250 * 1024 * 1024});
    const dest = `tools/${entry}`; const out = path.join(stage,dest); await mkdir(path.dirname(out),{recursive:true}); await writeFile(out,data,{mode:0o755});
    manifest.push({path:dest,sha256:createHash('sha256').update(data).digest('hex')});
  } else await add(source,item.destination,item.sha256);
}
verify(path.join(stage,`tools/ffmpeg${executable}`));
verify(path.join(stage,`tools/ffprobe${executable}`));
// The dashboard lock must enumerate every file, preventing unreviewed scripts entering the bundle.
async function walk(dir, prefix='') { let all=[]; for (const name of await readdir(dir)) { const rel=prefix ? `${prefix}/${name}` : name; const abs=path.join(dir,name); const stat=await lstat(abs); if (stat.isSymbolicLink()) throw new Error('Dashboard symlinks forbidden'); if (stat.isDirectory()) all.push(...await walk(abs,rel)); else if (stat.isFile()) all.push(rel); else throw new Error('Unsupported dashboard file'); } return all; }
const dashboardFiles = await walk(lock.dashboardDir);
if (!dashboardFiles.includes('index.html')) throw new Error('Dashboard index missing');
if (!lock.dashboardHashes || Object.keys(lock.dashboardHashes).length !== dashboardFiles.length) throw new Error('Dashboard hash list incomplete');
for (const rel of dashboardFiles) await add(path.join(lock.dashboardDir,rel),`dashboard/${rel}`,lock.dashboardHashes[rel]);
await rm(path.join(stage,'.download'),{force:true});
await mkdir(path.join(stage,'engine'),{recursive:true});
await cp(path.join(root,'dist'),path.join(stage,'engine/dist'),{recursive:true});
await cp(path.join(root,'node_modules'),path.join(stage,'engine/node_modules'),{recursive:true});
await cp(path.join(root,'package.json'),path.join(stage,'engine/package.json'));
await cp(path.join(root,'package-lock.json'),path.join(stage,'engine/package-lock.json'));
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prune','--omit=dev','--ignore-scripts','--offline','--no-audit','--no-fund'], {cwd:path.join(stage,'engine'),stdio:'inherit',shell:process.platform === 'win32'});
await writeFile(path.join(stage,'integrity.json'),JSON.stringify({protocolVersion:1,files:manifest.sort((a,b)=>a.path.localeCompare(b.path))},null,2)+'\n');
