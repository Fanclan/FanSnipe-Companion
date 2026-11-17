interface PageRule {
  platform: string;
  host: RegExp;
  path?: RegExp;
}

// Existing domains retain their historical subdomain and path handling.
const singleChannel = /^\/[\w-]+\/?$/;
const pages: PageRule[] = [
  { platform: "twitch", host: /^(?:[\w-]+\.)*twitch\.tv$/ },
  { platform: "youtube", host: /^(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)$/ },
  { platform: "kick", host: /^(?:[\w-]+\.)*kick\.com$/ },
  { platform: "chaturbate", host: /^(?:[\w-]+\.)*chaturbate\.com$/ },
  { platform: "picarto", host: /^(?:www\.)?picarto\.tv$/, path: singleChannel },
  {
    platform: "stripchat",
    host: /^(?:www\.)?stripchat\.com$/,
    path: /^\/[\w-]+(?:@[\w-]+)?\/?$/,
  },
  {
    platform: "bongacams",
    host: /^(?:www\.)?bongacams\.com$/,
    path: singleChannel,
  },
];

function pageRule(url: URL) {
  return pages.find((page) => page.host.test(url.hostname));
}

export function platformForUrl(url: URL): string {
  return pageRule(url)?.platform ?? "other";
}

export function validateStreamUrl(
  input: unknown,
  fixtureOrigins: readonly string[] = [],
): URL {
  if (typeof input !== "string" || input.length > 2048)
    throw Error("Invalid URL");
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Invalid URL");
  if (fixtureOrigins.includes(url.origin)) return url;
  const rule = pageRule(url);
  if (!rule) throw Error("Unsupported URL");
  if (url.protocol !== "https:") throw Error("HTTPS required");
  if (rule.path) {
    if (url.port || !rule.path.test(url.pathname))
      throw Error("Use a supported public video or channel page URL");
    // These extractors identify the stream entirely by its path.
    url.search = "";
    url.hash = "";
    if (rule.platform === "stripchat") url.hostname = "stripchat.com";
  }
  return url;
}
