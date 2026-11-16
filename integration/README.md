# Distribution and soak checks

Build the engine, provide FFmpeg/FFprobe on PATH (or `FFMPEG_PATH`/`FFPROBE_PATH`), then run:

```sh
npm run build
SOAK_SECONDS=30 node integration/soak.mjs
node integration/soak.mjs
```

The first command is a short smoke test; the default is a real eight-hour run with three concurrent synthetic live HLS recordings. The report labels short runs `smoke`, never `release-soak`. It records the engine SHA256, runtime, platform, samples, and final FFprobe results. Reports and generated media are written to a temporary directory unless `SOAK_DIRECTORY` is provided. Never commit their contents.

The release gate requires successful reports for the packaged macOS, Windows, and Docker runtimes. A development-engine report alone does not establish packaged installer behavior. GitHub-hosted jobs have execution-time limits; use an appropriately provisioned runner for an uninterrupted eight-hour Windows check rather than treating shorter runs as equivalent.
