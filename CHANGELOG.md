# Changelog

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
