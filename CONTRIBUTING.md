# Contributing to FanSnipe

FanSnipe is developed by the team at [Fanclan.io](https://fanclan.io) and maintained by [zerodayprime](https://github.com/zerodayprime).

Use a feature branch and a pull request. Explain the user-visible behavior, the failure or feature being addressed, and how it was verified. Keep dependencies and lockfiles synchronized.

Recording and security changes need meaningful regression tests. Use synthetic media and local fixtures. Test cancellation, restart, and invalid input when changing job lifecycles. Do not upload real recordings, private databases, credentials, or machine-specific configuration.

Run type checks, tests, and builds before requesting review. UI changes belong in [FanSnipe Portal](https://github.com/Fanclan/FanSnipe-Portal); companion releases consume a pinned dashboard artifact rather than maintaining another UI copy.

Protocol changes must be versioned and checked against supported portal versions. Release manifests must identify the exact source, dashboard, protocol, tool versions, and checksums. Publishing is handled by maintainers and trusted release workflows.
