// Combine pinned upstream tools with FFmpeg and Windows helper built in this job.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [target, dashboardDir, output] = process.argv.slice(2);
if (!target || !dashboardDir || !output) throw new Error('Usage: node scripts/packaging-inputs.mjs <platform-arch> <dashboard-dir> <output>');
const tools = JSON.parse(await readFile(new URL('./packaging-tools.json',import.meta.url)));
const dashboard = JSON.parse(await readFile(new URL('./packaging-dashboard.json',import.meta.url)));
if (!tools.targets[target]) throw new Error(`Unsupported target ${target}`);
const suffix=target.startsWith('win32-')?'.exe':'';
const built=path.resolve('build','ffmpeg',target);
const entries = [[`ffmpeg${suffix}`,`tools/ffmpeg${suffix}`],[`ffprobe${suffix}`,`tools/ffprobe${suffix}`],['LICENSE.LGPLv2.1','licenses/ffmpeg.LICENSE'],['ffmpeg-source.tar.xz','licenses/ffmpeg-source.tar.xz'],['build-ffmpeg.sh','licenses/build-ffmpeg.sh']];
const files=[...tools.targets[target]];
for (const [file,destination] of entries) {const source=path.join(built,file),data=await readFile(source),sha256=createHash('sha256').update(data).digest('hex'); if(file==='ffmpeg-source.tar.xz'&&sha256!=='8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e')throw Error('FFmpeg source mismatch'); files.push({source,destination,sha256});}
if (suffix) {const source=path.resolve('build/windows/FanSnipe.JobRunner.exe'),data=await readFile(source); files.push({source,destination:'tools/FanSnipe.JobRunner.exe',sha256:createHash('sha256').update(data).digest('hex')});}
await writeFile(output,JSON.stringify({protocolVersion:1,target,dashboardDir,dashboardHashes:dashboard.files,files},null,2));
