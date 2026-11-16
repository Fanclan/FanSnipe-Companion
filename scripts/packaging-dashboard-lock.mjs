// Review the upstream artifact and its origin before committing this lock.
import { readdir, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [directory, archive] = process.argv.slice(2);
if (!directory || !archive) throw new Error('Usage: node scripts/packaging-dashboard-lock.mjs <dashboard-dir> <dashboard-tar.gz>');
const hash = data => createHash('sha256').update(data).digest('hex');
const files = {};
async function walk(dir, prefix = '') {
  for (const name of (await readdir(dir)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name, full = path.join(dir,name), stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error('Dashboard symlink forbidden');
    if (stat.isDirectory()) await walk(full,rel);
    else if (stat.isFile()) files[rel] = hash(await readFile(full));
    else throw new Error('Unsupported dashboard entry');
  }
}
await walk(directory);
if (!files['index.html']) throw new Error('Dashboard index missing');
await writeFile(new URL('./packaging-dashboard.json',import.meta.url), JSON.stringify({protocolVersion:1,artifact:path.basename(archive),archiveSha256:hash(await readFile(archive)),files},null,2)+'\n');
