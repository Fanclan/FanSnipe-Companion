# Protocol version 1

The local API is rooted at `/api/v1`. `/info` is public; all other operational routes require a paired bearer token. Pairing requests expire after two minutes and require approval by native local UI or Docker setup token. Media uses five-minute scoped tickets, and `/api/v1/events` authenticates its first WebSocket message. Credentials and recording filesystem paths are excluded from public recording responses. See the integration contract in the migration project for route and DTO details.
