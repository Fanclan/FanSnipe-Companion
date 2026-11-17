// Run inside the packaged Linux image with --network none and
// --add-host chaturbate.com:127.0.0.1. The real extractor sees only generated fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import { lookup } from "node:dns/promises";
import { networkInterfaces, tmpdir } from "node:os";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEngine } from "/opt/fansnipe/dist/app.js";

assert.ok(
  Object.values(networkInterfaces())
    .flat()
    .every((i) => i.internal),
  "Requires --network none",
);
assert.equal((await lookup("chaturbate.com")).address, "127.0.0.1");
const dir = mkdtempSync(path.join(tmpdir(), "fansnipe-extractor-"));
const file = (name) => path.join(dir, name);
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
let roomCalls = 0;
let roomStatus = "public";
let mediaServer, site, engine;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      "1",
      "-subj",
      "/CN=chaturbate.com",
      "-addext",
      "subjectAltName=DNS:chaturbate.com",
      "-keyout",
      file("key.pem"),
      "-out",
      file("cert.pem"),
    ],
    { stdio: "ignore" },
  );
  // Both networking backends in the packaged yt-dlp have a trust root for this closed network.
  process.env.SSL_CERT_FILE = file("cert.pem");
  process.env.REQUESTS_CA_BUNDLE = file("cert.pem");
  process.env.CURL_CA_BUNDLE = file("cert.pem");
  for (const [name, input, codec] of [
    ["video", "testsrc2=size=320x180:rate=12", "mpeg2video"],
    ["audio", "sine=frequency=440:sample_rate=44100", "aac"],
  ]) {
    execFileSync(process.env.FFMPEG_PATH, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      input,
      "-t",
      "4",
      "-c",
      codec,
      ...(name === "video" ? ["-g", "12"] : []),
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      file(name + ".m3u8"),
    ]);
  }
  writeFileSync(
    file("master.m3u8"),
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="mp4v.61,mp4a.40.2",AUDIO="a"',
      "video.m3u8",
      "",
    ].join("\n"),
  );
  mediaServer = http((req, res) => {
    const name = req.url.slice(1);
    if (
      !/^(?:master\.m3u8|(?:video|audio)(?:\.m3u8|\d+\.ts))$/.test(name) ||
      !existsSync(file(name))
    )
      return res.writeHead(404).end();
    res.setHeader(
      "Content-Type",
      name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
    );
    res.end(readFileSync(file(name)));
  });
  await listen(mediaServer, 0);
  const playlist =
    "http://127.0.0.1:" + mediaServer.address().port + "/master.m3u8";
  site = https(
    {
      cert: readFileSync(file("cert.pem")),
      key: readFileSync(file("key.pem")),
    },
    (req, res) => {
      if (req.method !== "POST" || req.url !== "/get_edge_hls_url_ajax/")
        return res.writeHead(404).end();
      roomCalls++;
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          room_status: roomStatus,
          url: roomStatus === "public" ? playlist : "",
        }),
      );
    },
  );
  await listen(site, 443);
  engine = createEngine({
    mode: "docker",
    dataDir: file("catalog"),
    recordingsPath: file("media"),
    monitor: false,
    port: 0,
    ytDlpPath: process.env.YT_DLP_PATH,
    ffmpegPath: process.env.FFMPEG_PATH,
    ffprobePath: process.env.FFPROBE_PATH,
    jsRuntimePath: process.env.JS_RUNTIME_PATH,
  });
  const base = "http://127.0.0.1:" + (await engine.start()).port + "/api/v1";
  let token;
  async function api(route, body, hdr = {}) {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...hdr,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok, route + " " + r.status);
    return r.json();
  }
  const p = await api("/pairings", { name: "Packaged extraction QA" });
  assert.ok(engine.auth.approve(p.id));
  token = (
    await api("/pairings/" + p.id, undefined, {
      "X-Pairing-Token": p.pollToken,
    })
  ).token;
  async function record() {
    const start = await api("/recordings/start", {
      url: "https://chaturbate.com/fansnipe-fixture/",
      format: "mp4",
    });
    for (let i = 0; i < 200; i++) {
      const row = await api("/recordings/" + start.id);
      if (["completed", "failed", "interrupted"].includes(row.status))
        return row;
      await delay(150);
    }
    throw Error("Recording did not finalize");
  }
  const row = await record();
  assert.ok(
    roomCalls > 0,
    "Packaged extractor did not reach the closed-network site fixture",
  );
  assert.equal(row.status, "completed", row.error);
  assert.ok(row.fileSize > 0);
  const video = file("media/" + row.id + ".mp4");
  const probe = JSON.parse(
    execFileSync(
      process.env.FFPROBE_PATH,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type:format=duration",
        "-of",
        "json",
        video,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(probe.streams.map((s) => s.codec_type).sort(), [
    "audio",
    "video",
  ]);
  assert.ok(Number(probe.format.duration) > 3);
  roomStatus = "private";
  const restricted = await record();
  assert.equal(restricted.status, "failed");
  assert.equal(restricted.fileSize, 0);
  assert.match(restricted.error, /private|restricted|access/i);
  console.log(
    JSON.stringify({
      extractor: "Chaturbate",
      siteResponses: "synthetic",
      network: "loopback only",
      streams: ["video", "audio"],
      duration: probe.format.duration,
      bytes: row.fileSize,
      restricted: restricted.error,
    }),
  );
} finally {
  if (engine) await engine.stop();
  for (const s of [site, mediaServer])
    if (s) {
      s.closeAllConnections();
      s.close();
    }
  rmSync(dir, { recursive: true, force: true });
}
