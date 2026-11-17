import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../dist/app.js";

test("pairing gates persistent settings and redacts credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-test-"));
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
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-hls-"));
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
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
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
    await post(base + "/sessions/revoke", {}, headers);
    assert.equal((await fetch(ticket.url)).status, 403);
  } finally {
    await engine.stop();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy import leaves source media intact and is idempotent", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-import-"));
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
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-security-"));
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
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-ws-"));
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
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-recovery-"));
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
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-remux-"));
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
  const wrapper = path.join(dir, "ffmpeg-wrapper.cjs");
  fs.writeFileSync(
    wrapper,
    'const {spawn}=require("node:child_process");const args=process.argv.slice(2);if(!args.includes("mpegts"))process.exit(1);const p=spawn("ffmpeg",args,{stdio:"inherit"});p.on("close",c=>process.exit(c ?? 1));',
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
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
    ffmpegPath: process.execPath,
    testFfmpegPrefixArgs: [wrapper],
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
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-stop-"));
  const fake = path.join(dir, "recorder.cjs");
  fs.writeFileSync(
    fake,
    'const {spawn}=require("node:child_process");const a=process.argv;const out=a[a.indexOf("-o")+1];const p=spawn("ffmpeg",["-y","-v","error","-re","-f","lavfi","-i","testsrc=size=160x90:rate=10","-c:v","mpeg2video","-flush_packets","1","-f","mpegts",out],{stdio:"ignore"});p.on("close",c=>process.exit(c??1));',
    { mode: 0o755 },
  );
  const engine = createEngine({
    dataDir: path.join(dir, "data"),
    port: 0,
    monitor: false,
    ytDlpPath: process.execPath,
    testYtDlpPrefixArgs: [fake],
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
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
    const capture = path.join(
      dir,
      "data",
      "recordings",
      `${r.id}.mkv.capture.mkv`,
    );
    let written = false;
    for (let i = 0; i < 200; i++) {
      try {
        if (fs.statSync(capture).size > 0) {
          written = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      written,
      true,
      "synthetic capture produced data before stopping",
    );
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

test("canonical catalog lease prevents a second constructor from changing live state", async () => {
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-lease-"));
  const catalog = path.join(dir, "catalog");
  fs.mkdirSync(catalog);
  const alias = path.join(dir, "alias");
  if (process.platform === "win32") fs.symlinkSync(catalog, alias, "junction");
  else fs.symlinkSync(catalog, alias);
  const first = createEngine({ dataDir: catalog, port: 0, monitor: false });
  try {
    assert.throws(
      () => createEngine({ dataDir: alias, port: 0, monitor: false }),
      /already in use/,
    );
  } finally {
    await first.stop();
  }
  const next = createEngine({ dataDir: alias, port: 0, monitor: false });
  await next.stop();
  await rm(dir, { recursive: true, force: true });
});

test("delayed live check never recreates a deleted channel", async () => {
  const http = await import("node:http");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-check-"));
  let release;
  const arrived = new Promise((resolve) => {
    release = resolve;
  });
  let finish;
  const fixture = http.createServer((_req, res) => {
    finish = () => res.end("#EXTM3U\n");
    release();
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const engine = createEngine({
    dataDir: dir,
    port: 0,
    monitor: false,
    fixtureOrigins: [origin],
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
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
    const c = await (
      await post(
        base + "/channels",
        { name: "test", url: origin + "/live.m3u8" },
        headers,
      )
    ).json();
    const pending = post(`${base}/channels/${c.id}/check`, {}, headers);
    await arrived;
    await fetch(`${base}/channels/${c.id}`, { method: "DELETE", headers });
    finish();
    await pending;
    assert.deepEqual(
      await (await fetch(base + "/channels", { headers })).json(),
      [],
    );
  } finally {
    await engine.stop();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3 destination approval is session-bound and invalid settings do not mutate credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-s3-approval-"));
  const engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const a = await engine.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`;
    const post = (url, body, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    async function session(name) {
      const p = await (await post(base + "/pairings", { name })).json();
      engine.auth.approve(p.id);
      const token = (
        await (
          await fetch(base + "/pairings/" + p.id, {
            headers: { "X-Pairing-Token": p.pollToken },
          })
        ).json()
      ).token;
      return {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
    }
    const h = await session("one"),
      other = await session("two");
    const destination = {
      s3Enabled: true,
      s3Bucket: "owned",
      s3Region: "us-east-1",
      s3Endpoint: "http://127.0.0.1:9000",
    };
    assert.equal(
      (
        await fetch(base + "/settings", {
          method: "PUT",
          headers: h,
          body: JSON.stringify({
            ...destination,
            s3AccessKeyId: "not-saved",
            s3SecretAccessKey: 123,
          }),
        })
      ).status,
      422,
    );
    const request = await (
      await post(base + "/settings/s3-approvals", destination, h)
    ).json();
    assert.equal(
      (
        await fetch(base + "/settings/s3-approvals/" + request.id, {
          headers: other,
        })
      ).status,
      404,
    );
    assert.equal(engine.local.listUploadApprovals().length, 1);
    assert.equal(engine.local.resolveUploadApproval(request.id, true), true);
    const result = await (
      await fetch(base + "/settings/s3-approvals/" + request.id, { headers: h })
    ).json();
    assert.equal(result.status, "approved");
    assert.equal(
      (
        await fetch(base + "/settings", {
          method: "PUT",
          headers: other,
          body: JSON.stringify({
            ...destination,
            uploadDestinationApproval: result.approvalToken,
          }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/settings", {
          method: "PUT",
          headers: h,
          body: JSON.stringify({
            ...destination,
            uploadDestinationApproval: result.approvalToken,
            s3SecretAccessKey: "secret",
          }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await fetch(base + "/settings", { headers: h })).json())
        .hasS3Credentials,
      false,
    );
    assert.equal(
      (
        await fetch(base + "/settings", {
          method: "PUT",
          headers: h,
          body: JSON.stringify({ s3Enabled: false }),
        })
      ).status,
      200,
    );
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("newer catalog schema is rejected without rewriting its version", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-future-"));
  const file = path.join(dir, "engine.sqlite");
  let db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=42");
  db.close();
  assert.throws(
    () => createEngine({ dataDir: dir, port: 0, monitor: false }),
    /Unsupported catalog version/,
  );
  db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 42);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("finalization crash prefers preserved capture over an unvalidated output", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-finalizing-"));
  let engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  await engine.stop();
  const root = fs.realpathSync(dir),
    file = path.join(root, "video.mp4"),
    capture = file + ".capture.ts",
    staging = file + ".finalizing.mp4";
  fs.writeFileSync(file, "incomplete");
  fs.writeFileSync(capture, "valid capture");
  fs.writeFileSync(staging, "incomplete staging");
  const db = new DatabaseSync(path.join(dir, "engine.sqlite"));
  db.prepare("INSERT INTO recordings VALUES (?,?)").run(
    "crash",
    JSON.stringify({
      id: "crash",
      managed: true,
      mediaRoot: root,
      filePath: file,
      capturePath: capture,
      stagingPath: staging,
      status: "finalizing",
      url: "https://www.twitch.tv/example",
      platform: "twitch",
      title: "crash",
      quality: "best",
      format: "mp4",
      fileSize: 0,
      startedAt: new Date().toISOString(),
      uploadedToCloud: false,
    }),
  );
  const published = path.join(root, "published.mp4"),
    publishedCapture = published + ".capture.ts";
  fs.writeFileSync(published, "validated output");
  fs.writeFileSync(publishedCapture, "old capture");
  db.prepare("INSERT INTO recordings VALUES (?,?)").run(
    "published",
    JSON.stringify({
      id: "published",
      managed: true,
      mediaRoot: root,
      filePath: published,
      outputPath: published,
      publishedPath: published,
      capturePath: publishedCapture,
      status: "finalizing",
      url: "https://www.twitch.tv/example",
      platform: "twitch",
      title: "published",
      quality: "best",
      format: "mp4",
      fileSize: 16,
      startedAt: new Date().toISOString(),
      uploadedToCloud: false,
    }),
  );
  db.close();
  engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  await engine.stop();
  const check = new DatabaseSync(path.join(dir, "engine.sqlite"), {
    readOnly: true,
  });
  const row = JSON.parse(
    check.prepare("SELECT data FROM recordings WHERE id=?").get("crash").data,
  );
  assert.equal(row.status, "interrupted");
  assert.equal(row.filePath, capture);
  assert.equal(fs.readFileSync(capture, "utf8"), "valid capture");
  const publishedRow = JSON.parse(
    check.prepare("SELECT data FROM recordings WHERE id=?").get("published")
      .data,
  );
  assert.equal(publishedRow.filePath, published);
  assert.equal(publishedRow.capturePath, publishedCapture);
  check.close();
  await rm(dir, { recursive: true, force: true });
});

test("automatic retention preserves unmanaged imported metadata", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-retention-"));
  let engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  await engine.stop();
  const db = new DatabaseSync(path.join(dir, "engine.sqlite"));
  db.prepare("INSERT INTO recordings VALUES (?,?)").run(
    "imported",
    JSON.stringify({
      id: "imported",
      managed: false,
      status: "completed",
      completedAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  db.prepare("INSERT INTO meta VALUES('settings',?)").run(
    JSON.stringify({ autoCleanupEnabled: true, autoCleanupDays: 1 }),
  );
  db.close();
  engine = createEngine({ dataDir: dir, port: 0 });
  await engine.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await engine.stop();
  const check = new DatabaseSync(path.join(dir, "engine.sqlite"), {
    readOnly: true,
  });
  assert.ok(
    check.prepare("SELECT id FROM recordings WHERE id=?").get("imported"),
  );
  check.close();
  await rm(dir, { recursive: true, force: true });
});

test("catalog lease excludes a separate process", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-lease-process-"));
  const engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const moduleUrl = new URL("../dist/app.js", import.meta.url).href;
    const code = `import {createEngine} from ${JSON.stringify(moduleUrl)};try{createEngine({dataDir:process.argv[1],port:0,monitor:false});process.exit(2)}catch(e){if(!String(e.message).includes('already in use'))process.exit(3)}`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", code, dir],
      { stdio: "ignore" },
    );
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0);
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("engine crash terminates recorder descendants", async () => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-crash-tree-"));
  const pidFile = path.join(dir, "child.pid"),
    childFile = path.join(dir, "child.cjs"),
    recorder = path.join(dir, "recorder.cjs");
  fs.writeFileSync(
    childFile,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  fs.writeFileSync(
    recorder,
    `require('child_process').spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
  );
  const appUrl = new URL("../dist/app.js", import.meta.url).href;
  const code = `import {createEngine} from ${JSON.stringify(appUrl)};const e=createEngine({dataDir:process.argv[1],port:0,monitor:false,ytDlpPath:process.execPath,testYtDlpPrefixArgs:[process.argv[2]],jobRunnerPath:process.env.JOB_RUNNER_PATH});const a=await e.start();const base='http://127.0.0.1:'+a.port+'/api/v1';const p=await(await fetch(base+'/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'crash'})})).json();e.auth.approve(p.id);const t=(await(await fetch(base+'/pairings/'+p.id,{headers:{'X-Pairing-Token':p.pollToken}})).json()).token;await fetch(base+'/recordings/start',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+t},body:JSON.stringify({url:'https://www.twitch.tv/test'})});setInterval(()=>{},1000)`;
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, path.join(dir, "data"), recorder],
    { stdio: "ignore", env: process.env },
  );
  let childPid;
  try {
    for (let i = 0; i < 100 && !childPid; i++) {
      try {
        childPid = Number(fs.readFileSync(pidFile, "utf8"));
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(childPid, "recorder descendant started");
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("close", resolve));
    let alive = true;
    for (let i = 0; i < 140; i++) {
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, "recorder descendant exited after engine crash");
  } finally {
    if (parent.exitCode === null) parent.kill("SIGKILL");
    if (childPid)
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("Docker setup token approves only the initiating session destination", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-docker-s3-"));
  const engine = createEngine({
    dataDir: dir,
    port: 0,
    mode: "docker",
    setupToken: "local-secret",
    monitor: false,
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
    async function session(name) {
      const p = await (await post(base + "/pairings", { name })).json();
      assert.equal(
        (
          await post(
            base + "/pairings/" + p.id + "/approve",
            {},
            { "X-Setup-Token": "local-secret" },
          )
        ).status,
        200,
      );
      return {
        authorization: `Bearer ${(await (await fetch(base + "/pairings/" + p.id, { headers: { "X-Pairing-Token": p.pollToken } })).json()).token}`,
      };
    }
    const one = await session("one"),
      two = await session("two");
    const dest = {
      s3Enabled: true,
      s3Bucket: "mine",
      s3Region: "us-east-1",
      s3Endpoint: "http://127.0.0.1:9000",
    };
    const p = await (
      await post(base + "/settings/s3-approvals", dest, one)
    ).json();
    assert.equal(
      (
        await post(
          base + `/settings/s3-approvals/${p.id}/approve`,
          {},
          { ...one, "X-Setup-Token": "wrong" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          base + `/settings/s3-approvals/${p.id}/approve`,
          {},
          { ...two, "X-Setup-Token": "local-secret" },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await post(
          base + `/settings/s3-approvals/${p.id}/approve`,
          {},
          { ...one, "X-Setup-Token": "local-secret" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await (
          await fetch(base + `/settings/s3-approvals/${p.id}`, { headers: one })
        ).json()
      ).status,
      "approved",
    );
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "Windows JobRunner waits for all job descendants after user stop",
  { skip: process.platform === "win32" ? false : "Windows Job Object test" },
  async () => {
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");
    const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-jobrunner-"));
    const pidFile = path.join(dir, "descendant.pid");
    const childFile = path.join(dir, "child.cjs"),
      parentFile = path.join(dir, "parent.cjs");
    fs.writeFileSync(
      childFile,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
    );
    fs.writeFileSync(
      parentFile,
      `require('child_process').spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
    );
    assert.ok(
      process.env.JOB_RUNNER_PATH,
      "Windows CI must provide JOB_RUNNER_PATH",
    );
    const { DatabaseSync } = await import("node:sqlite");
    const gatePath = path.join(dir, "gate.sqlite");
    const gate = new DatabaseSync(gatePath);
    gate.exec("CREATE TABLE gate(id INTEGER)");
    gate.close();
    const helper = spawn(
      process.env.JOB_RUNNER_PATH,
      [String(process.pid), gatePath, process.execPath, parentFile],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let pid;
    try {
      for (let i = 0; i < 100 && !pid; i++) {
        try {
          pid = Number(fs.readFileSync(pidFile, "utf8"));
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(pid, "job descendant started");
      helper.stdin.write("stop\n");
      const code = await new Promise((resolve) =>
        helper.once("close", resolve),
      );
      assert.equal(
        code,
        0,
        "helper reports an intentional stop after the job is empty",
      );
      assert.throws(
        () => process.kill(pid, 0),
        "job descendant has exited before helper returns",
      );
    } finally {
      if (helper.exitCode === null) helper.kill();
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("immediate restart waits for crashed engine recorder tree", async () => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-restart-lease-"));
  const data = path.join(dir, "data"),
    pidFile = path.join(dir, "writer.pid"),
    recorder = path.join(dir, "recorder.cjs");
  fs.writeFileSync(
    recorder,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);`,
  );
  const url = new URL("../dist/app.js", import.meta.url).href;
  const code = `import {createEngine} from ${JSON.stringify(url)};const e=createEngine({dataDir:process.argv[1],port:0,monitor:false,ytDlpPath:process.execPath,testYtDlpPrefixArgs:[process.argv[2]],jobRunnerPath:process.env.JOB_RUNNER_PATH});const a=await e.start(),b='http://127.0.0.1:'+a.port+'/api/v1';const p=await(await fetch(b+'/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'restart'})})).json();e.auth.approve(p.id);const t=(await(await fetch(b+'/pairings/'+p.id,{headers:{'X-Pairing-Token':p.pollToken}})).json()).token;await fetch(b+'/recordings/start',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+t},body:JSON.stringify({url:'https://www.twitch.tv/test'})});setInterval(()=>{},1000)`;
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, data, recorder],
    { stdio: "ignore", env: process.env },
  );
  let pid;
  try {
    for (let i = 0; i < 120 && !pid; i++) {
      try {
        pid = Number(fs.readFileSync(pidFile, "utf8"));
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(pid, "recorder started");
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("close", resolve));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    let next;
    if (alive) {
      try {
        next = createEngine({ dataDir: data, port: 0, monitor: false });
      } catch (error) {
        assert.match(String(error.message), /in use|still exiting/);
      }
      if (next) {
        let stillAlive = true;
        try {
          process.kill(pid, 0);
        } catch {
          stillAlive = false;
        }
        assert.equal(
          stillAlive,
          false,
          "startup must not recover while recorder remains alive",
        );
      }
    }
    for (let i = 0; i < 200 && !next; i++) {
      try {
        next = createEngine({ dataDir: data, port: 0, monitor: false });
      } catch {}
      if (!next) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(next, "restart succeeds after recorder exits");
    await next.stop();
  } finally {
    if (parent.exitCode === null) parent.kill("SIGKILL");
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("trailing-dot first-party S3 destinations are denied without touching source media", async () => {
  const fs = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-s3-root-dot-"));
  const root = fs.realpathSync(dir),
    media = path.join(root, "source.mp4");
  fs.writeFileSync(media, "original source");
  const engine = createEngine({
    dataDir: path.join(dir, "data"),
    port: 0,
    monitor: false,
  });
  try {
    const addr = await engine.start(),
      base = `http://127.0.0.1:${addr.port}/api/v1`;
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
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    for (const endpoint of [
      "https://streamsnipe-portal.vercel.app.",
      "https://fanclan.io.",
      "https://fansnipe.com.",
      "https://www.fansnipe.com.",
      "https://media.fansnipe.com.",
      "https://files.fanclan.io.",
      "https://vercel.com.",
    ]) {
      const dest = {
        s3Enabled: true,
        s3Bucket: "user-owned",
        s3Region: "us-east-1",
        s3Endpoint: endpoint,
      };
      assert.equal(
        (await post(base + "/settings/s3-approvals", dest, headers)).status,
        422,
      );
      assert.equal(
        (
          await fetch(base + "/settings", {
            method: "PUT",
            headers,
            body: JSON.stringify(dest),
          })
        ).status,
        422,
      );
    }
    const db = new DatabaseSync(path.join(dir, "data", "engine.sqlite"));
    const row = {
      id: "legacy",
      managed: false,
      mediaRoot: root,
      filePath: media,
      url: "https://www.twitch.tv/test",
      platform: "twitch",
      title: "source",
      status: "completed",
      quality: "best",
      format: "mp4",
      fileSize: 15,
      startedAt: new Date().toISOString(),
      uploadedToCloud: false,
    };
    db.prepare("INSERT INTO recordings VALUES(?,?)").run(
      "legacy",
      JSON.stringify(row),
    );
    db.close();
    assert.equal(fs.readFileSync(media, "utf8"), "original source");
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload rejects persisted trailing-dot endpoints before opening media", async () => {
  const fs = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-persisted-host-")),
    data = path.join(dir, "data"),
    source = path.join(dir, "source.mp4");
  fs.writeFileSync(source, "unchanged");
  let engine = createEngine({ dataDir: data, port: 0, monitor: false });
  await engine.stop();
  const db = new DatabaseSync(path.join(data, "engine.sqlite"));
  db.prepare("INSERT INTO meta VALUES ('settings',?)").run(
    JSON.stringify({
      s3Enabled: true,
      s3Bucket: "user-owned",
      s3Region: "us-east-1",
      s3Endpoint: "https://www.fansnipe.com.",
    }),
  );
  db.prepare("INSERT INTO recordings VALUES (?,?)").run(
    "r",
    JSON.stringify({
      id: "r",
      managed: false,
      mediaRoot: fs.realpathSync(dir),
      filePath: path.join(fs.realpathSync(dir), "missing.mp4"),
      url: "https://www.twitch.tv/test",
      platform: "twitch",
      title: "test",
      status: "completed",
      quality: "best",
      format: "mp4",
      fileSize: 0,
      startedAt: new Date().toISOString(),
      uploadedToCloud: false,
    }),
  );
  db.close();
  fs.writeFileSync(
    path.join(data, "secrets.json"),
    JSON.stringify({ s3AccessKeyId: "test", s3SecretAccessKey: "test" }),
    { mode: 0o600 },
  );
  engine = createEngine({ dataDir: data, port: 0, monitor: false });
  try {
    const a = await engine.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`;
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
    const result = await fetch(base + "/recordings/r/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(result.status, 422);
    assert.equal((await result.json()).error, "Invalid S3 endpoint");
    assert.equal(fs.readFileSync(source, "utf8"), "unchanged");
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
