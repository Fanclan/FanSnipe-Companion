// This worker and all of its children belong to the recorder's existing
// supervisor process group (or the Windows kill-on-close Job Object).
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export interface PreviewInput {
  url?: string;
  capture?: string;
  fixture?: boolean;
}
export interface PreviewTools {
  ffmpeg: string;
  ytDlp: string;
  jsRuntime?: string;
  ytDlpPrefix?: string[];
}

// Matroska needs its header/tracks, followed by complete clusters. TS is
// self-synchronizing and its programs repeat. Never scan an hours-long capture
// from the beginning just to join its live edge.
const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const liveWindow = 2 * 1024 * 1024;
async function followCapture(file: string, output: Writable) {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw Error("Capture is unavailable");
    let offset = 0;
    if (initial.size > liveWindow) {
      offset = initial.size - liveWindow;
      if (file.endsWith(".mkv")) {
        const head = Buffer.alloc(Math.min(256 * 1024, initial.size));
        await handle.read(head, 0, head.length, 0);
        const beginning = head.indexOf(cluster);
        const tail = Buffer.alloc(liveWindow);
        await handle.read(tail, 0, tail.length, offset);
        const boundary = tail.indexOf(cluster);
        if (beginning < 0 || boundary < 0)
          throw Error("Preview has no complete cluster yet");
        if (!output.write(head.subarray(0, beginning)))
          await once(output, "drain");
        offset += boundary;
      }
    }
    const buffer = Buffer.alloc(64 * 1024);
    while (!output.destroyed) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) {
        await delay(120);
        continue;
      }
      offset += bytesRead;
      // The stream can still hold this buffer when the next read begins.
      if (!output.write(Buffer.from(buffer.subarray(0, bytesRead))))
        await once(output, "drain");
    }
  } finally {
    await handle.close();
  }
}

const [directory, inputJson, toolsJson] = process.argv.slice(2);
const input: PreviewInput = JSON.parse(inputJson);
const tools: PreviewTools = JSON.parse(toolsJson);
async function main() {
  if (input.capture) {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const h = await open(
          input.capture,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          ready = (await h.stat()).size > 0;
        } finally {
          await h.close();
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (ready) break;
      await delay(200);
    }
    if (!ready) throw Error("Capture did not produce bytes");
  }
  const direct = input.fixture && !input.capture;
  const packager = spawn(
    tools.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...(!direct
        ? [
            "-protocol_whitelist",
            "pipe",
            "-analyzeduration",
            "1000000",
            "-probesize",
            "1048576",
          ]
        : []),
      "-i",
      direct ? input.url! : "pipe:0",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-map_metadata",
      "-1",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "6",
      "-hls_delete_threshold",
      "1",
      "-hls_flags",
      "delete_segments+temp_file",
      "-hls_segment_filename",
      path.join(directory, "seg%08d.ts"),
      path.join(directory, "live.m3u8"),
    ],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  const done = once(packager, "close");
  packager.stdin.on("error", () => {});
  if (input.capture) {
    void followCapture(input.capture, packager.stdin).catch(() =>
      packager.stdin.destroy(),
    );
  } else if (!direct) {
    // The same dedicated extractor as recording handles signed headers, split
    // audio/video, and source restrictions. Its stdout contains media only.
    const extractor = spawn(
      tools.ytDlp,
      [
        ...(tools.ytDlpPrefix ?? []),
        "--ignore-config",
        "--no-geo-bypass",
        "--no-plugin-dirs",
        "--no-playlist",
        "--no-live-from-start",
        "--no-progress",
        "--quiet",
        "--ffmpeg-location",
        tools.ffmpeg,
        ...(tools.jsRuntime
          ? ["--js-runtimes", "deno:" + tools.jsRuntime]
          : []),
        "--downloader",
        "ffmpeg",
        "--downloader-args",
        "ffmpeg_o:-f mpegts -flush_packets 1",
        "--merge-output-format",
        "mkv",
        "--fixup",
        "never",
        "-f",
        "b[vcodec^=avc]/bv[vcodec^=avc]+ba/b/bv+ba",
        "-o",
        "-",
        "--",
        input.url!,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    extractor.on("error", () => packager.stdin.destroy());
    extractor.stdout.pipe(packager.stdin);
  }
  const [code] = await done;
  // The outer supervisor owns and reaps any remaining source descendants.
  process.exit(code === 0 ? 0 : 1);
}
main().catch(() => process.exit(1));
