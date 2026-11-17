const path = require('node:path');
const fs = require('node:fs');
function resolveDataPaths({appData, videos, env = process.env, exists = fs.existsSync}) {
  const current = path.join(appData, 'FanSnipe');
  const legacyCandidates = [path.join(appData, 'streamsnipe-desktop'), path.join(appData, 'StreamSnipe')];
  const legacyDir = !exists(path.join(current, 'engine.sqlite')) ? legacyCandidates.find(dir => exists(path.join(dir, 'engine.sqlite'))) : undefined;
  const legacy = Boolean(legacyDir);
  const legacyRecordings = path.join(videos, 'StreamSnipe');
  const recordingsPath = env.FANSNIPE_RECORDINGS_PATH || env.STREAMSNIPE_RECORDINGS_PATH || (legacy && exists(legacyRecordings) ? legacyRecordings : path.join(videos, 'FanSnipe'));
  return {dataDir: legacy ? legacyDir : current, recordingsPath, legacy};
}
module.exports = {resolveDataPaths};
