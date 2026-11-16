import { createEngine } from "./app.js";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), ".streamsnipe");
const docker = process.env.STREAMSNIPE_MODE === "docker";
let setupToken = process.env.SETUP_TOKEN;
if (docker && !setupToken) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "setup-token");
  if (!existsSync(file))
    writeFileSync(file, randomBytes(32).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  setupToken = readFileSync(file, "utf8").trim();
  console.log(`Docker pairing setup token is stored in ${file}`);
}
const engine = createEngine({
  dataDir,
  recordingsPath: process.env.RECORDINGS_PATH,
  dashboardPath: process.env.DASHBOARD_PATH,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 47821),
  mode: process.env.STREAMSNIPE_MODE === "docker" ? "docker" : "desktop",
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").filter(Boolean),
  setupToken,
  ytDlpPath: process.env.YT_DLP_PATH,
  ffmpegPath: process.env.FFMPEG_PATH,
  ffprobePath: process.env.FFPROBE_PATH,
  jsRuntimePath: process.env.JS_RUNTIME_PATH,
  jobRunnerPath: process.env.JOB_RUNNER_PATH,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  lockedFields: docker && process.env.RECORDINGS_PATH ? ["recordingsPath"] : [],
});
engine
  .start()
  .then((a) => console.log(`StreamSnipe listening on ${a.address}:${a.port}`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void engine.stop().then(() => process.exit(0));
  });
