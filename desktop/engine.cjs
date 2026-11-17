const path = require('node:path');
const { pathToFileURL } = require('node:url');
const config = require('./config.json');
let engine;
process.parentPort.on('message', async ({data}) => {
  try {
    if (data.type === 'start') {
      const { createEngine } = await import(pathToFileURL(path.join(data.resources, 'engine', 'dist', 'app.js')).href);
      const exe = process.platform === 'win32' ? '.exe' : '';
      engine = createEngine({ dataDir: data.dataDir, recordingsPath: data.recordingsPath, dashboardPath: path.join(data.resources, 'dashboard'), host: '127.0.0.1', port: 47821, mode: 'desktop', allowedOrigins: config.dashboardOrigins, fixtureOrigins: data.fixtureOrigin ? [data.fixtureOrigin] : [], ytDlpPath: path.join(data.resources, 'tools', `yt-dlp${exe}`), ffmpegPath: path.join(data.resources, 'tools', `ffmpeg${exe}`), ffprobePath: path.join(data.resources, 'tools', `ffprobe${exe}`), jsRuntimePath: path.join(data.resources, 'tools', `deno${exe}`), jobRunnerPath: process.platform === 'win32' ? path.join(data.resources, 'tools', 'FanSnipe.JobRunner.exe') : undefined });
      await engine.start();
      process.parentPort.postMessage({type:'ready'});
    } else if (data.type === 'pending') {
      process.parentPort.postMessage({type:'pending', pairings: await engine.auth.listPending()});
      process.parentPort.postMessage({type:'upload-approvals', approvals: await engine.local.listUploadApprovals()});
    } else if (data.type === 'resolve-upload-approval') {
      await engine.local.resolveUploadApproval(data.id, data.approved === true);
    } else if (data.type === 'approve') {
      await engine.auth.approve(data.id);
    } else if (data.type === 'folder') {
      await engine.local.setRecordingsPath(data.path);
    } else if (data.type === 'import') {
      process.parentPort.postMessage({type:'imported', data:await engine.local.importLegacy(data.path, data.mediaRoot)});
    } else if (data.type === 'diagnostics') {
      process.parentPort.postMessage({type:'diagnostics', data:await engine.local.diagnostics()});
    } else if (data.type === 'stop') {
      await engine?.stop();
      process.parentPort.postMessage({type:'stopped'});
      process.exit(0);
    }
  } catch (error) { process.parentPort.postMessage({type:'error', message: String(error?.message || error)}); }
});
