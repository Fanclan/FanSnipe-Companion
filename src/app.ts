import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  statfsSync,
  unlinkSync,
  createReadStream,
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  renameSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

type Obj = Record<string, any>;
export interface EngineOptions {
  dataDir: string;
  recordingsPath?: string;
  dashboardPath?: string;
  host?: string;
  port?: number;
  ytDlpPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  jsRuntimePath?: string;
  jobRunnerPath?: string;
  publicOrigin?: string;
  lockedFields?: string[];
  mode?: "desktop" | "docker";
  allowedOrigins?: string[];
  setupToken?: string;
  monitor?: boolean;
  fixtureOrigins?: string[];
  testFfmpegPrefixArgs?: string[];
  testYtDlpPrefixArgs?: string[];
}
const now = () => new Date().toISOString();
const token = () => randomBytes(32).toString("base64url");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const activeStates = [
  "queued",
  "starting",
  "recording",
  "stopping",
  "finalizing",
];
const qualities = ["best", "1080p", "720p", "480p", "360p"];
const formats = ["mp4", "mkv", "ts"];
const err = (res: Response, status: number, message: string) =>
  res.status(status).json({ error: message });
const size = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
const run = (bin: string, args: string[], timeout = 30000) =>
  new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const p = spawn(bin, args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let out = "";
    p.stdout?.on("data", (b) => {
      if (out.length < 1_000_000) out += b;
    });
    let force: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (p.stdin?.writable) p.stdin.write("stop\n");
      force = setTimeout(() => p.kill("SIGKILL"), 8000);
    }, timeout);
    p.once("error", (e) => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      reject(e);
    });
    p.once("close", (code) => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      resolve({ code, stdout: out });
    });
  });
export function createEngine(options: EngineOptions) {
  const host = options.host ?? "127.0.0.1",
    port = options.port ?? 47821,
    mode = options.mode ?? "desktop";
  if (mode === "desktop" && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("Desktop must bind loopback");
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(options.dataDir, 0o700);
  } catch {}
  const canonicalDataDir = realpathSync(options.dataDir);
  const lease = new DatabaseSync(
    path.join(canonicalDataDir, ".catalog-lease.sqlite"),
  );
  try {
    lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lease.close();
    throw new Error("Recording catalog is already in use");
  }
  const db = new DatabaseSync(path.join(canonicalDataDir, "engine.sqlite"));
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as Obj).user_version,
  );
  const existingTables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Obj[];
  if (version > 1 || (version === 0 && existingTables.length > 0)) {
    db.close();
    lease.exec("ROLLBACK");
    lease.close();
    throw new Error("Unsupported catalog version; catalog was not modified");
  }
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL); PRAGMA user_version=1; COMMIT;",
  );
  const get = (table: string, id: string): Obj | undefined => {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as
      Obj | undefined;
    return row ? JSON.parse(row.data) : undefined;
  };
  const all = (table: string): Obj[] =>
    (db.prepare(`SELECT data FROM ${table}`).all() as Obj[]).map((r) =>
      JSON.parse(r.data),
    );
  const put = (table: string, obj: Obj) =>
    db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(obj.id, JSON.stringify(obj));
  const del = (table: string, id: string) =>
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  const defaults = {
    recordingsPath:
      options.recordingsPath ?? path.join(options.dataDir, "recordings"),
    defaultQuality: "best",
    defaultFormat: "mp4",
    monitorIntervalSeconds: 60,
    maxConcurrentRecordings: 3,
    maxDiskUsagePercent: 90,
    autoCleanupEnabled: false,
    autoCleanupDays: 30,
    s3Enabled: false,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
  };
  const lockedFields = options.lockedFields ?? [];
  let settings: Obj = {
    ...defaults,
    ...JSON.parse(
      (
        db.prepare("SELECT value FROM meta WHERE key='settings'").get() as
          Obj | undefined
      )?.value ?? "{}",
    ),
  };
  for (const field of lockedFields)
    if (field in defaults) settings[field] = (defaults as Obj)[field];
  const secretsPath = path.join(options.dataDir, "secrets.json");
  let secrets: Obj = {};
  try {
    secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  } catch {}
  const saveSettings = () =>
    db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(settings));
  const publicSettings = () => ({
    ...settings,
    hasS3Credentials: !!(secrets.s3AccessKeyId && secrets.s3SecretAccessKey),
    lockedFields,
  });
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const authenticated = new Map<WebSocket, string>();
  const mediaResponses = new Map<Response, string>();
  const closeSession = (id: string) => {
    for (const [response, sessionId] of mediaResponses)
      if (sessionId === id) response.destroy();
    for (const [key, t] of tickets) if (t.sessionId === id) tickets.delete(key);
    for (const [ws, sessionId] of authenticated)
      if (sessionId === id) ws.close(1008, "Session revoked");
  };
  const broadcast = (type: string, data: Obj) => {
    const msg = JSON.stringify({ type, data });
    for (const [ws, id] of authenticated) {
      const valid = db
        .prepare("SELECT id FROM sessions WHERE id=? AND expires_at>?")
        .get(id, now());
      if (!valid) {
        ws.close(1008, "Session expired");
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };
  const clients = new Map<string, Obj>(),
    tickets = new Map<string, Obj>(),
    uploads = new Map<string, Upload>(),
    uploadDone = new Map<string, Promise<void>>(),
    processes = new Map<
      string,
      {
        child: ChildProcess;
        done: Promise<void>;
        stop: boolean;
        forced?: boolean;
        stopPromise?: Promise<Obj>;
        reason?: string;
      }
    >();
  let monitorTimer: NodeJS.Timeout | undefined,
    healthTimer: NodeJS.Timeout | undefined,
    monitoring = false,
    stopping = false,
    started = false;
  const publicOrigin = options.publicOrigin
    ? new URL(options.publicOrigin).origin
    : undefined;
  if (
    mode === "docker" &&
    options.publicOrigin &&
    options.publicOrigin !== publicOrigin
  )
    throw Error("PUBLIC_ORIGIN must be an exact origin");
  const safeOrigin = (origin: string | undefined, requestHost?: string) =>
    !origin ||
    (mode === "docker"
      ? publicOrigin
        ? origin === publicOrigin
        : !!requestHost && origin === `http://${requestHost}`
      : (options.allowedOrigins ?? []).includes(origin) ||
        (!!requestHost &&
          origin === `http://${requestHost}` &&
          /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(requestHost)));
  const validHost = (requestHost: string) =>
    mode !== "docker" ||
    !publicOrigin ||
    requestHost === new URL(publicOrigin).host;
  app.use((req, res, next) => {
    const h = req.headers.host ?? "";
    const hostname = h.startsWith("[")
      ? h.slice(1, h.indexOf("]"))
      : h.split(":")[0];
    if (!validHost(h)) return err(res, 403, "Invalid Host");
    if (
      mode === "desktop" &&
      !["127.0.0.1", "localhost", "::1"].includes(hostname)
    )
      return err(res, 403, "Invalid Host");
    const origin = req.headers.origin;
    if (!safeOrigin(origin, req.headers.host))
      return err(res, 403, "Origin denied");
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Pairing-Token, X-Setup-Token",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) =>
    stopping ? err(res, 503, "Engine is shutting down") : next(),
  );
  const api = express.Router();
  app.use("/api/v1", api);
  api.get("/info", (_req, res) =>
    res.json({
      name: "StreamSnipe",
      version: "0.1.0",
      protocolVersion: 1,
      mode,
    }),
  );
  const rate = new Map<string, number[]>();
  api.post("/pairings", (req, res) => {
    const ip = req.ip ?? "";
    for (const [key, p] of clients)
      if (Date.parse(p.expiresAt) <= Date.now()) clients.delete(key);
    for (const [key, times] of rate)
      if (!times.some((t) => Date.now() - t < 120000)) rate.delete(key);
    if (clients.size >= 100 || (rate.size >= 1000 && !rate.has(ip)))
      return err(res, 429, "Too many pairing requests");
    const times = (rate.get(ip) ?? []).filter((t) => Date.now() - t < 120000);
    if (times.length >= 10) return err(res, 429, "Too many pairing requests");
    times.push(Date.now());
    rate.set(ip, times);
    if (
      typeof req.body?.name !== "string" ||
      !req.body.name.trim() ||
      req.body.name.length > 100
    )
      return err(res, 422, "Invalid name");
    const id = randomUUID(),
      pollToken = token(),
      code = String(randomBytes(4).readUInt32BE() % 1000000).padStart(6, "0"),
      expiresAt = new Date(Date.now() + 120000).toISOString();
    clients.set(id, {
      id,
      name: req.body.name.trim(),
      pollHash: hash(pollToken),
      code,
      expiresAt,
      status: "pending",
    });
    return res.status(201).json({ id, code, expiresAt, pollToken });
  });
  const auth = {
    listPending: () =>
      Array.from(clients.values())
        .filter(
          (p) => p.status === "pending" && Date.parse(p.expiresAt) > Date.now(),
        )
        .map(({ id, name, code, expiresAt }) => ({
          id,
          name,
          code,
          expiresAt,
        })),
    approve: (id: string) => {
      const p = clients.get(id);
      if (!p || p.status !== "pending" || Date.parse(p.expiresAt) <= Date.now())
        return false;
      const raw = token(),
        createdAt = now(),
        expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
        randomUUID(),
        hash(raw),
        p.name,
        createdAt,
        expiresAt,
      );
      p.status = "approved";
      p.token = raw;
      return true;
    },
  };
  api.get("/pairings/:id", (req, res) => {
    const p = clients.get(req.params.id);
    if (
      !p ||
      !equal(p.pollHash, hash(String(req.headers["x-pairing-token"] ?? "")))
    )
      return err(res, 403, "Invalid pairing token");
    if (Date.parse(p.expiresAt) <= Date.now()) {
      clients.delete(p.id);
      return res.json({ status: "expired" });
    }
    const response = {
      status: p.status,
      ...(p.token ? { token: p.token } : {}),
    };
    if (p.token) {
      delete p.token;
      clients.delete(p.id);
    }
    return res.json(response);
  });
  api.post("/pairings/:id/approve", (req, res) => {
    if (
      mode !== "docker" ||
      !options.setupToken ||
      !equal(String(req.headers["x-setup-token"] ?? ""), options.setupToken)
    )
      return err(res, 403, "Setup denied");
    return auth.approve(req.params.id)
      ? res.json({ status: "approved" })
      : err(res, 404, "Pairing not found");
  });
  const sessionFor = (raw: string) =>
    db
      .prepare(
        "SELECT id,name,created_at,expires_at FROM sessions WHERE token_hash=? AND expires_at>?",
      )
      .get(hash(raw), now()) as Obj | undefined;
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const s = raw && sessionFor(raw);
    if (!s) return err(res, 401, "Authentication required");
    res.locals.session = s;
    next();
  };
  api.post("/sessions/revoke", requireAuth, (_req, res) => {
    db.prepare("DELETE FROM sessions WHERE id=?").run(res.locals.session.id);
    closeSession(res.locals.session.id);
    res.json({ ok: true });
  });
  api.get("/sessions", requireAuth, (_req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,name,created_at AS createdAt,expires_at AS expiresAt FROM sessions WHERE expires_at>?",
        )
        .all(now()),
    ),
  );
  api.delete("/sessions/:id", requireAuth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE id=?").run(String(req.params.id));
    closeSession(String(req.params.id));
    res.json({ ok: true });
  });
  const fixture = (u: URL) => (options.fixtureOrigins ?? []).includes(u.origin);
  function validateUrl(input: unknown): URL {
    if (typeof input !== "string" || input.length > 2048)
      throw Error("Invalid URL");
    const u = new URL(input);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw Error("Invalid URL");
    const h = u.hostname.toLowerCase();
    const allowed = [
      "twitch.tv",
      "youtube.com",
      "youtu.be",
      "kick.com",
      "chaturbate.com",
    ].some((d) => h === d || h.endsWith("." + d));
    if (!allowed && !fixture(u)) throw Error("Unsupported URL");
    if (!fixture(u) && u.protocol !== "https:") throw Error("HTTPS required");
    return u;
  }
  const platform = (u: URL) =>
    u.hostname.includes("twitch")
      ? "twitch"
      : u.hostname.includes("youtube") || u.hostname === "youtu.be"
        ? "youtube"
        : u.hostname.includes("kick")
          ? "kick"
          : u.hostname.includes("chaturbate")
            ? "chaturbate"
            : "other";
  const disk = (folder = settings.recordingsPath) => {
    mkdirSync(folder, { recursive: true });
    const s = statfsSync(folder);
    const total = Number(s.blocks) * Number(s.bsize),
      available = Number(s.bavail) * Number(s.bsize),
      used = total - Number(s.bfree) * Number(s.bsize);
    return {
      total,
      used,
      available,
      usedPercent: total ? (used / total) * 100 : 0,
    };
  };
  const dto = (r: Obj): Obj => {
    const {
      filePath,
      previewPath,
      thumbnailPath,
      mediaRoot,
      managed,
      capturePath,
      stagingPath,
      ...rest
    } = r;
    return {
      ...rest,
      hasPreview: !!previewPath && existsSync(previewPath),
      hasThumbnail: !!thumbnailPath && existsSync(thumbnailPath),
    };
  };
  const update = (r: Obj, patch: Obj) => {
    const current = get("recordings", r.id);
    if (!current) return;
    Object.assign(current, patch);
    Object.assign(r, current);
    put("recordings", current);
    broadcast("recording_update", dto(current));
  };
  const runTool = (bin: string, args: string[], timeout: number) => {
    if (process.platform === "win32") {
      if (!options.jobRunnerPath)
        return Promise.reject(
          new Error("Windows process containment helper unavailable"),
        );
      return run(
        options.jobRunnerPath,
        [String(process.pid), bin, ...args],
        timeout,
      );
    }
    return run(
      process.execPath,
      [
        fileURLToPath(new URL("./supervisor.js", import.meta.url)),
        bin,
        ...args,
      ],
      timeout,
    );
  };
  async function checkLive(url: string) {
    const u = validateUrl(url);
    if (fixture(u)) {
      const response = await fetch(u, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      return response.ok && (await response.text()).includes("#EXTM3U");
    }
    const result = await runTool(
      options.ytDlpPath ?? "yt-dlp",
      [
        "--ignore-config",
        "--no-plugin-dirs",
        "--ffmpeg-location",
        options.ffmpegPath ?? "ffmpeg",
        ...(options.jsRuntimePath
          ? ["--js-runtimes", `deno:${options.jsRuntimePath}`]
          : []),
        "--no-playlist",
        "--skip-download",
        "--print",
        "%(live_status)s",
        "--",
        u.href,
      ],
      20000,
    );
    return (
      result.code === 0 &&
      result.stdout
        .trim()
        .split("\n")
        .some((x) => x === "is_live")
    );
  }
  async function finish(r: Obj, success: boolean) {
    const output = r.filePath;
    const capture = r.capturePath ?? output + ".capture.ts";
    const staging = output + `.finalizing.${r.format}`;
    update(r, {
      status: "finalizing",
      capturePath: capture,
      stagingPath: staging,
    });
    if (!existsSync(capture) || !size(capture)) {
      update(r, {
        status: "failed",
        error: "Recording produced no media",
        completedAt: now(),
      });
      return;
    }
    try {
      const remux = await runTool(
        options.ffmpegPath ?? "ffmpeg",
        [
          ...(options.testFfmpegPrefixArgs ?? []),
          "-y",
          "-v",
          "error",
          "-i",
          capture,
          "-map",
          "0",
          "-c",
          "copy",
          ...(r.format === "ts" ? ["-f", "mpegts"] : []),
          staging,
        ],
        120000,
      );
      if (remux.code !== 0) throw Error("Remux failed");
      const probe = await runTool(
        options.ffprobePath ?? "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,format_name:stream=codec_type",
          "-of",
          "json",
          staging,
        ],
        30000,
      );
      if (probe.code !== 0) throw Error("Media validation failed");
      const metadata = JSON.parse(probe.stdout),
        names = String(metadata.format?.format_name ?? "").split(",");
      const container =
        r.format === "mp4"
          ? names.includes("mp4")
          : r.format === "mkv"
            ? names.includes("matroska")
            : names.includes("mpegts");
      if (
        !container ||
        !Array.isArray(metadata.streams) ||
        !metadata.streams.some(
          (stream: Obj) =>
            stream.codec_type === "video" || stream.codec_type === "audio",
        )
      )
        throw Error("Media validation failed");
      const duration = Number(metadata.format?.duration) || undefined;
      renameSync(staging, output);
      update(r, {
        filePath: output,
        stagingPath: undefined,
        fileSize: size(output),
        duration,
      });
      try {
        unlinkSync(capture);
        update(r, { capturePath: undefined });
      } catch {
        /* retained for safe later cleanup */
      }
      const thumb = output + ".jpg",
        preview = output + ".preview.jpg";
      let thumbPath: string | undefined, previewPath: string | undefined;
      try {
        const image = await runTool(
          options.ffmpegPath ?? "ffmpeg",
          [
            ...(options.testFfmpegPrefixArgs ?? []),
            "-y",
            "-v",
            "error",
            "-ss",
            "0",
            "-i",
            output,
            "-frames:v",
            "1",
            "-vf",
            "scale=320:-2",
            thumb,
          ],
          30000,
        );
        if (image.code === 0 && size(thumb)) thumbPath = thumb;
        const interval = Math.max(1, Math.floor((duration ?? 12) / 12));
        const collage = await runTool(
          options.ffmpegPath ?? "ffmpeg",
          [
            ...(options.testFfmpegPrefixArgs ?? []),
            "-y",
            "-v",
            "error",
            "-i",
            output,
            "-vf",
            `fps=1/${interval},scale=160:-2,tile=4x3`,
            "-frames:v",
            "1",
            preview,
          ],
          30000,
        );
        if (collage.code === 0 && size(preview)) previewPath = preview;
      } catch {
        /* image generation is optional */
      }
      update(r, {
        status: success ? "completed" : "interrupted",
        completedAt: now(),
        thumbnailPath: thumbPath,
        previewPath,
        ...(success
          ? {}
          : { error: "Recorder stopped before normal completion" }),
      });
    } catch {
      if (existsSync(capture)) r.filePath = capture;
      update(r, {
        status: "interrupted",
        filePath: r.filePath,
        capturePath: capture,
        stagingPath: staging,
        error: "Finalization failed",
        fileSize: size(capture),
        completedAt: now(),
      });
    }
  }
  async function startRecording(input: Obj) {
    const u = validateUrl(input.url);
    const quality = input.quality ?? settings.defaultQuality,
      format = input.format ?? settings.defaultFormat;
    if (!qualities.includes(quality) || !formats.includes(format))
      throw Error("Invalid quality or format");
    if (processes.size >= settings.maxConcurrentRecordings)
      throw Object.assign(Error("Recording limit reached"), { status: 409 });
    if (
      input.channelId &&
      processes.size &&
      all("recordings").some(
        (r) =>
          r.channelId === input.channelId && activeStates.includes(r.status),
      )
    )
      throw Object.assign(Error("Channel already recording"), { status: 409 });
    if (disk().usedPercent >= settings.maxDiskUsagePercent)
      throw Object.assign(Error("Disk usage limit reached"), { status: 507 });
    mkdirSync(settings.recordingsPath, { recursive: true });
    const id = randomUUID(),
      filePath = path.join(
        realpathSync(settings.recordingsPath),
        `${id}.${format}`,
      );
    const r: Obj = {
      id,
      managed: true,
      channelId: input.channelId || undefined,
      url: u.href,
      platform: platform(u),
      title:
        typeof input.title === "string"
          ? input.title.slice(0, 200)
          : `Recording ${now()}`,
      status: "starting",
      quality,
      format,
      filePath,
      mediaRoot: realpathSync(settings.recordingsPath),
      fileSize: 0,
      startedAt: now(),
      uploadedToCloud: false,
    };
    put("recordings", r);
    const capture = filePath + ".capture.ts";
    r.capturePath = capture;
    put("recordings", r);
    const map: Obj = {
      best: "best",
      "1080p": "best[height<=1080]/best",
      "720p": "best[height<=720]/best",
      "480p": "best[height<=480]/best",
      "360p": "best[height<=360]/best",
    };
    const args = fixture(u)
      ? [
          "-y",
          "-v",
          "error",
          "-i",
          u.href,
          "-map",
          "0",
          "-c",
          "copy",
          "-f",
          "mpegts",
          capture,
        ]
      : [
          "--ignore-config",
          "--no-plugin-dirs",
          "--ffmpeg-location",
          options.ffmpegPath ?? "ffmpeg",
          ...(options.jsRuntimePath
            ? ["--js-runtimes", `deno:${options.jsRuntimePath}`]
            : []),
          "--no-playlist",
          "--no-part",
          "--hls-use-mpegts",
          "--no-live-from-start",
          "-f",
          map[quality],
          "-o",
          capture,
          "--",
          u.href,
        ];
    const recorder = fixture(u)
      ? (options.ffmpegPath ?? "ffmpeg")
      : (options.ytDlpPath ?? "yt-dlp");
    if (process.platform === "win32" && !options.jobRunnerPath) {
      update(r, {
        status: "failed",
        error: "Windows process containment helper unavailable",
        completedAt: now(),
      });
      throw Error("Windows process containment helper unavailable");
    }
    const child = spawn(
      process.platform === "win32" ? options.jobRunnerPath! : process.execPath,
      process.platform === "win32"
        ? [
            String(process.pid),
            recorder,
            ...(fixture(u)
              ? (options.testFfmpegPrefixArgs ?? [])
              : (options.testYtDlpPrefixArgs ?? [])),
            ...args,
          ]
        : [
            fileURLToPath(new URL("./supervisor.js", import.meta.url)),
            recorder,
            ...(fixture(u)
              ? (options.testFfmpegPrefixArgs ?? [])
              : (options.testYtDlpPrefixArgs ?? [])),
            ...args,
          ],
      {
        stdio: ["pipe", "ignore", "ignore"],
        detached: process.platform !== "win32",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: {
      child: ChildProcess;
      done: Promise<void>;
      stop: boolean;
      forced?: boolean;
      stopPromise?: Promise<Obj>;
      reason?: string;
    } = { child, done, stop: false };
    processes.set(id, entry);
    child.once("error", (e) => {
      update(r, {
        status: "failed",
        error: "Recorder could not start",
        completedAt: now(),
      });
    });
    child.once("spawn", () => update(r, { status: "recording" }));
    child.once("close", async (code) => {
      try {
        if (entry.reason === "process tree did not exit") {
          const capture = r.capturePath ?? r.filePath + ".capture.ts";
          update(r, {
            status: "interrupted",
            filePath: capture,
            capturePath: capture,
            fileSize: size(capture),
            error: "Recorder process tree did not exit",
            completedAt: now(),
          });
        } else if (r.status !== "failed")
          await finish(
            r,
            (code === 0 || (process.platform !== "win32" && entry.stop)) &&
              !entry.forced &&
              !entry.reason,
          );
      } finally {
        processes.delete(id);
        resolveDone();
      }
    });
    broadcast("recording_update", dto(r));
    return r;
  }
  async function stopRecording(id: string, reason?: string) {
    const p = processes.get(id),
      r = get("recordings", id);
    if (!p || !r)
      throw Object.assign(Error("Recording is not active"), { status: 409 });
    if (p.stopPromise) return p.stopPromise;
    p.stop = true;
    p.reason = reason;
    p.stopPromise = (async () => {
      if (r.status !== "finalizing") update(r, { status: "stopping" });
      const signal = (sig: NodeJS.Signals) => {
        if (process.platform === "win32") {
          if (p.child.stdin?.writable) p.child.stdin.write("stop\n");
          p.forced = true;
        } else if (p.child.pid) {
          try {
            process.kill(-p.child.pid, sig);
          } catch {}
        }
      };
      if (p.child.stdin?.writable) {
        p.child.stdin.write("stop\n");
      } else signal("SIGINT");
      const timer = setTimeout(() => {
        p.forced = true;
        signal("SIGTERM");
      }, 5000);
      const force = setTimeout(() => {
        p.forced = true;
        signal("SIGKILL");
        if (process.platform === "win32") p.child.kill();
      }, 12000);
      await p.done;
      clearTimeout(timer);
      clearTimeout(force);
      return get("recordings", id)!;
    })();
    return p.stopPromise;
  }
  for (const r of all("recordings")) {
    if (r.managed === true && !r.mediaRoot && typeof r.filePath === "string") {
      try {
        const root = realpathSync(settings.recordingsPath);
        if (realpathSync(path.dirname(r.filePath)) === root) {
          r.mediaRoot = root;
          r.filePath = path.join(root, path.basename(r.filePath));
          put("recordings", r);
        }
      } catch {}
    }
    if (activeStates.includes(r.status)) {
      r.status = "interrupted";
      r.error = "Engine restarted during recording";
      r.completedAt = now();
      const capture = r.capturePath ?? r.filePath + ".capture.ts";
      if (existsSync(capture)) {
        r.capturePath = capture;
        r.filePath = capture;
        r.fileSize = size(capture);
      }
      put("recordings", r);
    }
  }
  api.use(requireAuth);
  api.post("/settings/s3-approvals", (req, res) => {
    const destination = Object.fromEntries(
      ["s3Enabled", "s3Bucket", "s3Region", "s3Endpoint"].map((k) => [
        k,
        req.body?.[k],
      ]),
    );
    if (
      typeof destination.s3Enabled !== "boolean" ||
      ["s3Bucket", "s3Region", "s3Endpoint"].some(
        (k) => typeof destination[k] !== "string",
      )
    )
      return err(res, 422, "Invalid destination");
    for (const [id, item] of approvalRequests)
      if (Date.parse(item.expiresAt) <= Date.now()) approvalRequests.delete(id);
    if (approvalRequests.size >= 100)
      return err(res, 429, "Too many approval requests");
    const id = randomUUID(),
      expiresAt = new Date(Date.now() + 120000).toISOString();
    approvalRequests.set(id, {
      id,
      sessionId: res.locals.session.id,
      destination,
      expiresAt,
      status: "pending",
    });
    return res.status(201).json({ id, expiresAt });
  });
  api.post("/settings/s3-approvals/:id/approve", (req, res) => {
    if (
      mode !== "docker" ||
      !options.setupToken ||
      !equal(String(req.headers["x-setup-token"] ?? ""), options.setupToken)
    )
      return err(res, 403, "Setup denied");
    const item = approvalRequests.get(String(req.params.id));
    if (!item || item.sessionId !== res.locals.session.id)
      return err(res, 404, "Approval request not found");
    return local.resolveUploadApproval(item.id, true)
      ? res.json({ status: "approved" })
      : err(res, 409, "Approval request expired or resolved");
  });
  api.get("/settings/s3-approvals/:id", (req, res) => {
    const item = approvalRequests.get(String(req.params.id));
    if (!item || item.sessionId !== res.locals.session.id)
      return err(res, 404, "Approval request not found");
    if (Date.parse(item.expiresAt) <= Date.now()) {
      approvalRequests.delete(item.id);
      return res.json({ status: "expired" });
    }
    const result = {
      status: item.status,
      ...(item.approvalToken ? { approvalToken: item.approvalToken } : {}),
    };
    if (item.approvalToken) {
      delete item.approvalToken;
      approvalRequests.delete(item.id);
    }
    return res.json(result);
  });
  api.get("/settings", (_req, res) => res.json(publicSettings()));
  api.put("/settings", (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      return err(res, 422, "Invalid settings");
    const next = { ...settings };
    for (const key of Object.keys(defaults))
      if (key in (req.body ?? {})) {
        if (key === "recordingsPath" && req.body[key] !== settings[key])
          return err(
            res,
            403,
            "Use the local folder picker to change recordings path",
          );
        if (lockedFields.includes(key) && req.body[key] !== settings[key])
          return err(res, 403, "Setting is locked");
        next[key] = req.body[key];
      }
    if (
      typeof next.recordingsPath !== "string" ||
      !path.isAbsolute(next.recordingsPath) ||
      !qualities.includes(next.defaultQuality) ||
      !formats.includes(next.defaultFormat) ||
      !Number.isInteger(next.monitorIntervalSeconds) ||
      next.monitorIntervalSeconds < 10 ||
      next.monitorIntervalSeconds > 86400 ||
      !Number.isInteger(next.maxConcurrentRecordings) ||
      next.maxConcurrentRecordings < 1 ||
      next.maxConcurrentRecordings > 20 ||
      typeof next.maxDiskUsagePercent !== "number" ||
      next.maxDiskUsagePercent < 1 ||
      next.maxDiskUsagePercent > 99 ||
      !Number.isInteger(next.autoCleanupDays) ||
      next.autoCleanupDays < 1 ||
      typeof next.autoCleanupEnabled !== "boolean" ||
      typeof next.s3Enabled !== "boolean" ||
      ["s3Bucket", "s3Region", "s3Endpoint"].some(
        (k) => typeof next[k] !== "string",
      )
    )
      return err(res, 422, "Invalid settings");
    if (next.s3Endpoint) {
      try {
        const endpoint = new URL(next.s3Endpoint);
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash ||
          ["fanclan.io", "vercel.app", "vercel.com"].some(
            (d) =>
              endpoint.hostname === d || endpoint.hostname.endsWith("." + d),
          )
        )
          return err(res, 422, "Invalid S3 endpoint");
      } catch {
        return err(res, 422, "Invalid S3 endpoint");
      }
    }
    const nextSecrets = { ...secrets };
    for (const k of ["s3AccessKeyId", "s3SecretAccessKey"])
      if (k in req.body) {
        if (typeof req.body[k] !== "string")
          return err(res, 422, "Invalid credentials");
        nextSecrets[k] = req.body[k];
      }
    const changedDestination = [
      "s3Enabled",
      "s3Bucket",
      "s3Region",
      "s3Endpoint",
    ].some((k) => next[k] !== settings[k]);
    const disablingOnly =
      settings.s3Enabled === true &&
      next.s3Enabled === false &&
      ["s3Bucket", "s3Region", "s3Endpoint"].every(
        (k) => next[k] === settings[k],
      );
    const destination = JSON.stringify(
      ["s3Enabled", "s3Bucket", "s3Region", "s3Endpoint"].map((k) => next[k]),
    );
    const approval = destinationApprovals.get(
      String(req.body.uploadDestinationApproval ?? ""),
    );
    if (
      changedDestination &&
      !disablingOnly &&
      (!approval ||
        approval.destination !== destination ||
        approval.sessionId !== res.locals.session.id ||
        Date.parse(approval.expiresAt) <= Date.now())
    )
      return err(res, 403, "Local approval of upload destination required");
    if (changedDestination && !disablingOnly)
      destinationApprovals.delete(String(req.body.uploadDestinationApproval));
    const oldSettings = settings,
      oldSecrets = secrets;
    try {
      const temporary = secretsPath + ".tmp";
      writeFileSync(temporary, JSON.stringify(nextSecrets), { mode: 0o600 });
      renameSync(temporary, secretsPath);
      settings = next;
      secrets = nextSecrets;
      saveSettings();
    } catch {
      settings = oldSettings;
      secrets = oldSecrets;
      try {
        writeFileSync(secretsPath, JSON.stringify(oldSecrets), { mode: 0o600 });
      } catch {}
      return err(res, 500, "Could not save settings");
    }
    try {
      chmodSync(secretsPath, 0o600);
    } catch {}
    return res.json(publicSettings());
  });
  api.get("/channels", (_req, res) => res.json(all("channels")));
  api.post("/channels", (req, res) => {
    try {
      const u = validateUrl(req.body?.url);
      if (typeof req.body.name !== "string" || !req.body.name.trim())
        throw Error("Invalid name");
      const quality = req.body.quality ?? "best";
      if (!qualities.includes(quality)) throw Error("Invalid quality");
      const c = {
        id: randomUUID(),
        name: req.body.name.slice(0, 200),
        url: u.href,
        platform: platform(u),
        quality,
        autoRecord: req.body.autoRecord === true,
        enabled: req.body.enabled !== false,
        isLive: false,
        createdAt: now(),
        updatedAt: now(),
      };
      put("channels", c);
      broadcast("channel_update", c);
      return res.status(201).json(c);
    } catch (e) {
      return err(res, 422, e instanceof Error ? e.message : "Invalid input");
    }
  });
  api.patch("/channels/:id", (req, res) => {
    const c = get("channels", req.params.id);
    if (!c) return err(res, 404, "Channel not found");
    try {
      for (const k of ["name", "quality", "enabled", "autoRecord"])
        if (k in req.body) c[k] = req.body[k];
      if (
        typeof c.name !== "string" ||
        !c.name.trim() ||
        !qualities.includes(c.quality) ||
        typeof c.enabled !== "boolean" ||
        typeof c.autoRecord !== "boolean"
      )
        throw Error("Invalid channel");
      if (req.body.url) {
        const u = validateUrl(req.body.url);
        c.url = u.href;
        c.platform = platform(u);
      }
      c.updatedAt = now();
      put("channels", c);
      broadcast("channel_update", c);
      return res.json(c);
    } catch (e) {
      return err(res, 422, e instanceof Error ? e.message : "Invalid channel");
    }
  });
  api.delete("/channels/:id", (req, res) => {
    del("channels", req.params.id);
    res.json({ ok: true });
  });
  async function check(c: Obj) {
    const isLive = await checkLive(c.url);
    const current = get("channels", c.id);
    if (!current || current.url !== c.url || current.updatedAt !== c.updatedAt)
      return false;
    Object.assign(current, { isLive, lastChecked: now(), updatedAt: now() });
    put("channels", current);
    broadcast("channel_update", current);
    return isLive;
  }
  api.post("/channels/:id/check", async (req, res) => {
    const c = get("channels", req.params.id);
    if (!c) return err(res, 404, "Channel not found");
    try {
      return res.json({ isLive: await check(c) });
    } catch {
      return err(res, 502, "Live check failed");
    }
  });
  api.get("/channels/:id/stats", (req, res) => {
    const c = get("channels", req.params.id);
    if (!c) return err(res, 404, "Channel not found");
    const recordings = all("recordings")
      .filter((r) => r.channelId === c.id)
      .map(dto);
    return res.json({
      channel: c,
      recordings,
      stats: {
        totalRecordings: recordings.length,
        totalDuration: recordings.reduce((n, r) => n + (r.duration ?? 0), 0),
        totalSize: recordings.reduce((n, r) => n + (r.fileSize ?? 0), 0),
      },
    });
  });
  api.get("/recordings", (req, res) => {
    let rs = all("recordings");
    for (const key of ["status", "platform", "channelId"])
      if (req.query[key]) rs = rs.filter((r) => r[key] === req.query[key]);
    if (req.query.search) {
      const s = String(req.query.search).toLowerCase();
      rs = rs.filter((r) => r.title.toLowerCase().includes(s));
    }
    if (req.query.dateFrom)
      rs = rs.filter((r) => r.startedAt >= String(req.query.dateFrom));
    if (req.query.dateTo)
      rs = rs.filter(
        (r) => r.startedAt <= String(req.query.dateTo) + "T23:59:59.999Z",
      );
    const field = [
      "startedAt",
      "title",
      "fileSize",
      "duration",
      "status",
    ].includes(String(req.query.sortBy))
      ? String(req.query.sortBy)
      : "startedAt";
    const dir = req.query.sortOrder === "asc" ? 1 : -1;
    rs.sort(
      (a, b) =>
        String(a[field] ?? "").localeCompare(
          String(b[field] ?? ""),
          undefined,
          { numeric: true },
        ) * dir,
    );
    res.json(rs.map(dto));
  });
  api.post("/recordings/start", async (req, res) => {
    try {
      return res.status(201).json(dto(await startRecording(req.body ?? {})));
    } catch (e) {
      return err(
        res,
        (e as Obj).status ?? 422,
        e instanceof Error &&
          [
            "Invalid URL",
            "Unsupported URL",
            "HTTPS required",
            "Invalid quality or format",
            "Recording limit reached",
            "Channel already recording",
            "Disk usage limit reached",
            "Windows process containment helper unavailable",
          ].includes(e.message)
          ? e.message
          : "Could not start recording",
      );
    }
  });
  api.post("/recordings/:id/stop", async (req, res) => {
    try {
      return res.json(dto(await stopRecording(req.params.id)));
    } catch (e) {
      return err(
        res,
        (e as Obj).status ?? 500,
        e instanceof Error ? e.message : "Stop failed",
      );
    }
  });
  api.get("/recordings/:id", (req, res) => {
    const r = get("recordings", req.params.id);
    return r ? res.json(dto(r)) : err(res, 404, "Recording not found");
  });
  function openMedia(r: Obj, file: string): number {
    if (typeof file !== "string" || typeof r.mediaRoot !== "string")
      throw Error("Media unavailable");
    const root = realpathSync(r.mediaRoot);
    const parent = realpathSync(path.dirname(file));
    const relative = path.relative(root, parent);
    if (
      relative.startsWith(".." + path.sep) ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      path.dirname(path.resolve(file)) !== parent
    )
      throw Error("Media outside approved folder");
    let cursor = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink())
        throw Error("Media folder contains a symlink");
    }
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink())
      throw Error("Media is not a regular file");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw Error("Media is not a regular file");
    }
    return fd;
  }
  function safeDelete(r: Obj) {
    if (r.managed !== true) {
      del("recordings", r.id);
      return;
    }
    const files = [
      r.filePath,
      r.capturePath,
      r.stagingPath,
      r.previewPath,
      r.thumbnailPath,
    ];
    for (const file of new Set(files)) {
      if (typeof file !== "string" || !existsSync(file)) continue;
      const fd = openMedia(r, file);
      closeSync(fd);
      unlinkSync(file);
    }
    del("recordings", r.id);
  }
  api.delete("/recordings/:id", (req, res) => {
    const r = get("recordings", req.params.id);
    if (!r) return err(res, 404, "Recording not found");
    if (activeStates.includes(r.status) || uploads.has(r.id))
      return err(res, 409, "Recording is active");
    try {
      safeDelete(r);
    } catch {
      return err(res, 409, "Could not safely remove recording");
    }
    for (const [key, t] of tickets)
      if (t.recordingId === r.id) tickets.delete(key);
    return res.json({ ok: true });
  });
  api.post("/recordings/:id/upload", async (req, res) => {
    const r = get("recordings", req.params.id);
    if (!r) return err(res, 404, "Recording not found");
    if (activeStates.includes(r.status) || uploads.has(r.id))
      return err(res, 409, "Recording is busy");
    if (r.uploadedToCloud)
      return res.json({ uploadedToCloud: true, uploadState: "completed" });
    if (
      !settings.s3Enabled ||
      !settings.s3Bucket ||
      !secrets.s3AccessKeyId ||
      !secrets.s3SecretAccessKey
    )
      return err(res, 422, "S3 is not configured");
    try {
      if (settings.s3Endpoint) {
        const endpoint = new URL(settings.s3Endpoint);
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          ["fanclan.io", "vercel.app", "vercel.com"].some(
            (d) =>
              endpoint.hostname === d || endpoint.hostname.endsWith("." + d),
          )
        )
          return err(res, 422, "Invalid S3 endpoint");
      }
      if (/(^|[.-])(fanclan|vercel)([.-]|$)/i.test(settings.s3Bucket))
        return err(res, 422, "Invalid S3 bucket");
      const fd = openMedia(r, r.filePath);
      const body = createReadStream(r.filePath, { fd, autoClose: true });
      const client = new S3Client({
        region: settings.s3Region,
        endpoint: settings.s3Endpoint || undefined,
        forcePathStyle: !!settings.s3Endpoint,
        credentials: {
          accessKeyId: secrets.s3AccessKeyId,
          secretAccessKey: secrets.s3SecretAccessKey,
        },
      });
      const upload = new Upload({
        client,
        params: {
          Bucket: settings.s3Bucket,
          Key: `recordings/${r.id}.${r.format}`,
          Body: body,
        },
      });
      uploads.set(r.id, upload);
      let finishUpload!: () => void;
      uploadDone.set(
        r.id,
        new Promise<void>((resolve) => {
          finishUpload = resolve;
        }),
      );
      update(r, { uploadState: "uploading", uploadProgress: 0 });
      upload.on("httpUploadProgress", (progress) => {
        if (progress.total)
          update(r, {
            uploadProgress: Math.min(
              100,
              Math.round(((progress.loaded ?? 0) / progress.total) * 100),
            ),
          });
      });
      try {
        await upload.done();
        update(r, {
          uploadedToCloud: true,
          uploadState: "completed",
          uploadProgress: 100,
        });
        return res.json({ uploadedToCloud: true, uploadState: "completed" });
      } finally {
        uploads.delete(r.id);
        finishUpload();
        uploadDone.delete(r.id);
        client.destroy();
      }
    } catch {
      update(r, { uploadState: "failed" });
      return err(res, 502, "Upload failed");
    }
  });
  api.delete("/recordings/:id/upload", async (req, res) => {
    const upload = uploads.get(String(req.params.id));
    if (!upload) return err(res, 404, "Upload not active");
    await upload.abort();
    return res.json({ uploadState: "cancelled" });
  });
  api.post("/recordings/:id/media-ticket", (req, res) => {
    const r = get("recordings", req.params.id),
      kind = req.body?.kind;
    if (!r) return err(res, 404, "Recording not found");
    if (!["stream", "download", "preview", "thumbnail"].includes(kind))
      return err(res, 422, "Invalid media kind");
    const file =
      kind === "preview"
        ? r.previewPath
        : kind === "thumbnail"
          ? r.thumbnailPath
          : r.filePath;
    try {
      const fd = openMedia(r, file);
      closeSync(fd);
    } catch {
      return err(res, 404, "Media not found");
    }
    for (const [key, entry] of tickets)
      if (Date.parse(entry.expiresAt) <= Date.now()) tickets.delete(key);
    if (tickets.size >= 1000) return err(res, 429, "Too many media tickets");
    const t = token(),
      expiresAt = new Date(Date.now() + 300000).toISOString();
    tickets.set(hash(t), {
      recordingId: r.id,
      sessionId: res.locals.session.id,
      kind,
      expiresAt,
    });
    const addr = server.address() as AddressInfo;
    const base =
      mode === "docker"
        ? (publicOrigin ?? `http://${req.headers.host}`)
        : `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
    return res.json({ url: `${base}/media/${t}`, expiresAt });
  });
  app.get("/media/:ticket", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const t = tickets.get(hash(req.params.ticket));
    if (
      !t ||
      Date.parse(t.expiresAt) <= Date.now() ||
      !db
        .prepare("SELECT id FROM sessions WHERE id=? AND expires_at>?")
        .get(t.sessionId, now())
    ) {
      tickets.delete(hash(req.params.ticket));
      return err(res, 403, "Ticket expired or invalid");
    }
    const r = get("recordings", t.recordingId);
    if (!r) return err(res, 404, "Media not found");
    const file =
      t.kind === "preview"
        ? r.previewPath
        : t.kind === "thumbnail"
          ? r.thumbnailPath
          : r.filePath;
    const extension = path.extname(file ?? "").toLowerCase();
    const types: Obj = {
      ".mp4": "video/mp4",
      ".mkv": "video/x-matroska",
      ".ts": "video/mp2t",
      ".jpg": "image/jpeg",
    };
    if (!types[extension]) return err(res, 415, "Unsupported media type");
    let fd: number;
    try {
      fd = openMedia(r, file);
    } catch {
      return err(res, 404, "Media not found");
    }
    const total = fstatSync(fd).size;
    let start = 0,
      end = total - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        closeSync(fd);
        return res.status(416).end();
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, total - suffix);
      } else start = Number(match[1]);
      if (match[2] && match[1]) end = Math.min(end, Number(match[2]));
      if (start > end || start >= total) {
        closeSync(fd);
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", types[extension]);
    res.setHeader("Content-Length", String(Math.max(0, end - start + 1)));
    if (t.kind === "download")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="recording${extension}"`,
      );
    mediaResponses.set(res, t.sessionId);
    res.once("close", () => mediaResponses.delete(res));
    if (total === 0) {
      closeSync(fd);
      return res.end();
    }
    const stream = createReadStream(file, { fd, autoClose: true, start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return res;
  });
  api.get("/status", (_req, res) => {
    try {
      return res.json({
        activeRecordings: processes.size,
        totalRecordings: all("recordings").length,
        totalChannels: all("channels").length,
        disk: disk(),
        version: "0.1.0",
        uptime: process.uptime(),
      });
    } catch {
      return err(res, 500, "Disk unavailable");
    }
  });
  api.get("/diagnostics", (_req, res) =>
    res.json({
      version: "0.1.0",
      protocolVersion: 1,
      mode,
      activeRecordings: processes.size,
      platform: process.platform,
    }),
  );
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/api/v1/events" ||
      !validHost(req.headers.host ?? "") ||
      !safeOrigin(req.headers.origin, req.headers.host)
    ) {
      socket.destroy();
      return;
    }
    const h = req.headers.host ?? "";
    if (
      mode === "desktop" &&
      !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(h)
    ) {
      socket.destroy();
      return;
    }
    if (wss.clients.size >= 100) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const timeout = setTimeout(
        () => ws.close(1008, "Authentication required"),
        5000,
      );
      ws.once("message", (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          const session =
            typeof data.token === "string" ? sessionFor(data.token) : undefined;
          if (data.type !== "auth" || !session) throw Error();
          clearTimeout(timeout);
          authenticated.set(ws, session.id);
        } catch {
          ws.close(1008, "Authentication required");
        }
      });
      ws.on("close", () => {
        clearTimeout(timeout);
        authenticated.delete(ws);
      });
    });
  });
  if (options.dashboardPath && existsSync(options.dashboardPath)) {
    app.use("/app", express.static(options.dashboardPath));
    app.get("/app/{*splat}", (_req, res) =>
      res.sendFile(path.resolve(options.dashboardPath!, "index.html")),
    );
  }
  async function monitor() {
    if (monitoring || stopping) return;
    monitoring = true;
    try {
      for (const c of all("channels").filter((c) => c.enabled)) {
        if (stopping) break;
        try {
          if (
            (await check(c)) &&
            !stopping &&
            get("channels", c.id)?.enabled === true &&
            get("channels", c.id)?.autoRecord === true &&
            get("channels", c.id)?.url === c.url &&
            !all("recordings").some(
              (r) => r.channelId === c.id && activeStates.includes(r.status),
            )
          )
            await startRecording({
              url: c.url,
              quality: c.quality,
              title: c.name,
              channelId: c.id,
            });
        } catch {}
      }
      if (settings.autoCleanupEnabled) {
        const cutoff = Date.now() - settings.autoCleanupDays * 86400000;
        for (const r of all("recordings"))
          if (
            r.managed === true &&
            !uploads.has(r.id) &&
            !activeStates.includes(r.status) &&
            r.completedAt &&
            Date.parse(r.completedAt) < cutoff
          )
            try {
              safeDelete(r);
            } catch {
              update(r, { error: "Automatic cleanup failed; retry required" });
            }
      }
    } finally {
      monitoring = false;
      if (!stopping)
        monitorTimer = setTimeout(
          monitor,
          settings.monitorIntervalSeconds * 1000,
        );
    }
  }
  function importLegacy(file: string, mediaRoot?: string) {
    if (!path.isAbsolute(file))
      throw Error("Absolute legacy database path required");
    const approvedRoot = mediaRoot ? realpathSync(mediaRoot) : undefined;
    const legacy = new DatabaseSync(file, { readOnly: true });
    let channels = 0,
      recordings = 0,
      unlinkedMedia = 0,
      skippedChannels = 0,
      skippedRecordings = 0;
    try {
      const cs = legacy.prepare("SELECT * FROM channels").all() as Obj[],
        rs = legacy.prepare("SELECT * FROM recordings").all() as Obj[];
      db.exec("BEGIN");
      try {
        for (const c of cs) {
          const id = "legacy-" + String(c.id);
          if (get("channels", id)) continue;
          try {
            const u = validateUrl(c.url);
            put("channels", {
              id,
              name: String(c.name ?? "Imported channel").slice(0, 200),
              url: u.href,
              platform: platform(u),
              quality: qualities.includes(c.quality) ? c.quality : "best",
              autoRecord: false,
              enabled: false,
              isLive: false,
              createdAt: c.created_at ?? now(),
              updatedAt: now(),
            });
            channels++;
          } catch {
            skippedChannels++;
          }
        }
        for (const r of rs) {
          const id = "legacy-" + String(r.id);
          if (get("recordings", id)) continue;
          try {
            const u = validateUrl(r.url);
            const filePath =
              typeof r.file_path === "string" && path.isAbsolute(r.file_path)
                ? r.file_path
                : undefined;
            let safePath: string | undefined;
            if (
              filePath &&
              approvedRoot &&
              [".mp4", ".mkv", ".ts"].includes(
                path.extname(filePath).toLowerCase(),
              )
            ) {
              try {
                const parent = realpathSync(path.dirname(filePath)),
                  relative = path.relative(approvedRoot, parent);
                if (
                  relative !== ".." &&
                  !relative.startsWith(".." + path.sep) &&
                  !path.isAbsolute(relative)
                ) {
                  const canonical = path.join(parent, path.basename(filePath));
                  const stat = lstatSync(canonical);
                  if (stat.isFile() && !stat.isSymbolicLink()) {
                    let cursor = approvedRoot;
                    let clean = true;
                    for (const part of relative
                      .split(path.sep)
                      .filter(Boolean)) {
                      cursor = path.join(cursor, part);
                      if (lstatSync(cursor).isSymbolicLink()) clean = false;
                    }
                    if (clean) safePath = canonical;
                  }
                }
              } catch {}
            }
            if (filePath && !safePath) unlinkedMedia++;
            const status =
              r.status === "completed" ? "completed" : "interrupted";
            put("recordings", {
              id,
              managed: false,
              channelId: r.channel_id ? "legacy-" + r.channel_id : undefined,
              url: u.href,
              platform: platform(u),
              title: String(r.title ?? "Imported recording").slice(0, 200),
              status,
              quality: qualities.includes(r.quality) ? r.quality : "best",
              format: formats.includes(r.format) ? r.format : "mp4",
              filePath: safePath,
              mediaRoot: approvedRoot,
              fileSize: safePath ? size(safePath) : 0,
              duration: r.duration ?? undefined,
              startedAt: r.started_at ?? now(),
              completedAt: r.completed_at ?? now(),
              uploadedToCloud: !!r.uploaded_to_cloud,
            });
            recordings++;
          } catch {
            skippedRecordings++;
          }
        }
        db.exec("COMMIT");
        return {
          channels,
          recordings,
          unlinkedMedia,
          skippedChannels,
          skippedRecordings,
        };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      legacy.close();
    }
  }
  const destinationApprovals = new Map<string, Obj>();
  const approvalRequests = new Map<string, Obj>();
  const local = {
    importLegacy,
    listUploadApprovals() {
      return [...approvalRequests.values()]
        .filter(
          (item) =>
            item.status === "pending" &&
            Date.parse(item.expiresAt) > Date.now(),
        )
        .map(({ id, destination, expiresAt }) => ({
          id,
          destination,
          expiresAt,
        }));
    },
    resolveUploadApproval(id: string, approved: boolean) {
      const item = approvalRequests.get(id);
      if (
        !item ||
        item.status !== "pending" ||
        Date.parse(item.expiresAt) <= Date.now()
      )
        return false;
      if (!approved) {
        item.status = "rejected";
        return true;
      }
      const key = token();
      destinationApprovals.set(key, {
        destination: JSON.stringify(
          ["s3Enabled", "s3Bucket", "s3Region", "s3Endpoint"].map(
            (k) => item.destination[k],
          ),
        ),
        sessionId: item.sessionId,
        expiresAt: item.expiresAt,
      });
      item.approvalToken = key;
      item.status = "approved";
      return true;
    },
    setRecordingsPath(p: string) {
      if (lockedFields.includes("recordingsPath"))
        throw Error("Setting is locked");
      if (!path.isAbsolute(p) || p.startsWith("\\\\"))
        throw Error("Absolute local path required");
      mkdirSync(p, { recursive: true });
      settings.recordingsPath = p;
      saveSettings();
      return publicSettings();
    },
    diagnostics: () => ({
      version: "0.1.0",
      protocolVersion: 1,
      mode,
      activeRecordings: processes.size,
      platform: process.platform,
    }),
  };
  return {
    app,
    server,
    auth,
    local,
    async start(): Promise<AddressInfo> {
      if (started) throw Error("Already started");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      started = true;
      healthTimer = setInterval(() => {
        try {
          for (const [id, p] of processes) {
            const r = get("recordings", id);
            if (r && r.status === "recording") {
              update(r, {
                fileSize: size(r.capturePath ?? r.filePath + ".capture.ts"),
              });
              const full =
                disk(r.mediaRoot).usedPercent >= settings.maxDiskUsagePercent;
              if (full && !p.stop) void stopRecording(id, "disk pressure");
            }
          }
        } catch {}
      }, 5000);
      if (options.monitor !== false) void monitor();
      return server.address() as AddressInfo;
    },
    async stop() {
      if (!started) {
        db.close();
        lease.exec("ROLLBACK");
        lease.close();
        return;
      }
      stopping = true;
      if (monitorTimer) clearTimeout(monitorTimer);
      if (healthTimer) clearInterval(healthTimer);
      while (monitoring)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingUploads = [...uploadDone.values()];
      await Promise.allSettled(
        [...uploads.values()].map((upload) => upload.abort()),
      );
      await Promise.allSettled(pendingUploads);
      await Promise.allSettled(
        [...processes.keys()].map((id) => stopRecording(id)),
      );
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      lease.exec("ROLLBACK");
      lease.close();
      started = false;
    },
  };
}
