import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../dist/app.js";

test("paste inspection and manual capture use display metadata on all seven platforms", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-source-"));
  const tool = path.join(dir, "fake.cjs");
  const calls = path.join(dir, "checks");
  await writeFile(
    tool,
    `
const fs = require("node:fs");
const url = process.argv.at(-1);
if (process.argv.includes("--skip-download")) fs.appendFileSync(${JSON.stringify(calls)}, "inspect\\n");
if (url.endsWith("/offline")) {console.error("Room is currently offline");process.exit(1);}
if (url.endsWith("/private")) {console.error("This video is private");process.exit(1);}
const metadata = {title:"Evening broadcast",uploader:"Studio Host",live_status:"is_live",formats:[{url:"secret-media-link"}]};
if(url.endsWith("/untitled")) delete metadata.title;
process.stdout.write(JSON.stringify(metadata) + "\\n");
`,
  );
  const engine = createEngine({
    dataDir: dir,
    port: 0,
    monitor: false,
    ytDlpPath: process.execPath,
    testYtDlpPrefixArgs: [tool],
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
  });
  try {
    const { port } = await engine.start();
    const base = "http://127.0.0.1:" + port + "/api/v1";
    let token;
    const post = (route, body) =>
      fetch(base + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token && { authorization: "Bearer " + token }),
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post("/sources/inspect", { url: "https://twitch.tv/example" }))
        .status,
      401,
    );
    const pairing = await (
      await post("/pairings", { name: "Generated source checks" })
    ).json();
    engine.auth.approve(pairing.id);
    token = (
      await (
        await fetch(base + "/pairings/" + pairing.id, {
          headers: { "X-Pairing-Token": pairing.pollToken },
        })
      ).json()
    ).token;
    const inspect = async (url) => {
      const res = await post("/sources/inspect", { url });
      assert.equal(res.status, 200);
      return res.json();
    };
    for (const [platform, url] of Object.entries({
      twitch: "https://twitch.tv/example",
      youtube: "https://www.youtube.com/watch?v=example0001",
      kick: "https://kick.com/example",
      chaturbate: "https://chaturbate.com/example",
      stripchat: "https://stripchat.com/example",
      bongacams: "https://bongacams.com/example",
      picarto: "https://picarto.tv/example",
    })) {
      const [a, b] = await Promise.all([inspect(url), inspect(url)]);
      assert.equal(a.platform, platform);
      assert.equal(a.status, "live");
      assert.equal(a.title, "Evening broadcast");
      assert.equal(a.creator, "Studio Host");
      assert.deepEqual(a, b);
      assert.doesNotMatch(JSON.stringify(a), /secret-media-link|formats/);
    }
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 7);
    assert.equal(
      (await inspect("https://twitch.tv/offline")).status,
      "offline",
    );
    assert.equal(
      (await inspect("https://youtube.com/private")).status,
      "restricted",
    );
    assert.equal(
      (await inspect("https://example.com/channel")).status,
      "unsupported",
    );
    const untitled = await inspect("https://twitch.tv/untitled");
    assert.match(untitled.title, /^Studio Host · /);
    const get = async (id) =>
      (
        await fetch(base + "/recordings/" + id, {
          headers: { authorization: "Bearer " + token },
        })
      ).json();
    for (const [url, title, expected] of [
      ["https://twitch.tv/example", undefined, "Evening broadcast"],
      ["https://twitch.tv/example", "My cut", "My cut"],
      ["https://twitch.tv/fresh", undefined, "Evening broadcast"],
      ["https://twitch.tv/untitled", undefined, untitled.title],
    ]) {
      const res = await post("/recordings/start", { url, title });
      assert.equal(res.status, 201);
      const started = await res.json();
      let row = started;
      for (
        let i = 0;
        i < 100 && !["completed", "failed"].includes(row.status);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 40));
        row = await get(started.id);
      }
      assert.equal(row.title, expected);
    }
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
