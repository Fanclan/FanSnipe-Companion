import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../dist/app.js";

test("recorder distinguishes offline and denied streams without storing downloader stderr", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-recorder-errors-"));
  const fake = path.join(dir, "recorder.cjs");
  await writeFile(
    fake,
    `const source = process.argv.at(-1); const message = source.endsWith('/offline') ? 'Room is currently offline' : source.endsWith('/private') ? 'This video is private' : 'HTTP Error 403: Forbidden'; process.stderr.write('ERROR: [Chaturbate] secret-fixture-room: ');setTimeout(() => {process.stderr.write(message+' signedURL=private-test-value\\n');process.exitCode=1;}, 30);`,
  );
  const engine = createEngine({
    dataDir: dir,
    port: 0,
    monitor: false,
    ytDlpPath: process.execPath,
    testYtDlpPrefixArgs: [fake],
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
  });
  try {
    const { port } = await engine.start();
    const root = `http://127.0.0.1:${port}/api/v1`;
    const post = (url, data, headers = {}) =>
      fetch(root + url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    const p = await (
      await post("/pairings", { name: "Synthetic recorder failure" })
    ).json();
    engine.auth.approve(p.id);
    const { token } = await (
      await fetch(root + "/pairings/" + p.id, {
        headers: { "X-Pairing-Token": p.pollToken },
      })
    ).json();
    const headers = { authorization: `Bearer ${token}` };
    for (const [slug, expected] of [
      ["offline", /channel is offline/i],
      ["denied", /site denied access/i],
      ["private", /site denied access/i],
    ]) {
      const response = await post(
        "/recordings/start",
        { url: `https://chaturbate.com/${slug}` },
        headers,
      );
      assert.equal(response.status, 201);
      const { id } = await response.json();
      let row;
      for (let n = 0; n < 100; n++) {
        row = await (
          await fetch(root + "/recordings/" + id, { headers })
        ).json();
        if (row.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(row.status, "failed");
      assert.equal(row.fileSize, 0);
      assert.match(row.error, expected);
      assert.doesNotMatch(
        JSON.stringify(row),
        /signedURL|secret-fixture-room|private-test-value/,
      );
    }
  } finally {
    await engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
