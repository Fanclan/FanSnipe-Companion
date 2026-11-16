import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../dist/app.js";

test("pairing gates persistent settings and redacts credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-test-"));
  const engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const address = await engine.start();
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    assert.equal((await fetch(`${base}/settings`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/info`, {
          headers: { origin: `http://127.0.0.1:${address.port}` },
        })
      ).status,
      200,
    );
    const pairing = await (
      await fetch(`${base}/pairings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      })
    ).json();
    assert.equal(engine.auth.listPending()[0].id, pairing.id);
    engine.auth.approve(pairing.id);
    const { token } = await (
      await fetch(`${base}/pairings/${pairing.id}`, {
        headers: { "X-Pairing-Token": pairing.pollToken },
      })
    ).json();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    assert.equal(
      (
        await fetch(`${base}/settings`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            defaultQuality: "720p",
            s3AccessKeyId: "access",
            s3SecretAccessKey: "secret",
          }),
        })
      ).status,
      200,
    );
    const settings = await (
      await fetch(`${base}/settings`, { headers })
    ).json();
    assert.equal(settings.defaultQuality, "720p");
    assert.equal(settings.hasS3Credentials, true);
    assert.ok(!JSON.stringify(settings).includes("secret"));
    assert.equal(
      (
        await fetch(`${base}/channels`, {
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixture HLS is recorded, finalized and served with a scoped range ticket", async () => {
  const { spawnSync } = await import("node:child_process");
  const http = await import("node:http");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-hls-"));
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  const made = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=10",
    "-t",
    "2",
    "-c:v",
    "mpeg2video",
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    path.join(source, "index.m3u8"),
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const fixture = http.createServer((req, res) => {
    const filename = path.basename(
      new URL(req.url, "http://localhost").pathname,
    );
    const file = path.join(source, filename);
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const engine = createEngine({
    dataDir: path.join(dir, "data"),
    port: 0,
    monitor: false,
    fixtureOrigins: [origin],
  });
  try {
    const addr = await engine.start();
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const post = (url, body, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const pair = await (
      await post(base + "/pairings", { name: "test" })
    ).json();
    engine.auth.approve(pair.id);
    const { token } = await (
      await fetch(base + "/pairings/" + pair.id, {
        headers: { "X-Pairing-Token": pair.pollToken },
      })
    ).json();
    const headers = { authorization: `Bearer ${token}` };
    const channel = await (
      await post(
        base + "/channels",
        { name: "fixture", url: origin + "/index.m3u8" },
        headers,
      )
    ).json();
    assert.equal(
      (
        await (
          await post(`${base}/channels/${channel.id}/check`, {}, headers)
        ).json()
      ).isLive,
      true,
    );
    const r = await (
      await post(
        base + "/recordings/start",
        { url: origin + "/index.m3u8", format: "mkv", channelId: channel.id },
        headers,
      )
    ).json();
    let final;
    for (let i = 0; i < 100; i++) {
      final = await (
        await fetch(base + "/recordings/" + r.id, { headers })
      ).json();
      if (!["starting", "recording", "finalizing"].includes(final.status))
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(final.status, "completed", JSON.stringify(final));
    assert.ok(final.fileSize > 0);
    assert.ok(final.duration > 0);
    assert.equal("filePath" in final, false);
    const ticket = await (
      await post(
        `${base}/recordings/${r.id}/media-ticket`,
        { kind: "stream" },
        headers,
      )
    ).json();
    const media = await fetch(ticket.url, { headers: { range: "bytes=0-9" } });
    assert.equal(media.status, 206);
    assert.equal((await media.arrayBuffer()).byteLength, 10);
  } finally {
    await engine.stop();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy import leaves source media intact and is idempotent", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-import-"));
  const legacy = path.join(dir, "legacy.sqlite");
  const media = path.join(dir, "old.mp4");
  fs.writeFileSync(media, "legacy data");
  const db = new DatabaseSync(legacy);
  db.exec(
    "CREATE TABLE channels(id TEXT,name TEXT,url TEXT,platform TEXT,quality TEXT,auto_record INTEGER,enabled INTEGER,is_live INTEGER,last_checked TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE recordings(id TEXT,channel_id TEXT,url TEXT,platform TEXT,title TEXT,status TEXT,quality TEXT,format TEXT,file_path TEXT,file_size INTEGER,duration INTEGER,error TEXT,started_at TEXT,completed_at TEXT,uploaded_to_cloud INTEGER)",
  );
  db.prepare(
    "INSERT INTO recordings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "old",
    null,
    "https://www.twitch.tv/example",
    "twitch",
    "Old",
    "completed",
    "best",
    "mp4",
    media,
    11,
    1,
    null,
    "2025-01-01",
    "2025-01-01",
    0,
  );
  db.close();
  const engine = createEngine({
    dataDir: path.join(dir, "data"),
    port: 0,
    monitor: false,
  });
  try {
    assert.equal(engine.local.importLegacy(legacy).recordings, 1);
    assert.equal(engine.local.importLegacy(legacy).recordings, 0);
    assert.equal(fs.readFileSync(media, "utf8"), "legacy data");
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unapproved setup, expired or revoked sessions and forged tickets are rejected", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-security-"));
  const engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const addr = await engine.start();
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const post = (url, body, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const p = await (await post(base + "/pairings", { name: "test" })).json();
    assert.equal(
      (
        await post(
          `${base}/pairings/${p.id}/approve`,
          {},
          { "X-Setup-Token": "guess" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/info", {
          headers: { origin: "https://bad.vercel.app" },
        })
      ).status,
      403,
    );
    engine.auth.approve(p.id);
    const { token } = await (
      await fetch(`${base}/pairings/${p.id}`, {
        headers: { "X-Pairing-Token": p.pollToken },
      })
    ).json();
    const headers = { authorization: `Bearer ${token}` };
    assert.equal(
      (await fetch(`http://127.0.0.1:${addr.port}/media/..%2Fengine.sqlite`))
        .status,
      403,
    );
    const db = new DatabaseSync(path.join(dir, "engine.sqlite"));
    db.exec("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'");
    assert.equal((await fetch(base + "/settings", { headers })).status, 401);
    db.close();
    const p2 = await (
      await post(base + "/pairings", { name: "second" })
    ).json();
    engine.auth.approve(p2.id);
    const t2 = (
      await (
        await fetch(`${base}/pairings/${p2.id}`, {
          headers: { "X-Pairing-Token": p2.pollToken },
        })
      ).json()
    ).token;
    const h2 = { authorization: `Bearer ${t2}` };
    assert.equal((await post(base + "/sessions/revoke", {}, h2)).status, 200);
    assert.equal(
      (await fetch(base + "/settings", { headers: h2 })).status,
      401,
    );
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("revoking a session terminates its authenticated event socket", async () => {
  const { default: WebSocket } = await import("ws");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-ws-"));
  const engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const a = await engine.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`;
    const p = await (
      await fetch(base + "/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "socket" }),
      })
    ).json();
    engine.auth.approve(p.id);
    const { token } = await (
      await fetch(base + "/pairings/" + p.id, {
        headers: { "X-Pairing-Token": p.pollToken },
      })
    ).json();
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/api/v1/events`);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", token }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fetch(base + "/sessions/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const closed = await Promise.race([
      new Promise((resolve) => ws.once("close", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    if (!closed) ws.terminate();
    assert.equal(closed, true);
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart preserves partial capture and active jobs cannot be deleted", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-recovery-"));
  let engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  await engine.start();
  await engine.stop();
  const db = new DatabaseSync(path.join(dir, "engine.sqlite"));
  const file = path.join(dir, "partial.mp4");
  fs.writeFileSync(file + ".capture.ts", "partial");
  const record = {
    id: "partial",
    managed: true,
    filePath: file,
    url: "https://www.twitch.tv/example",
    platform: "twitch",
    title: "partial",
    status: "recording",
    quality: "best",
    format: "mp4",
    fileSize: 0,
    startedAt: new Date().toISOString(),
    uploadedToCloud: false,
  };
  db.prepare("INSERT INTO recordings VALUES(?,?)").run(
    record.id,
    JSON.stringify(record),
  );
  db.close();
  engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const addr = await engine.start();
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const p = await (
      await fetch(base + "/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      })
    ).json();
    engine.auth.approve(p.id);
    const { token } = await (
      await fetch(base + "/pairings/" + p.id, {
        headers: { "X-Pairing-Token": p.pollToken },
      })
    ).json();
    const headers = { authorization: `Bearer ${token}` };
    const recovered = await (
      await fetch(base + "/recordings/partial", { headers })
    ).json();
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.fileSize, 7);
    assert.equal("filePath" in recovered, false);
    assert.equal(fs.readFileSync(file + ".capture.ts", "utf8"), "partial");
    const other = new DatabaseSync(path.join(dir, "engine.sqlite"));
    record.id = "active";
    record.status = "recording";
    other
      .prepare("INSERT INTO recordings VALUES(?,?)")
      .run(record.id, JSON.stringify(record));
    other.close();
    assert.equal(
      (await fetch(base + "/recordings/active", { method: "DELETE", headers }))
        .status,
      409,
    );
    assert.ok(fs.existsSync(file + ".capture.ts"));
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("remux failure preserves the partial capture and reports interruption", async () => {
  const { spawnSync } = await import("node:child_process");
  const http = await import("node:http");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-remux-"));
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  const made = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=10",
    "-t",
    "2",
    "-c:v",
    "mpeg2video",
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    path.join(source, "index.m3u8"),
  ]);
  assert.equal(made.status, 0);
  const wrapper = path.join(dir, "ffmpeg-wrapper");
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\ncase "$*" in *mpegts*) exec ffmpeg "$@";; *) exit 1;; esac\n',
    { mode: 0o755 },
  );
  const fixture = http.createServer((req, res) => {
    const file = path.join(
      source,
      path.basename(new URL(req.url, "http://localhost").pathname),
    );
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const engine = createEngine({
    dataDir: path.join(dir, "data"),
    port: 0,
    monitor: false,
    fixtureOrigins: [origin],
    ffmpegPath: wrapper,
  });
  try {
    const a = await engine.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`;
    const post = (url, body, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const p = await (await post(base + "/pairings", { name: "test" })).json();
    engine.auth.approve(p.id);
    const { token } = await (
      await fetch(base + "/pairings/" + p.id, {
        headers: { "X-Pairing-Token": p.pollToken },
      })
    ).json();
    const headers = { authorization: `Bearer ${token}` };
    const r = await (
      await post(
        base + "/recordings/start",
        { url: origin + "/index.m3u8", format: "mkv" },
        headers,
      )
    ).json();
    let final;
    for (let i = 0; i < 100; i++) {
      final = await (
        await fetch(base + "/recordings/" + r.id, { headers })
      ).json();
      if (["interrupted", "failed"].includes(final.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(final.status, "interrupted");
    assert.ok(final.fileSize > 0);
    assert.equal(
      (
        await post(
          `${base}/recordings/${r.id}/media-ticket`,
          { kind: "download" },
          headers,
        )
      ).status,
      200,
    );
  } finally {
    await engine.stop();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop waits for capture exit and validated finalization", async () => {
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "streamsnipe-stop-"));
  const fake = path.join(dir, "recorder");
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; break; fi; shift; done\nexec ffmpeg -y -v error -re -f lavfi -i testsrc=size=160x90:rate=10 -c:v mpeg2video -f mpegts "$out"\n',
    { mode: 0o755 },
  );
  const engine = createEngine({
    dataDir: path.join(dir, "data"),
    port: 0,
    monitor: false,
    ytDlpPath: fake,
  });
  try {
    const a = await engine.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`;
    const post = (url, body, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const p = await (await post(base + "/pairings", { name: "test" })).json();
    engine.auth.approve(p.id);
    const { token } = await (
      await fetch(base + "/pairings/" + p.id, {
        headers: { "X-Pairing-Token": p.pollToken },
      })
    ).json();
    const headers = { authorization: `Bearer ${token}` };
    const r = await (
      await post(
        base + "/recordings/start",
        { url: "https://www.twitch.tv/example", format: "mkv" },
        headers,
      )
    ).json();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const stopped = await (
      await post(base + "/recordings/" + r.id + "/stop", {}, headers)
    ).json();
    assert.equal(stopped.status, "completed", JSON.stringify(stopped));
    assert.ok(stopped.fileSize > 0);
    assert.ok(stopped.duration > 0);
    assert.equal(
      (await (await fetch(base + "/status", { headers })).json())
        .activeRecordings,
      0,
    );
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
