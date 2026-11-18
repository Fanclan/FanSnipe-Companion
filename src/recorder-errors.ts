import type { Readable } from "node:stream";

export const deniedSourceError =
  "The site denied access. Use a public stream available on this device.";
const offline = "This channel is offline. Try again when it is live.";
export const unknownSourceError =
  "The recorder could not read this stream. Check the public stream URL and try again.";

// Only return fixed messages. Extractor stderr can include private URLs and headers.
function describe(line: string): string | undefined {
  if (
    /room is (?:currently )?offline|(?:channel|stream) is (?:currently )?(?:offline|not live)|performer is currently away|(?:channel|user) is not currently live/i.test(
      line,
    )
  )
    return offline;
  if (
    /private show|private (?:video|stream)|(?:video|stream) is private|password.protected|hidden session|members.only|subscribers?.only|login required|sign in to (?:view|watch|confirm)|geo.restricted|not available in your country|HTTP Error (?:401|403|451)\b|403 Forbidden|DRM.protected/i.test(
      line,
    )
  )
    return deniedSourceError;
  if (/HTTP Error 429\b|429 Too Many Requests/i.test(line))
    return "The site is limiting requests. Wait before trying again.";
  if (
    /requested format is not available|no (?:video )?formats found/i.test(line)
  )
    return "The site did not offer a usable recording format. Try Best quality or another stream.";
  if (/unsupported url|unable to find stream url|HTTP Error 404\b/i.test(line))
    return "The site did not provide a playable stream at this URL. Check the channel or video link.";
  if (/no space left on device|disk quota exceeded/i.test(line))
    return "The recording folder is out of space. Free space and try again.";
  if (
    /timed out|temporary failure in name resolution|could not resolve host|connection (?:refused|reset)/i.test(
      line,
    )
  )
    return "The companion could not reach the stream. Check its network connection and try again.";
  if (
    /FanSnipe: recorder executable unavailable|ffmpeg could not be found|ffmpeg is not installed/i.test(
      line,
    )
  )
    return "The companion could not start its media tools. Check the installation.";
  return undefined;
}

export function readRecorderError(stderr: Readable | null) {
  let tail = "",
    message: string | undefined;
  stderr?.setEncoding("utf8");
  stderr?.on("data", (chunk: string) => {
    const text = tail + chunk;
    message = describe(text) ?? message;
    // Match a diagnostic split across pipe writes without keeping a transcript.
    tail = text.slice(-256);
  });
  stderr?.once("end", () => {
    tail = "";
  });
  return () => message;
}

export const isOfflineError = (message?: string) => message === offline;
