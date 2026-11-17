import { platformForUrl } from "./platforms.js";

export interface SourceInspection {
  platform: string;
  status:
    "live" | "available" | "offline" | "unknown" | "restricted" | "unsupported";
  title?: string;
  creator?: string;
  reason?: string;
}

// yt-dlp projects these fields before writing JSON. Signed stream URLs and headers
// must never leave the downloader or be copied into the catalog or browser.
export const displayTemplate =
  "%(.{title,creator,channel,uploader,live_status,is_live})j";

export function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim().slice(0, 200);
  return text && text !== "NA" ? text : undefined;
}

export function projectedSource(
  url: URL,
  row: Record<string, unknown>,
): SourceInspection {
  const platform = platformForUrl(url);
  const creator =
    displayText(row.creator) ??
    displayText(row.channel) ??
    displayText(row.uploader);
  const title = displayText(row.title);
  if (row.live_status === "is_upcoming")
    return {
      platform,
      title,
      creator,
      status: "offline",
      reason: "This broadcast has not started yet.",
    };
  return {
    platform,
    title,
    creator,
    status:
      row.is_live === true || row.live_status === "is_live"
        ? "live"
        : "available",
  };
}

export function recordingTitle(
  url: URL,
  info?: SourceInspection,
  savedName?: string,
) {
  if (info?.title) return info.title;
  const platform = platformForUrl(url);
  const parts = url.pathname.split("/").filter(Boolean);
  const handle =
    platform === "youtube"
      ? parts.find((part) => part.startsWith("@"))
      : parts[0];
  const name =
    info?.creator ??
    displayText(savedName) ??
    displayText(handle) ??
    (platform === "other" ? "Stream" : platform);
  return (
    name +
    " · " +
    new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  ).slice(0, 200);
}

export function createInspectionCache(
  inspect: (url: URL) => Promise<SourceInspection>,
) {
  const cache = new Map<
    string,
    { expires: number; source: SourceInspection }
  >();
  const pending = new Map<string, Promise<SourceInspection>>();
  const peek = (url: URL) => {
    const entry = cache.get(url.href);
    return entry && entry.expires > Date.now() ? entry.source : undefined;
  };
  return {
    peek,
    inspect(url: URL, refresh = false): Promise<SourceInspection> {
      const active = pending.get(url.href);
      if (active) return active;
      const hit = !refresh && peek(url);
      if (hit) return Promise.resolve(hit);
      if (pending.size >= 4)
        throw Object.assign(
          new Error("Source checks are busy. Try again shortly."),
          { status: 429 },
        );
      const task = inspect(url)
        .then((source) => {
          cache.delete(url.href);
          if (cache.size >= 128) cache.delete(cache.keys().next().value!);
          cache.set(url.href, {
            expires:
              Date.now() +
              (source.status === "live" || source.status === "available"
                ? 30000
                : 3000),
            source,
          });
          return source;
        })
        .finally(() => pending.delete(url.href));
      pending.set(url.href, task);
      return task;
    },
    async drain() {
      await Promise.allSettled([...pending.values()]);
    },
  };
}
