# Changelog

## 0.1.0-beta.4

- Team editor refreshes provider model catalogs when opened so newly available local CLI models can be assigned without restarting.
- Provider adapters now have golden transcript fixtures and bounded parse diagnostics with secret redaction and graceful fallback behavior.
- Provider health checklist distinguishes missing CLI, version too old, unparseable version (with diagnostic, not hard-fail), login not confirmed where detectable, and ready. Conservative minimums: Claude `2.1.187+`, Codex `0.142.5+`.
- Local append-only execution ledger (redacted, scoped, rotatable) with list/export APIs and a compact **Ledger** right-panel tab (JSON/CSV download).
- Provider-neutral **continuation capsules** for failed/cancelled/rate-limited/incomplete runs, with list/get/resume APIs and a **Resume with…** UI action (user-selected provider only; no automatic failover).
- Server-enforced **context policy** (`relevant-only` default, `metadata-only`, `full-workspace`) with sensitive-path exclusions, profile persistence, and accurate “local control with provider processing” labeling.
- **Evidence-based quality gates** (`lib/quality_gate.js`, versioned): rule-based `pass` / `blocked` / `incomplete` from acceptance criteria, check outcomes, structured review findings, diagnostics, worktree integration state, diffs, cancellation/provider failure, and human approval. Never model confidence %. Blocks integrate when mandatory evidence is incomplete/blocked unless an explicit `overrideReason` is recorded. Compact quality badge/panel in the Tasks UI.
- **Structured review verdicts**: strict `PASS` | `REQUEST_CHANGES` parser with bounded findings; unparseable output is incomplete (never guessed pass). Raw reviewer text stays in session history only.
- **Bounded repair loop** (opt-in `autoRepair` default **off**; `repairIterations` default 2, min 0, hard cap 5): on REQUEST_CHANGES for edit tasks, optional repair assigned to the original implementer. Stops on PASS, unchanged findings, max attempts, cancel, provider failure/rate limit, missing implementer, or human stop. Ledger transitions for quality/repair; continuation capsule on interrupt. No silent provider switching.
- Pinned development dependency `brace-expansion` to `1.1.16` via npm overrides (high-severity audit fix; no runtime dependency added).
- Per-session CSV export for troubleshooting, with spreadsheet-formula injection protection.
- Test runs use an isolated temporary data directory, preventing CI or local tests from touching real workspaces, profiles, sessions, tasks, keys, capsules, or ledgers.
- Fixed narrow activity-tab and mobile advanced-control overflow found during browser smoke testing.

## 0.1.0-beta.3

- Session task tracker: team plans create a durable project with per-step status, evidence, and a read-only **Tasks** right-panel tab (no manual status edits).
- Safer team delegation: explicit worktree integration, pending-change review, and Antigravity runs without `--dangerously-skip-permissions`.
- Persistent local profiles: export/import backup and restored UI preferences.
- Refreshed dashboard UI and dynamic model discovery from local CLIs.
- Google Antigravity as a first-class CLI provider with explicit workspace binding and sandbox mode.
- Provider transcript regression tests for Claude, Codex, Grok, Antigravity, and Gemini event normalization.
- Constant-time authentication token checks and real-path confinement for workspace file previews.

## 0.1.0-beta.2

- Updated Grok CLI adapter flags to match the current headless CLI.
- Removed stale internal `mmo` naming from worktree paths, branch prefixes, and browser storage keys.
- Documented that CLI-backed providers must run on the same machine as Crew Forge.

## 0.1.0-beta.1

- Public beta preparation for Crew Forge.
- Added local workspace add/forget controls.
- Added session sorting and resizable side panels.
- Added beta testing guide and public repo scaffolding.
- Added GitHub Actions CI.
- Changed project license posture to source-available, noncommercial use.
- Added tests for workspace add/remove.
