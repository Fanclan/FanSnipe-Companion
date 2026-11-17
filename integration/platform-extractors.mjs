// Run in the packaged Linux image with --network none. Map usher.ttvnw.net and
// edge-hls.fixture.invalid to 127.0.0.1 with --add-host for HLS over local TLS.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

if (
  Object.values(networkInterfaces())
    .flat()
    .some((iface) => !iface.internal)
) {
  throw new Error(
    "Run this fixture in a disposable container with --network none",
  );
}
const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-extractors-"));
const exec = promisify(execFile);
const room = "FanSnipeFixture";
const username = room.toLowerCase();
const manifests = {
  bongacams: `/hls/stream_${room}/playlist.m3u8`,
  kick: "/kick/master.m3u8",
  picarto: "/picarto/master.m3u8",
  stripchat: "/hls/123/master/123_auto.m3u8",
  twitch: `/api/channel/hls/${username}.m3u8`,
  youtube: "/youtube/master.m3u8",
};
const received = new Set();
function playlist(req, res) {
  const pathname = req.url.split("?")[0];
  if (!Object.values(manifests).includes(pathname))
    return res.writeHead(404).end();
  received.add(pathname);
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
  res.end(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n360p.m3u8\n",
  );
}
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
const server = createServer(playlist);
let tls;
await listen(server, 0);
const local = `http://127.0.0.1:${server.address().port}`;
const fixture = (filename, data) =>
  writeFile(
    path.join(dir, filename),
    typeof data === "string" ? data : JSON.stringify(data),
  );
const run = (url) =>
  exec(
    process.env.YT_DLP_PATH || "yt-dlp",
    [
      "--ignore-config",
      "--no-plugin-dirs",
      "--compat-options",
      "no-certifi", // Use the generated trust root only inside this isolated test.
      "--js-runtimes",
      "deno:" + process.env.JS_RUNTIME_PATH,
      "--load-pages",
      "--no-cache-dir",
      "--no-playlist",
      "--socket-timeout",
      "2",
      "--retries",
      "0",
      "--extractor-retries",
      "0",
      "--simulate",
      "--print",
      "%(extractor_key)s %(live_status)s",
      "--",
      url,
    ],
    { cwd: dir, timeout: 15000 },
  );
const offline = (url) =>
  assert.rejects(
    run(url),
    (e) =>
      e.code === 1 &&
      /not currently live|not live|stream is offline/i.test(e.stderr),
  );
const live = async (url, key, manifest) => {
  assert.equal((await run(url)).stdout.trim(), key + " is_live");
  if (manifest)
    assert.ok(
      received.has(manifest),
      key + " did not read its fixture HLS master",
    );
};

try {
  const tlsHosts = ["usher.ttvnw.net", "edge-hls.fixture.invalid"];
  for (const name of tlsHosts)
    assert.equal((await lookup(name)).address, "127.0.0.1");
  const cert = path.join(dir, "fixture.crt"),
    key = path.join(dir, "fixture.key");
  await exec("openssl", [
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-days",
    "1",
    "-subj",
    "/CN=fixture.invalid",
    "-addext",
    "subjectAltName=" + tlsHosts.map((name) => "DNS:" + name).join(","),
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  for (const variable of [
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
  ])
    process.env[variable] = cert;
  tls = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    playlist,
  );
  await listen(tls, 443);

  // Filenames include the request body digest or truncated URL used by yt-dlp 2026.10.26.
  const twitchUrl = "https://www.twitch.tv/" + username;
  const twitchMetadata =
    username +
    "_03f789d588da9ba6afb3260c52b3e034_https_-_gql.twitch.tv_gql.dump";
  await fixture(twitchMetadata, [{ data: { user: { stream: null } } }]);
  await offline(twitchUrl);
  await fixture(twitchMetadata, [
    { data: { user: { stream: { id: "123", type: "live" } } } },
  ]);
  await fixture(
    username +
      "_795487e28ef670351d871c74a7572653_https_-_gql.twitch.tv_gql.dump",
    {
      data: {
        streamPlaybackAccessToken: { value: "fixture", signature: "fixture" },
      },
    },
  );
  await live(twitchUrl, "TwitchStream", manifests.twitch);

  const kickUrl = "https://kick.com/" + username;
  const kickMetadata =
    username + "_https_-_kick.com_api_v2_channels_" + username + ".dump";
  await fixture(kickMetadata, { livestream: null });
  await offline(kickUrl);
  await fixture(kickMetadata, {
    livestream: { id: 123, session_title: "FanSnipe fixture" },
    playback_url: local + manifests.kick,
  });
  await live(kickUrl, "Kick", manifests.kick);

  const youtubeId = "A1b2C3d4E5f";
  const youtubeUrl = "https://www.youtube.com/watch?v=" + youtubeId;
  async function youtube(player) {
    const watch =
      youtubeId +
      "_https_-_www.youtube.com_watchv=" +
      youtubeId +
      "_bpctr=9999999999_has_verified=1.dump";
    await fixture(
      watch,
      "<script>var ytInitialPlayerResponse = " +
        JSON.stringify(player) +
        ";</script>" +
        '<script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":{}}};</script>',
    );
    await fixture(
      youtubeId + "_https_-_www.youtube.com_iframe_api.dump",
      "// Fixture iframe API",
    );
    for (const digest of [
      "a8f7856e034a72ea0558a40adac887c6",
      "1395839a5b622af4d9f2ba7547b57fdb",
    ]) {
      await fixture(
        youtubeId +
          "_" +
          digest +
          "_https_-_www.youtube.com_youtubei_v1_playerprettyPrint=false.dump",
        player,
      );
    }
  }
  const videoDetails = {
    videoId: youtubeId,
    title: "FanSnipe fixture",
    isLive: true,
    isLiveContent: true,
  };
  await youtube({
    videoDetails,
    playabilityStatus: {
      status: "LOGIN_REQUIRED",
      reason: "This video is private",
    },
  });
  await assert.rejects(
    run(youtubeUrl),
    (e) => e.code === 1 && /This video is private/i.test(e.stderr),
  );
  await youtube({
    videoDetails,
    playabilityStatus: { status: "OK" },
    streamingData: { hlsManifestUrl: local + manifests.youtube },
  });
  await live(youtubeUrl, "Youtube", manifests.youtube);

  const picartoMetadata =
    room +
    "_https_-_ptvintern.picarto.tv_ptvapiquery=%7B%0A++channel%28name%3A+%22FanSnipeFixture%22%29+%7B%0A++++adult%0A++++id%0A++++online%0A++++stream_name%0A++++title%0A++%7D%0A++getLoadBalancerU___e035fa85314624e87bac81e7d1d3478b.dump";
  await fixture(picartoMetadata, {
    data: {
      channel: { online: 1, stream_name: "qa", title: "Fixture" },
      getLoadBalancerUrl: { url: "https://fixture.invalid" },
    },
  });
  await fixture(room + "_https_-_fixture.invalid_stream_json_qa.js.dump", {
    source: [
      {
        type: "html5/application/vnd.apple.mpegurl",
        url: local + manifests.picarto,
      },
    ],
  });
  await live("https://picarto.tv/" + room, "Picarto", manifests.picarto);
  await fixture(picartoMetadata, { data: { channel: { online: 0 } } });
  await assert.rejects(
    run("https://picarto.tv/" + room),
    (e) => e.code === 1 && /Stream is offline/i.test(e.stderr),
  );

  await fixture(
    room +
      "_4cac845c945b33d2b873cb43ca2f6e8d_https_-_bongacams.com_tools_amf.php.dump",
    {
      localData: { videoServerUrl: local },
      performerData: { username: room, displayName: "Fixture" },
    },
  );
  await live("https://bongacams.com/" + room, "BongaCams", manifests.bongacams);

  const stripchat = "https://stripchat.com/" + room;
  const state = (viewCam) =>
    fixture(
      room + "_https_-_stripchat.com_" + room + ".dump",
      "<script>window.__PRELOADED_STATE__ = " +
        JSON.stringify({
          viewCam,
          config: { data: { hlsStreamHost: "fixture.invalid" } },
        }) +
        ";</script>",
    );
  await state({ model: { isLive: false } });
  await assert.rejects(
    run(stripchat),
    (e) => e.code === 1 && /not currently live|not live/i.test(e.stderr),
  );
  await state({ model: { isLive: true }, show: { type: "private" } });
  await assert.rejects(
    run(stripchat),
    (e) => e.code === 1 && /private show/i.test(e.stderr),
  );
  await state({ model: { isLive: true, id: 123 } });
  await live(stripchat, "Stripchat", manifests.stripchat);
  console.log(
    "Offline real-extractor fixtures passed: Twitch and Kick live/offline, YouTube live/private, Picarto live/offline, BongaCams live, Stripchat live/private/offline.",
  );
} finally {
  tls?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
