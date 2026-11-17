import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../dist/app.js";

test("channel admission stores dedicated extractor page URLs and rejects lookalikes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-platforms-"));
  const engine = createEngine({ dataDir: dir, monitor: false, port: 0 });
  try {
    const { port } = await engine.start();
    const api = `http://127.0.0.1:${port}/api/v1`;
    const pairing = await (
      await fetch(api + "/pairings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fixture" }),
      })
    ).json();
    assert.equal(engine.auth.approve(pairing.id), true);
    const { token } = await (
      await fetch(api + "/pairings/" + pairing.id, {
        headers: { "X-Pairing-Token": pairing.pollToken },
      })
    ).json();
    const add = (url) =>
      fetch(api + "/channels", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ url, name: "Fixture", enabled: false }),
      });
    for (const [url, platform, stored = url] of [
      ["https://www.picarto.tv/FanSnipeFixture", "picarto"],
      [
        "https://www.stripchat.com/FanSnipe_Fixture?ref=fixture#tracking",
        "stripchat",
        "https://stripchat.com/FanSnipe_Fixture",
      ],
      ["https://bongacams.com/fansnipe-fixture/", "bongacams"],
      ["https://m.youtube.com/watch?v=example", "youtube"],
      ["https://clips.twitch.tv/Example", "twitch"],
      ["https://kick.com/fansnipe-fixture", "kick"],
      ["https://en.chaturbate.com/fansnipe_fixture/", "chaturbate"],
    ]) {
      const res = await add(url);
      assert.equal(res.status, 201, url);
      const entity = await res.json();
      assert.equal(entity.platform, platform);
      assert.equal(entity.url, stored);
    }
    for (const url of [
      "https://picarto.tv.example.invalid/FanSnipeFixture",
      "https://bongacams.com@localhost/fansnipe-fixture",
      "https://untrusted.stripchat.com/FanSnipe_Fixture",
      "https://example.com/fixture",
      "https://picarto.tv:9443/FanSnipeFixture",
      "https://picarto.tv/FanSnipeFixture/private/file",
      "https://bongacams.com/",
      "https://stripchat.com/FanSnipe_Fixture/saved-show",
      "http://stripchat.com/FanSnipe_Fixture",
      "https://127.0.0.1/stream.m3u8",
    ])
      assert.equal((await add(url)).status, 422, url);
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
