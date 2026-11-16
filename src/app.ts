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
} from "node:fs";
import path from "node:path";
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
  mode?: "desktop" | "docker";
  allowedOrigins?: string[];
  setupToken?: string;
  monitor?: boolean;
  fixtureOrigins?: string[];
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
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (b) => {
      if (out.length < 1_000_000) out += b;
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.once("close", (code) => {
      clearTimeout(timer);
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
  const db = new DatabaseSync(path.join(options.dataDir, "engine.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL); PRAGMA user_version=1",
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
  let settings: Obj = {
    ...defaults,
    ...JSON.parse(
      (
        db.prepare("SELECT value FROM meta WHERE key='settings'").get() as
          Obj | undefined
      )?.value ?? "{}",
    ),
  };
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
  });
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const authenticated = new Map<WebSocket, string>();
  const closeSession = (id: string) => {
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
    processes = new Map<
      string,
      { child: ChildProcess; done: Promise<void>; stop: boolean }
    >();
  let monitorTimer: NodeJS.Timeout | undefined,
    healthTimer: NodeJS.Timeout | undefined,
    monitoring = false,
    stopping = false,
    started = false;
  const safeOrigin = (origin: string | undefined, requestHost?: string) =>
    !origin ||
    (options.allowedOrigins ?? []).includes(origin) ||
    (!!requestHost &&
      origin === `http://${requestHost}` &&
      (mode === "docker" ||
        /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(requestHost)));
  app.use((req, res, next) => {
    const h = req.headers.host ?? "";
    const hostname = h.startsWith("[")
      ? h.slice(1, h.indexOf("]"))
      : h.split(":")[0];
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
  const disk = () => {
    mkdirSync(settings.recordingsPath, { recursive: true });
    const s = statfsSync(settings.recordingsPath);
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
    const { filePath, previewPath, thumbnailPath, managed, ...rest } = r;
    return {
      ...rest,
      hasPreview: !!previewPath && existsSync(previewPath),
      hasThumbnail: !!thumbnailPath && existsSync(thumbnailPath),
    };
  };
  const update = (r: Obj, patch: Obj) => {
    Object.assign(r, patch);
    put("recordings", r);
    broadcast("recording_update", dto(r));
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
    const result = await run(
      options.ytDlpPath ?? "yt-dlp",
      [
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
    update(r, { status: "finalizing" });
    const temp = r.filePath + ".capture.ts";
    if (!existsSync(temp) || !size(temp)) {
      update(r, {
        status: "failed",
        error: "Recording produced no media",
        completedAt: now(),
      });
      return;
    }
    let output = r.filePath;
    try {
      if (r.format === "ts") {
        output = temp;
      } else {
        const result = await run(
          options.ffmpegPath ?? "ffmpeg",
          ["-y", "-v", "error", "-i", temp, "-map", "0", "-c", "copy", output],
          120000,
        );
        if (result.code !== 0) throw Error("Remux failed");
      }
      const probe = await run(
        options.ffprobePath ?? "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          output,
        ],
        30000,
      );
      if (probe.code !== 0) throw Error("Media validation failed");
      const duration =
        Number(JSON.parse(probe.stdout).format?.duration) || undefined;
      if (output !== temp) unlinkSync(temp);
      else {
        r.filePath = temp;
      }
      update(r, {
        status: success ? "completed" : "interrupted",
        fileSize: size(output),
        duration,
        completedAt: now(),
        ...(success ? {} : { error: "Recorder exited unexpectedly" }),
      });
      const thumb = output + ".jpg";
      const preview = output + ".preview.jpg";
      const image = await run(
        options.ffmpegPath ?? "ffmpeg",
        [
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
      if (image.code === 0 && size(thumb)) {
        try {
          const fs = await import("node:fs");
          fs.copyFileSync(thumb, preview);
        } catch {}
        update(r, {
          thumbnailPath: thumb,
          previewPath: existsSync(preview) ? preview : undefined,
        });
      }
    } catch (e) {
      // Preview generation is optional after a validated recording. Never
      // downgrade a completed file because a thumbnail tool is unavailable.
      if (
        r.status === "completed" ||
        (r.status === "interrupted" && !existsSync(temp))
      )
        return;
      if (existsSync(temp)) r.filePath = temp;
      update(r, {
        status: "interrupted",
        error: e instanceof Error ? e.message : "Finalization failed",
        fileSize: size(temp),
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
      filePath = path.join(settings.recordingsPath, `${id}.${format}`);
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
      fileSize: 0,
      startedAt: now(),
      uploadedToCloud: false,
    };
    put("recordings", r);
    const capture = filePath + ".capture.ts";
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
    const child = spawn(
      fixture(u)
        ? (options.ffmpegPath ?? "ffmpeg")
        : (options.ytDlpPath ?? "yt-dlp"),
      args,
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry = { child, done, stop: false };
    processes.set(id, entry);
    child.once("error", (e) => {
      update(r, {
        status: "failed",
        error: `Recorder failed: ${e.message}`,
        completedAt: now(),
      });
    });
    child.once("spawn", () => update(r, { status: "recording" }));
    child.once("close", async (code) => {
      try {
        if (r.status !== "failed") await finish(r, code === 0 || entry.stop);
      } finally {
        processes.delete(id);
        resolveDone();
      }
    });
    broadcast("recording_update", dto(r));
    return r;
  }
  async function stopRecording(id: string) {
    const p = processes.get(id),
      r = get("recordings", id);
    if (!p || !r)
      throw Object.assign(Error("Recording is not active"), { status: 409 });
    p.stop = true;
    update(r, { status: "stopping" });
    if (fixture(new URL(r.url)) && p.child.stdin?.writable)
      p.child.stdin.write("q\n");
    else p.child.kill("SIGINT");
    const timer = setTimeout(() => p.child.kill("SIGTERM"), 5000);
    const force = setTimeout(() => p.child.kill("SIGKILL"), 12000);
    await p.done;
    clearTimeout(timer);
    clearTimeout(force);
    return get("recordings", id)!;
  }
  for (const r of all("recordings"))
    if (activeStates.includes(r.status)) {
      r.status = "interrupted";
      r.error = "Engine restarted during recording";
      r.completedAt = now();
      if (!existsSync(r.filePath) && existsSync(r.filePath + ".capture.ts")) {
        r.filePath = r.filePath + ".capture.ts";
        r.fileSize = size(r.filePath);
      }
      put("recordings", r);
    }
  api.use(requireAuth);
  api.get("/settings", (_req, res) => res.json(publicSettings()));
  api.put("/settings", (req, res) => {
    const next = { ...settings };
    for (const key of Object.keys(defaults))
      if (key in (req.body ?? {})) next[key] = req.body[key];
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
    for (const k of ["s3AccessKeyId", "s3SecretAccessKey"])
      if (k in req.body) {
        if (typeof req.body[k] !== "string")
          return err(res, 422, "Invalid credentials");
        secrets[k] = req.body[k];
      }
    settings = next;
    saveSettings();
    writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
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
    Object.assign(c, { isLive, lastChecked: now(), updatedAt: now() });
    put("channels", c);
    broadcast("channel_update", c);
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
        e instanceof Error ? e.message : "Invalid recording",
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
  function safeDelete(r: Obj) {
    if (r.managed !== true) {
      del("recordings", r.id);
      return;
    }
    for (const p of [r.filePath, r.previewPath, r.thumbnailPath])
      if (typeof p === "string" && existsSync(p)) {
        try {
          const root = realpathSync(path.dirname(r.filePath));
          const real = realpathSync(p);
          if (path.dirname(real) === root) unlinkSync(real);
        } catch {}
      }
    del("recordings", r.id);
  }
  api.delete("/recordings/:id", (req, res) => {
    const r = get("recordings", req.params.id);
    if (!r) return err(res, 404, "Recording not found");
    if (activeStates.includes(r.status))
      return err(res, 409, "Recording is active");
    safeDelete(r);
    return res.json({ ok: true });
  });
  api.post("/recordings/:id/upload", async (req, res) => {
    const r = get("recordings", req.params.id);
    if (!r) return err(res, 404, "Recording not found");
    if (activeStates.includes(r.status))
      return err(res, 409, "Recording is active");
    if (
      !settings.s3Enabled ||
      !settings.s3Bucket ||
      !secrets.s3AccessKeyId ||
      !secrets.s3SecretAccessKey
    )
      return err(res, 422, "S3 is not configured");
    try {
      const client = new S3Client({
        region: settings.s3Region,
        endpoint: settings.s3Endpoint || undefined,
        forcePathStyle: !!settings.s3Endpoint,
        credentials: {
          accessKeyId: secrets.s3AccessKeyId,
          secretAccessKey: secrets.s3SecretAccessKey,
        },
      });
      await new Upload({
        client,
        params: {
          Bucket: settings.s3Bucket,
          Key: `recordings/${r.id}.${r.format}`,
          Body: createReadStream(r.filePath),
        },
      }).done();
      update(r, { uploadedToCloud: true });
      return res.json({ uploadedToCloud: true });
    } catch {
      return err(res, 502, "Upload failed");
    }
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
    if (!file || !existsSync(file)) return err(res, 404, "Media not found");
    const t = token(),
      expiresAt = new Date(Date.now() + 300000).toISOString();
    tickets.set(hash(t), { file, kind, expiresAt });
    const addr = server.address() as AddressInfo;
    const base =
      mode === "docker"
        ? `http://${req.headers.host}`
        : `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
    return res.json({ url: `${base}/media/${t}`, expiresAt });
  });
  app.get("/media/:ticket", (req, res) => {
    const t = tickets.get(hash(req.params.ticket));
    if (!t || Date.parse(t.expiresAt) <= Date.now()) {
      tickets.delete(hash(req.params.ticket));
      return err(res, 403, "Ticket expired or invalid");
    }
    if (t.kind === "download")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="recording${path.extname(t.file)}"`,
      );
    return res.sendFile(path.resolve(t.file));
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
      for (const c of all("channels").filter(
        (c) => c.enabled && c.autoRecord,
      )) {
        if (stopping) break;
        try {
          if (
            (await check(c)) &&
            !stopping &&
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
            !activeStates.includes(r.status) &&
            r.completedAt &&
            Date.parse(r.completedAt) < cutoff
          )
            safeDelete(r);
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
  function importLegacy(file: string) {
    if (!path.isAbsolute(file))
      throw Error("Absolute legacy database path required");
    const legacy = new DatabaseSync(file, { readOnly: true });
    let channels = 0,
      recordings = 0;
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
          } catch {}
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
              filePath,
              fileSize: filePath ? size(filePath) : 0,
              duration: r.duration ?? undefined,
              startedAt: r.started_at ?? now(),
              completedAt: r.completed_at ?? now(),
              uploadedToCloud: !!r.uploaded_to_cloud,
            });
            recordings++;
          } catch {}
        }
        db.exec("COMMIT");
        return { channels, recordings };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      legacy.close();
    }
  }
  const local = {
    importLegacy,
    setRecordingsPath(p: string) {
      if (!path.isAbsolute(p)) throw Error("Absolute path required");
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
          const full = disk().usedPercent >= settings.maxDiskUsagePercent;
          for (const [id, p] of processes) {
            const r = get("recordings", id);
            if (r && r.status === "recording") {
              update(r, { fileSize: size(r.filePath + ".capture.ts") });
              if (full && !p.stop) void stopRecording(id);
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
        return;
      }
      stopping = true;
      if (monitorTimer) clearTimeout(monitorTimer);
      if (healthTimer) clearInterval(healthTimer);
      while (monitoring)
        await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.allSettled(
        [...processes.keys()].map((id) => stopRecording(id)),
      );
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      started = false;
    },
  };
}
