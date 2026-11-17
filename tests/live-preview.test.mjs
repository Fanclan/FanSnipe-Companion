import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEngine } from "../dist/app.js";

test(
  "a bounded local preview plays before and during capture; tickets obey ownership and revocation",
  { timeout: 80000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fansnipe-preview-"));
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    const generate = spawnSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=96x64:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440",
        "-t",
        "45",
        "-c:v",
        "mpeg2video",
        "-g",
        "10",
        "-c:a",
        "aac",
        "-f",
        "hls",
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        path.join(root, "movie.m3u8"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      generate.status,
      0,
      generate.error?.message || generate.stderr,
    );
    const master = await readFile(path.join(root, "movie.m3u8"), "utf8");
    let clock = Date.now();
    const source = createServer(async (req, res) => {
      const name = req.url.slice(1);
      if (name === "movie.m3u8") {
        const count = 4 + Math.floor((Date.now() - clock) / 450);
        return res
          .writeHead(200, { "content-type": "application/vnd.apple.mpegurl" })
          .end(
            master
              .replace("#EXT-X-ENDLIST", "")
              .split("#EXTINF:")
              .slice(0, count + 1)
              .join("#EXTINF:"),
          );
      }
      if (!/^movie\d+\.ts$/.test(name)) return res.writeHead(404).end();
      try {
        res
          .writeHead(200, { "content-type": "video/mp2t" })
          .end(await readFile(path.join(root, name)));
      } catch {
        res.destroy();
      }
    });
    await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + source.address().port;
    const engine = createEngine({
      port: 0,
      monitor: false,
      dataDir: path.join(root, "data"),
      ffmpegPath: ffmpeg,
      ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
      jobRunnerPath: process.env.JOB_RUNNER_PATH,
      fixtureOrigins: [origin],
    });
    try {
      const host = "http://127.0.0.1:" + (await engine.start()).port;
      const api = (route, method, body, token) =>
        fetch(host + "/api/v1" + route, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: "Bearer " + token } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const authenticate = async (name) => {
        const challenge = await (
          await api("/pairings", "POST", { name })
        ).json();
        engine.auth.approve(challenge.id);
        const { token } = await (
          await fetch(host + "/api/v1/pairings/" + challenge.id, {
            headers: { "x-pairing-token": challenge.pollToken },
          })
        ).json();
        return token;
      };
      const first = await authenticate("First browser"),
        second = await authenticate("Second browser");
      const ticket = async (body) => {
        const result = await api("/previews", "POST", body, first);
        assert.equal(result.status, 201, await result.clone().text());
        const value = await result.json();
        assert.ok(Date.parse(value.expiresAt) > Date.now());
        return value;
      };
      const readSegment = async (viewer) => {
        const playlist = new URL(viewer.url, host);
        assert.equal(playlist.origin, host);
        const result = await fetch(playlist);
        assert.equal(result.status, 200, await result.clone().text());
        const manifest = await result.text();
        const names = manifest
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith("#"));
        assert.ok(names.length > 0 && names.length <= 6, manifest);
        assert.ok(
          names.every((name) => /^seg\d+\.ts$/.test(name)),
          manifest,
        );
        const segment = await fetch(new URL(names.at(-1), playlist));
        assert.equal(segment.status, 200);
        const bytes = Buffer.from(await segment.arrayBuffer());
        const probe = spawnSync(
          process.env.FFPROBE_PATH || "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            "pipe:0",
          ],
          { input: bytes },
        );
        assert.equal(probe.status, 0);
        assert.deepEqual(
          JSON.parse(probe.stdout)
            .streams.map((x) => x.codec_type)
            .sort(),
          ["audio", "video"],
        );
        return { bytes, name: names.at(-1) };
      };
      const url = origin + "/movie.m3u8";
      assert.equal((await api("/previews", "POST", { url })).status, 401);
      assert.equal(
        (await api("/previews", "POST", { url: "file:///etc/passwd" }, first))
          .status,
        422,
      );
      assert.equal(
        (await api("/previews", "POST", { url, recordingId: "extra" }, first))
          .status,
        422,
      );
      clock = Date.now();
      const preview = await ticket({ url });
      const segment = await readSegment(preview);
      await delay(1800);
      assert.notEqual((await readSegment(preview)).name, segment.name);
      assert.deepEqual(
        await (await api("/recordings", "GET", undefined, first)).json(),
        [],
      );
      assert.equal(
        (await api("/previews/" + preview.id, "DELETE", undefined, second))
          .status,
        404,
      );
      assert.equal(
        (await api("/previews", "POST", { previewId: preview.id }, second))
          .status,
        404,
      );
      assert.equal(
        (
          await api(
            "/recordings/start",
            "POST",
            { url, quality: "invalid" },
            first,
          )
        ).status,
        422,
      );
      assert.equal(
        (await fetch(new URL(preview.url, host))).status,
        200,
        "Rejected recording must leave a live preview running",
      );
      const renewal = await ticket({ previewId: preview.id });
      assert.equal(renewal.id, preview.id);
      const record = await (
        await api(
          "/recordings/start",
          "POST",
          { url, format: "mp4", title: "Current capture" },
          first,
        )
      ).json();
      assert.ok(record.id);
      assert.equal((await fetch(new URL(renewal.url, host))).status, 403);
      const observer = await ticket({ recordingId: record.id });
      await readSegment(observer);
      assert.equal(
        (await api("/previews/" + observer.id, "DELETE", undefined, first))
          .status,
        200,
      );
      const reopened = await ticket({ recordingId: record.id });
      await readSegment(reopened);

      assert.equal(
        (await api("/sessions/revoke", "POST", {}, first)).status,
        200,
      );
      assert.equal((await fetch(new URL(reopened.url, host))).status, 403);
      const status = await (
        await api("/recordings/" + record.id, "GET", undefined, second)
      ).json();
      assert.equal(status.status, "recording");
      const stopped = await (
        await api("/recordings/" + record.id + "/stop", "POST", {}, second)
      ).json();
      assert.equal(stopped.status, "completed", stopped.error);
      assert.ok(stopped.fileSize > 0);
      await engine.stop();
      assert.deepEqual(
        await readdir(path.join(root, "data", ".live-previews")),
        [],
      );
    } finally {
      if (engine.server.listening) await engine.stop();
      source.closeAllConnections();
      await new Promise((resolve) => source.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
