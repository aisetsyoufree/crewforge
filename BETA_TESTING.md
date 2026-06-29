# Beta Testing Crew Forge

Crew Forge is intended for technical beta testers who understand Git, local development, and the risks of AI agents running against source code.

## Recommended Test Setup

- Use a disposable or low-risk Git repository first.
- Commit or stash your work before testing Edit mode.
- Use a Git repository for Edit mode; non-Git folders are limited to planning/analysis.
- Keep test workspaces under your home folder and away from hidden credential/config directories.
- Start with one provider before testing teams.
- Prefer Plan mode until the workspace and provider behavior look correct.
- Keep provider dashboards available for authoritative usage and billing data.

## Preflight

- Confirm `node --version` is v18 or newer.
- Confirm `git status` works in the workspace you plan to add.
- Confirm the provider CLI you want to use is installed and logged in on the same machine running Crew Forge.
- Confirm the app opens on a `127.0.0.1` URL unless you intentionally configured remote access with `CREW_FORGE_AUTH_TOKEN` and opened it once with `?token=<value>`.
- Leave `Context Saver` on `Balanced` for normal testing. Try `Maximum` only on long sessions where older detail is less important.

## Updating From Earlier Local Builds

Crew Forge 0.1.0-beta.2 renamed old internal `mmo` local state to `crewforge`. This may reset small browser preferences such as onboarding, active team, and worktree branch names. If you tested earlier builds, remove stale `.mmo-worktrees/` directories from test repositories after saving any work you still need.

## Smoke Test Flow

1. Start Crew Forge with `npm start`.
2. Open the printed `127.0.0.1` URL.
3. Add a trusted Git workspace.
4. Send a Plan-mode prompt:

```text
Summarize this repository and suggest one safe improvement.
```

5. Confirm the response streams into the session.
6. Send a small Edit-mode prompt in a disposable repo:

```text
Add a short sentence to the README explaining the project purpose.
```

7. Confirm the Activity panel shows changed files and a diff.
8. Run **Review changes** with another provider if available.
9. Create a small team with a lead, a planner, and an engineer.
10. Delegate a small objective and verify that the plan can be reviewed before approval.

## What To Report

Please include:

- Operating system and Node.js version.
- Which providers were installed and used.
- Whether the provider was CLI-based or API-key based.
- The workspace type: Git repo, non-Git folder, new repo, large repo, etc.
- The exact action that failed.
- Terminal output if the server printed an error.
- Browser console errors if the UI failed.
- Whether the issue reproduced after restarting the app.

## High-Risk Areas

- Provider CLI stream-format changes.
- Edit-mode command execution.
- Long-running or stuck agent runs.
- Team delegation plans that choose the wrong member.
- Worktree creation and cleanup.
- Large diffs or large session histories.
- Non-Git folders, deleted folders, or moved workspaces.
- Rate-limit and quota handling.

## Expected Beta Behavior

It is acceptable for beta builds to ask for human review and approval often. It is not acceptable for the app to silently modify unrelated workspaces, expose the server to the network without explicit configuration, or hide provider errors.

## Clearing Local Data

Local state is stored in `data/`, which is ignored by Git. To reset the app locally:

```bash
rm -rf data/
```

This removes saved workspaces, sessions, teams, task projects, and stored API keys.
