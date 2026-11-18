import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Request, Response } from "express";
import type { PreviewInput, PreviewTools } from "./preview-worker.js";

const ticketLifetime = 5 * 60_000;
const idleLimit = 45_000;
const bufferLimit = 64 * 1024 * 1024;
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export class PreviewError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
interface Worker {
  directory: string;
  done: Promise<void>;
  stop: () => void;
  ended: boolean;
  closing?: Promise<void>;
}
interface View {
  id: string;
  owner: string;
  key: string;
  ticketHash: string;
  expires: number;
  lastRead: number;
  responses: Set<Response>;
}
interface Options extends PreviewTools {
  dataDir: string;
  lease: string;
  jobRunner?: string;
  sessionValid: (id: string) => boolean;
}
export class LivePreviews {
  private readonly dir: string;
  private readonly workers = new Map<string, Worker>();
  private readonly views = new Map<string, View>();
  private readonly tickets = new Map<string, View>();
  private timer?: NodeJS.Timeout;
  private opening = 0;
  private stopped = false;

  constructor(private options: Options) {
    this.dir = path.join(options.dataDir, ".live-previews");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.dir).isDirectory())
      throw Error("Invalid local preview directory");
    // Engine startup has already acquired the exclusive worker gate, so only
    // abandoned FanSnipe-generated buffers are eligible for cleanup here.
    for (const entry of readdirSync(this.dir, { withFileTypes: true }))
      if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
        rmSync(path.join(this.dir, entry.name), {
          recursive: true,
          force: true,
        });
  }
  private issue(view: View) {
    this.tickets.delete(view.ticketHash);
    const ticket = randomBytes(32).toString("base64url");
    view.ticketHash = digest(ticket);
    view.expires = Date.now() + ticketLifetime;
    view.lastRead = Date.now();
    this.tickets.set(view.ticketHash, view);
    return {
      id: view.id,
      url: `/preview-media/${ticket}/live.m3u8`,
      expiresAt: new Date(view.expires).toISOString(),
    };
  }
  renew(id: string, owner: string) {
    const view = this.views.get(id);
    if (
      !view ||
      view.owner !== owner ||
      view.expires <= Date.now() ||
      Date.now() - view.lastRead > idleLimit
    )
      throw new PreviewError(404, "Preview expired");
    return this.issue(view);
  }
  private worker(key: string, input: PreviewInput) {
    const current = this.workers.get(key);
    if (current && !current.closing) return current;
    if (current)
      throw new PreviewError(409, "Preview is switching sources. Try again.");
    if (this.workers.size >= 6)
      throw new PreviewError(429, "Too many active previews");
    if (process.platform === "win32" && !this.options.jobRunner)
      throw new PreviewError(503, "Preview tools unavailable");
    const directory = path.join(this.dir, randomUUID());
    mkdirSync(directory, { mode: 0o700 });
    const supervisor = fileURLToPath(
      new URL("./supervisor.js", import.meta.url),
    );
    const { ffmpeg, ytDlp, jsRuntime, ytDlpPrefix } = this.options;
    const child = spawn(
      process.platform === "win32" ? this.options.jobRunner! : process.execPath,
      [
        ...(process.platform === "win32" ? [] : [supervisor]),
        String(process.pid),
        this.options.lease,
        process.execPath,
        fileURLToPath(new URL("./preview-worker.js", import.meta.url)),
        directory,
        JSON.stringify(input),
        JSON.stringify({ ffmpeg, ytDlp, jsRuntime, ytDlpPrefix }),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    const done = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    const worker: Worker = {
      directory,
      done,
      ended: false,
      stop: () => child.stdin.end("stop\n"),
    };
    void done.then(() => {
      worker.ended = true;
    });
    this.workers.set(key, worker);
    this.timer ??= setInterval(() => this.sweep(), 1000).unref();
    return worker;
  }
  async create(
    owner: string,
    resolveTarget: () => { key: string; input: PreviewInput },
  ) {
    if (this.opening + this.views.size >= 32)
      throw new PreviewError(429, "Too many active previews");
    this.opening++;
    try {
      for (;;) {
        if (this.stopped)
          throw new PreviewError(503, "Engine is shutting down");
        if (!this.options.sessionValid(owner))
          throw new PreviewError(401, "Authentication required");
        const { key, input } = resolveTarget();
        const closing = this.workers.get(key)?.closing;
        if (closing) {
          // A page refresh releases the last viewer and immediately opens a new
          // one. Recheck the session and source after the previous process exits.
          await closing;
          continue;
        }
        this.worker(key, input);
        const view: View = {
          id: randomUUID(),
          owner,
          key,
          ticketHash: "",
          expires: 0,
          lastRead: 0,
          responses: new Set(),
        };
        this.views.set(view.id, view);
        return this.issue(view);
      }
    } finally {
      this.opening--;
    }
  }
  private forget(view: View) {
    this.tickets.delete(view.ticketHash);
    this.views.delete(view.id);
    for (const response of view.responses) response.destroy();
  }
  stopSource(key: string) {
    const w = this.workers.get(key);
    if (!w) return;
    if (w.closing) return w.closing;
    for (const view of this.views.values())
      if (view.key === key) this.forget(view);
    w.stop();
    w.closing = w.done.then(async () => {
      // File handles can take a moment to release on Windows.
      await rm(w.directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }).catch(() => {});
      this.workers.delete(key);
      if (!this.workers.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    });
    return w.closing;
  }
  close(id: string, owner: string) {
    const view = this.views.get(id);
    if (!view || view.owner !== owner) return false;
    this.forget(view);
    if (![...this.views.values()].some((v) => v.key === view.key))
      void this.stopSource(view.key);
    return true;
  }
  revoke(owner: string) {
    for (const view of this.views.values())
      if (view.owner === owner) this.close(view.id, owner);
  }
  private sweep() {
    const now = Date.now();
    for (const view of this.views.values())
      if (
        view.expires <= now ||
        now - view.lastRead > idleLimit ||
        !this.options.sessionValid(view.owner)
      )
        this.close(view.id, view.owner);
    for (const [key, w] of this.workers) {
      if (w.closing) continue;
      let bytes = 0;
      try {
        for (const file of readdirSync(w.directory))
          bytes +=
            statSync(path.join(w.directory, file), { throwIfNoEntry: false })
              ?.size ?? 0;
      } catch {
        void this.stopSource(key);
        continue;
      }
      if (bytes > bufferLimit) void this.stopSource(key);
    }
  }
  async serve(req: Request, res: Response) {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const key = digest(String(req.params.ticket));
    const view = this.tickets.get(key);
    const valid = () =>
      view &&
      this.tickets.get(key) === view &&
      view.expires > Date.now() &&
      this.options.sessionValid(view.owner);
    if (!view || !valid()) return res.status(403).end();
    const w = this.workers.get(view.key);
    const name = String(req.params.file);
    if (!w || (name !== "live.m3u8" && !/^seg\d{8,12}\.ts$/.test(name)))
      return res.status(404).end();
    if (view.responses.size >= 12) return res.status(429).end();
    view.responses.add(res);
    res.once("close", () => view.responses.delete(res));
    view.lastRead = Date.now();
    const file = path.join(w.directory, name);
    if (name === "live.m3u8") {
      const start = Date.now();
      while (
        !existsSync(file) &&
        !w.ended &&
        !w.closing &&
        !res.destroyed &&
        Date.now() - start < 25000
      )
        await delay(100);
    }
    if (res.destroyed) return;
    if (!valid()) return res.status(403).end();
    let handle;
    try {
      handle = await open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > bufferLimit)
        return res.status(404).end();
      if (!valid()) return res.status(403).end();
      res.type(
        name === "live.m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t",
      );
      res.setHeader("Content-Length", String(stat.size));
      const stream = handle.createReadStream();
      // The stream owns the open descriptor until this response finishes.
      handle = undefined;
      stream.on("error", () => res.destroy());
      res.once("close", () => stream.destroy());
      stream.pipe(res);
      return res;
    } catch {
      return res.status(name === "live.m3u8" ? 503 : 404).end();
    } finally {
      await handle?.close();
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.all(
      [...this.workers.keys()].map((key) => this.stopSource(key)),
    );
  }
}
