# FanSnipe security policy

The security boundary is the user's device. Fanclan does not receive or relay recordings. Local API access still requires authentication: loopback binding, CORS, and browser permission prompts are not substitutes for pairing.

Report vulnerabilities through this repository's **Security → Report a vulnerability** feature when available. If private reporting is unavailable, open a minimal issue asking for a private reporting channel without exploit details or sensitive information.

Never publish credentials, pairing tokens, media tickets, recording URLs containing access tokens, databases, private paths, or user media. Diagnostic exports should be reviewed and redacted before sharing.

Security fixes target the latest supported release. Compatibility and supported versions are declared in release manifests. Beta packages have not attained the assurance implied by a stable release and must not be described as signed unless their signatures have been verified.
