# Disclaimer

Crew Forge is a personal learning project, built and shared as a learning exercise. It is provided as-is, with no guarantees that it will be secure, reliable, complete, or suitable for any particular use.

**This software is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, xAI, or Google.**

- "Claude", "Claude Code", and related marks are trademarks of Anthropic.
- "OpenAI", "Codex", and related marks are trademarks of OpenAI.
- "xAI", "Grok", "Grok Build", and related marks are trademarks of xAI.
- "Google", "Gemini", and related marks are trademarks of Google LLC.

Trademarks belong to their respective owners. See `TRADEMARKS.md`.

## How Crew Forge uses provider tools / ToS

Crew Forge runs locally and invokes each provider through that provider's official local tool or API using your own account:

- Claude Code CLI (`claude`) — official docs: https://docs.anthropic.com/en/docs/claude-code/overview
- OpenAI Codex CLI (`codex`) — official docs: https://developers.openai.com/codex/cli
- xAI Grok Build CLI (`grok`) — official docs: https://docs.x.ai/build/overview
- Google Gemini through your own API key — official docs: https://ai.google.dev/gemini-api/docs

Crew Forge does not extract, store, or reuse OAuth tokens. It does not proxy or resell provider access, and it does not bundle or modify provider CLIs.

Crew Forge is designed to stay on the documented path: it shells out to provider CLIs that the user installed and authenticated, or calls the documented Gemini API with a user-provided key. For example, OpenAI documents `codex exec` for non-interactive CLI workflows, xAI documents Grok Build headless mode for scripts and app integrations, Anthropic documents Claude Code as a terminal coding tool, and Google documents Gemini API access through API keys.

Crew Forge does not guarantee that any particular subscription, region, organization policy, rate limit, or account type permits your intended usage. You must respect provider terms, service terms, acceptable-use policies, quota limits, regional restrictions, and account rules. You are responsible for verifying that your own plan permits your intended use.

## Usage, responsibility, and warranty

The "Usage" panel and observed metrics show only the token, call, and cost information that passed through this dashboard. They do **not** represent your complete account balance, quota, or billing status. Always check the official provider dashboards and invoices for authoritative usage data.

This software is provided **"AS IS"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement.

Crew Forge is source-available for noncommercial use. It is not licensed for commercial resale, paid hosting, paid distribution, or substantially similar commercial products without prior written permission from the copyright holder. See `LICENSE` and `TRADEMARKS.md`.

This document is not legal advice.

**You are solely responsible for:**

- All actions taken by agents inside the workspaces you select.
- Any files created, modified, or deleted.
- Any commands executed.
- Any costs, overages, or account impacts incurred.
- Any data sent to Anthropic, OpenAI, xAI, Google, or other providers you configure.
- Any data leakage or security consequences resulting from prompt injection or agent behavior.

Use at your own risk.
