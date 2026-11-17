// Exercise the real yt-dlp downloader, muxer and engine supervisor with synthetic
// metadata and loopback HLS tracks. This does not contact any platform.
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { createEngine } = process.env.ENGINE_MODULE_PATH
  ? await import(pathToFileURL(process.env.ENGINE_MODULE_PATH).href)
  : await import("../dist/app.js");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const directory = await mkdtemp(path.join(tmpdir(), "fansnipe-extractor-"));
const recordingsPath = path.join(directory, "recordings");
const metadataPath = path.join(directory, "source.json");
let engine;
let source;
const run = (tool, args) => {
  const { status, stdout, stderr, error } = spawnSync(tool, args, {
    encoding: "utf8",
  });
  assert.equal(status, 0, `${tool}: ${error?.message || stderr}`);
  return stdout;
};
try {
  const video = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12"];
  const audio = ["-f", "lavfi", "-i", "sine=frequency=450"];
  for (const [track, inputs] of [
    ["both", [...video, ...audio]],
    ["video", video],
    ["audio", audio],
  ]) {
    run(ffmpeg, [
      "-nostdin",
      "-y",
      "-v",
      "error",
      ...inputs,
      "-t",
      "32",
      "-c:v",
      "mpeg2video",
      "-g",
      "12",
      "-c:a",
      "aac",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      path.join(directory, track + ".m3u8"),
    ]);
  }
  let liveStart;
  source = http.createServer(async (req, res) => {
    const name = (req.url || "").slice(1);
    if (!/^(?:both|audio|video)(?:-open\.m3u8|\.m3u8|\d+\.ts)$/.test(name))
      return res.writeHead(404).end();
    try {
      if (name.endsWith("-open.m3u8")) {
        const list = await readFile(
          path.join(directory, name.replace("-open", "")),
          "utf8",
        );
        liveStart ??= Date.now();
        const count = 4 + Math.floor((Date.now() - liveStart) / 350);
        const parts = list.replace("#EXT-X-ENDLIST", "").split("#EXTINF:");
        return res
          .writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" })
          .end(parts.slice(0, count + 1).join("#EXTINF:"));
      }
      const file = path.join(directory, name);
      res.writeHead(200, {
        "Content-Type": name.endsWith(".ts")
          ? "video/mp2t"
          : "application/vnd.apple.mpegurl",
        "Content-Length": statSync(file).size,
      });
      createReadStream(file)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${source.address().port}`;
  engine = createEngine({
    dataDir: path.join(directory, "data"),
    recordingsPath,
    port: 0,
    monitor: false,
    ytDlpPath: process.env.YT_DLP_PATH || "yt-dlp",
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    jobRunnerPath: process.env.JOB_RUNNER_PATH,
    jsRuntimePath: process.env.JS_RUNTIME_PATH,
    testYtDlpPrefixArgs: ["--load-info-json", metadataPath],
  });
  const address = await engine.start();
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  let token;
  async function request(method, url, body, moreHeaders = {}) {
    const response = await fetch(base + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...moreHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${method} ${url}: ${response.status}`);
    return response.json();
  }
  const pair = await request("POST", "/pairings", {
    name: "Extractor fixture",
  });
  engine.auth.approve(pair.id);
  ({ token } = await request("GET", `/pairings/${pair.id}`, undefined, {
    "X-Pairing-Token": pair.pollToken,
  }));
  for (const [scenario, separate, stop, container] of [
    ["combined", false, false, "mp4"],
    ["split", true, false, "ts"],
    ["stop split", true, true, "mkv"],
  ]) {
    const formats = (separate ? ["video", "audio"] : ["both"]).map((track) => ({
      format_id: track,
      url: `${host}/${track}${stop ? "-open" : ""}.m3u8`,
      protocol: "m3u8_native",
      ext: "mp4",
      vcodec: track === "audio" ? "none" : "mpeg2video",
      acodec: track === "video" ? "none" : "aac",
      height: track === "audio" ? undefined : 90,
    }));
    await writeFile(
      metadataPath,
      JSON.stringify({
        extractor: "synthetic",
        extractor_key: "Synthetic",
        title: "Generated fixture",
        id: "test",
        webpage_url: "https://example.invalid/generated",
        is_live: true,
        formats,
      }),
    );
    // --load-info-json makes yt-dlp ignore the example page URL and read only loopback requests.
    const rec = await request("POST", "/recordings/start", {
      url: "https://www.twitch.tv/fixture",
      format: container,
      quality: "720p",
    });
    const file = path.join(recordingsPath, `${rec.id}.${container}`);
    let row;
    for (let i = 0; i < 300; i++) {
      row = await request("GET", "/recordings/" + rec.id);
      if (["failed", "completed", "interrupted"].includes(row.status)) break;
      const capture = file + ".capture.mkv";
      if (stop && existsSync(capture) && statSync(capture).size > 4096) {
        row = await request("POST", `/recordings/${rec.id}/stop`, {});
        break;
      }
      await delay(100);
    }
    assert.equal(
      row.status,
      "completed",
      `${scenario}: ${row.status}, ${row.error || ""}`,
    );
    assert.ok(row.fileSize > 0, scenario);
    const probed = JSON.parse(
      run(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        file,
      ]),
    );
    assert.deepEqual(
      probed.streams.map((x) => x.codec_type).sort(),
      ["audio", "video"],
      scenario,
    );
    console.log(
      `${scenario}: ${container} has audio and video, ${row.fileSize} bytes`,
    );
  }
} finally {
  if (engine) await engine.stop();
  if (source) await new Promise((resolve) => source.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
