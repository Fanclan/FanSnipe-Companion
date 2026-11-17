# FanSnipe protocol version 1

The local API is rooted at `/api/v1`. `/info` is public; operational routes require a paired bearer token. Pairing requests expire after two minutes and require approval by native local UI or Docker setup token. Media uses five-minute scoped tickets, and `/api/v1/events` authenticates its first WebSocket message. Credentials and recording filesystem paths are excluded from public recording responses.

`index.d.ts` defines public DTOs and `openapi.json` documents routes. This package is released independently from the desktop installer as a checksummed GitHub Release artifact. Both repositories pin the contract version. The v1 client accepts the historical `StreamSnipe` info name during migration as well as `FanSnipe`. Protocol-major changes require an explicit compatibility update; clients ignore unknown optional response fields.

Pairing: POST `/pairings` with `{name}`, poll GET `/pairings/:id` with `X-Pairing-Token`, then send `Authorization: Bearer ...` on operational calls. Native approval happens locally; Docker approval additionally requires its locally held `X-Setup-Token`. WebSockets at `/api/v1/events` require `{type:"auth",token}` as the first message within five seconds.

Ticket URLs are returned by POST `/recordings/:id/media-ticket` with a `kind`. They are short-lived credentials for local media, support HTTP Range, and must not appear in hosted logs or telemetry. Renew through the authenticated API while preserving playback position. Never put the long-lived browser credential in a URL.

Maintained by [zerodayprime](https://github.com/zerodayprime), by the team at [Fanclan.io](https://fanclan.io).
