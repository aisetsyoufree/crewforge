# Crew Forge

Local-first orchestration for AI coding agents using your own provider accounts.

**Personal learning project — source-available, noncommercial.**

Crew Forge is an experimental AI software team manager for developers. Give it a local workspace, connect your own AI coding tools, create model-backed team members, and coordinate planning, implementation, review, and QA from one browser UI.

Why: it gives technical users one local place to compare, coordinate, and review work from Claude, Codex, Grok, and Gemini without proxying provider access.

It runs on your machine. Provider calls still leave your machine when you use Claude, Codex, Grok, or Gemini.

This project is **source-available for noncommercial use**. It is public so developers can inspect it, download it, test it, modify it for noncommercial purposes, and give feedback. Commercial use, resale, paid hosting, or rebranding it as a competing commercial product requires prior written permission.

## Beta Status

Crew Forge is ready for limited beta testing by technical users who are comfortable with local CLIs, Git, and reviewing AI-generated changes.

Use it as a human-approved coding workspace, not as a fully autonomous engineer. Edit mode can run commands and modify files in the selected workspace.

## What It Can Do

- Add and forget local workspaces.
- Persist chat sessions per workspace.
- Stream model output, tool commands, file-change events, and usage signals.
- Run Plan mode for read-only analysis.
- Run Edit mode for providers that can modify files.
- Show Git activity, changed files, and diffs.
- Create teams with named members, roles, models, and skills.
- Assign a lead that creates delegation plans for team execution.
- Store durable task/project artifacts for the crew workflow.
- Use Git worktrees for edit-mode task isolation in the crew task engine.
- Ask another model to review uncommitted changes.
- Track observed usage from events that pass through the app.

## Disclaimer & Compliance

Read [DISCLAIMER.md](DISCLAIMER.md) before using Crew Forge. It explains the personal learning-project status, provider-tool usage, ToS caveats, warranty limits, and your responsibility for costs, data, and agent actions.

Provider and product names are used for identification only. See [TRADEMARKS.md](TRADEMARKS.md).

## Known Limitations

- This is beta software. Expect rough edges and provider-specific failures.
- Provider CLIs may change their flags or stream formats; adapters can break.
- The lead/crew workflow is early. It supports planning and task execution primitives, but the full team/task-board orchestration experience is still in progress.
- Human review is required. Do not trust generated code without reading diffs and running tests.
- Edit mode requires a Git workspace in this beta; use Plan mode for non-Git folders.
- Usage metrics are observed locally and are not authoritative billing data.
- Session history, workspace paths, teams, and API keys are stored locally under `data/` and are not encrypted.
- The app is local-first, but prompts, code snippets, diffs, and tool output may be sent to the selected provider.

## Requirements

- Node.js >= 18
- Git for workspace activity, diffs, reviews, and worktree isolation
- At least one supported provider:
  - Claude Code CLI (`claude`)
  - OpenAI Codex CLI (`codex`)
  - xAI Grok Build CLI (`grok` 0.2.72 or newer)
  - Gemini API key (`GEMINI_API_KEY` or the Connections panel)

## Quickstart

From a local checkout:

```bash
npm start
```

Open the local URL printed in the terminal, usually:

```text
Crew Forge -> http://127.0.0.1:4178  (local only)
```

To use a different port:

```bash
node server.js 3000
```

## Where To Run It

Run Crew Forge on the same machine that has:

- the Git workspaces you want agents to inspect or edit
- authenticated provider CLIs for Claude, Codex, or Grok
- any local credentials those CLIs need

A Raspberry Pi can run the Node server if Node.js, Git, and the provider tools are installed and authenticated on the Pi. It does **not** currently orchestrate Claude/Codex/Grok CLIs running on a different Mac. If the app runs on a Pi while the authenticated CLIs and target repos live on your Mac, CLI-backed providers will not work as expected. Gemini API mode can run anywhere that has network access and a valid API key.

## First Run

1. Open the app.
2. Check provider readiness in the onboarding or Connections panel.
3. Add a trusted Git workspace.
4. Start in **Plan (read-only)** mode.
5. Use **Edit** mode only after you understand the risks.
6. Review the Activity panel and Git diff before accepting changes.

See [ONBOARDING.md](ONBOARDING.md) for a fuller walkthrough.

## Beta Testing

See [BETA_TESTING.md](BETA_TESTING.md) for the suggested tester flow, what to report, and known risk areas.

## Security

Crew Forge can browse folders you select and can run edit-capable agents inside those workspaces. Treat it like a powerful local terminal.

Read [SECURITY.md](SECURITY.md), [DISCLAIMER.md](DISCLAIMER.md), and [TRADEMARKS.md](TRADEMARKS.md) before using it on important repositories.

By default the folder picker stays inside your home folder and hides sensitive credential/config directories. Remote binding requires an explicit auth token and is not recommended for beta testers; use `?token=<value>` once to establish a browser session.

## Development

```bash
npm test
```

The app intentionally has no runtime dependencies. The server is a small Node HTTP app, the UI is vanilla HTML/CSS/JS, and persistent local state lives under ignored `data/`.

## License

Source-available for noncommercial use under the PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE).
