import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../dist/app.js";

test("API identifies the new brand while keeping protocol version 1", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-brand-"));
  const engine = createEngine({ dataDir: dir, port: 0, monitor: false });
  try {
    const addr = await engine.start();
    const info = await (
      await fetch(`http://127.0.0.1:${addr.port}/api/v1/info`)
    ).json();
    assert.equal(info.name, "FanSnipe");
    assert.equal(info.version, "0.1.4");
    assert.equal(info.protocolVersion, 1);
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("server resolves legacy catalogs in place and respects new overrides", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "fansnipe-home-"));
  try {
    const mod = await import("../dist/server-config.js").catch(() => ({}));
    assert.equal(typeof mod.resolveServerConfig, "function");
    const legacy = path.join(home, ".streamsnipe");
    await mkdir(legacy);
    await writeFile(path.join(legacy, "engine.sqlite"), "legacy");
    assert.equal(mod.resolveServerConfig({}, home).dataDir, legacy);
    assert.equal(
      mod.resolveServerConfig({ STREAMSNIPE_MODE: "docker" }, home).mode,
      "docker",
    );
    assert.equal(
      mod.resolveServerConfig(
        { FANSNIPE_MODE: "desktop", STREAMSNIPE_MODE: "docker" },
        home,
      ).mode,
      "desktop",
    );
    const fresh = path.join(home, ".fansnipe");
    await mkdir(fresh);
    await writeFile(path.join(fresh, "engine.sqlite"), "new");
    assert.equal(mod.resolveServerConfig({}, home).dataDir, fresh);
    assert.equal(
      mod.resolveServerConfig({ DATA_DIR: "/explicit" }, home).dataDir,
      "/explicit",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy catalog retains channels, settings and paired sessions after rebrand", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  const home = await mkdtemp(path.join(tmpdir(), "fansnipe-existing-"));
  const legacy = path.join(home, ".streamsnipe");
  let seed;
  try {
    seed = createEngine({ dataDir: legacy, port: 0, monitor: false });
    await seed.stop();
    seed = null;
    const db = new DatabaseSync(path.join(legacy, "engine.sqlite"));
    const channel = {
      id: "old-channel",
      name: "Existing",
      url: "https://www.twitch.tv/example",
      platform: "twitch",
      quality: "best",
      autoRecord: false,
      enabled: true,
      isLive: false,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    db.prepare("INSERT INTO channels VALUES(?,?)").run(
      channel.id,
      JSON.stringify(channel),
    );
    db.prepare("INSERT INTO meta VALUES('settings',?)").run(
      JSON.stringify({ defaultQuality: "720p" }),
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "old-session",
      createHash("sha256").update("legacy-token").digest("hex"),
      "Existing browser",
      "2025-01-01T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
    );
    db.close();
    const { resolveServerConfig } = await import("../dist/server-config.js");
    const engine = createEngine({
      dataDir: resolveServerConfig({}, home).dataDir,
      port: 0,
      monitor: false,
    });
    try {
      const a = await engine.start(),
        base = `http://127.0.0.1:${a.port}/api/v1`,
        headers = { authorization: "Bearer legacy-token" };
      const channels = await (
        await fetch(base + "/channels", { headers })
      ).json();
      assert.equal(channels[0].id, "old-channel");
      assert.equal(
        (await (await fetch(base + "/settings", { headers })).json())
          .defaultQuality,
        "720p",
      );
      assert.equal((await fetch(base + "/sessions", { headers })).status, 200);
    } finally {
      await engine.stop();
    }
  } finally {
    if (seed) await seed.stop();
    await rm(home, { recursive: true, force: true });
  }
});
