# Security Policy

## Supported Versions

Only the latest release on `main` is actively maintained.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's [private vulnerability reporting](https://github.com/aisetsyoufree/crewforge/security/advisories/new) to report a security issue confidentially. You'll receive a response within 7 days.

Include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact

## Scope

Crew Forge runs entirely on localhost and does not transmit data to any Crew Forge servers. The relevant attack surface is:

- The local HTTP server (default port 4178, bound to 127.0.0.1)
- The `data/` directory (keys, sessions, teams stored on disk)
- CLI adapter invocations (Claude, Codex, Grok)

Out of scope: vulnerabilities in the upstream AI providers or their CLIs.
