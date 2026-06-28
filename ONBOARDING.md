# Crew Forge Onboarding

This guide walks a new user from zero to a working Crew Forge session. All steps are short and copy-paste friendly.

## 1. Install Node.js

- Download the LTS version from https://nodejs.org (or use your package manager).
- Verify:

```bash
node --version   # should be v18 or newer
npm --version
```

## 2. Install and log in to the CLIs

Run Crew Forge on the same machine where your target repositories and authenticated CLI tools live. A Pi-hosted dashboard cannot use Claude/Codex/Grok CLIs that are only installed and logged in on a Mac. Install and authenticate those CLIs on the Pi too, or run Crew Forge on the Mac.

You need **at least one** of `claude`, `codex`, or `grok` on your PATH. Install each you plan to use according to its official instructions, then authenticate.

**Claude Code CLI**

Follow the official install (often `claude` is provided via their installer or package). Then sign in:

```bash
claude          # first run — follow the browser prompts to sign in
# or
claude login
```

**OpenAI Codex CLI**

Install via the official script (macOS/Linux example):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Authenticate:

```bash
codex login
```

**xAI Grok Build CLI**

Install:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Log in (uses your SuperGrok or X Premium+ subscription):

```bash
grok login --device-auth
```

Follow the browser OAuth flow. A token is stored locally for the CLI. Crew Forge expects Grok Build CLI 0.2.72 or newer for headless runs.

## 3. (Optional) Add a Gemini API key

Gemini is used via the Google API and is text-only (no file editing). You can also set `GEMINI_API_KEY` in your environment, but the easiest path is the built-in Connections panel:

1. Start the app (step 4 below).
2. Click the **Connections** button (gear icon) in the top bar.
3. Enter your Gemini API key and save.

Keys are stored locally in `data/keys.json` (gitignored) and sent only to Google's API.

## 4. Start the app

From the project folder (the directory that contains `server.js`):

```bash
npm start
```

To use a different port:

```bash
node server.js 3000
```

The terminal will print a local URL such as:

```
Crew Forge -> http://127.0.0.1:4178  (local only)
```

Open that URL in your browser.

## 5. Add your first workspace folder

- Click **+ Add folder** in the left sidebar.
- Browse and select a local folder. **Use a git repository** — the Activity panel (changed files, diff viewer) and **Review changes** feature rely on `git status` / `git diff`. Non-git folders work for chat and Edit mode, but Activity and review are limited.
- The workspace appears in the selector and becomes active.
- The right sidebar will show git changes and a diff once files are modified.

## 6. Send a first message in Plan mode

- Pick a model (e.g. Claude · sonnet).
- Make sure **Plan (read-only)** is selected in the mode toggle.
- Type a task in the composer, e.g.:

```
List the main source files and suggest a small refactor.
```

- Press **Send** (or Cmd/Ctrl+Enter).
- Watch the feed: status messages, reasoning (collapsible), final message. Commands are shown but the agent is restricted to read-only tools.

## 7. Try Edit mode

- Switch the mode toggle to **Edit (can change files)**.
- **Warning**: the agent can now run shell commands and modify files inside the chosen workspace.
- Send a small, safe task, e.g.:

```
Add a short comment at the top of the README explaining the project purpose.
```

- Monitor the Activity panel (right sidebar) — changed files appear, and you can click them or "View diff".
- You can refresh or watch the live diff.

## 8. Build a Team and delegate

- Click **+ New** next to Team.
- Give the team a name (e.g. "Refactor crew").
- Add seats:
  - Choose an adapter + model for each member.
  - Give each a role (e.g. "planner", "implementer", "reviewer").
  - Mark one radio as Lead.
- Save the team.
- Select the team in the Team dropdown.
- The **Delegate to team** button appears.
- Type a request and click **Delegate to team**.
- The lead (in Plan mode) proposes a step-by-step plan as JSON. The plan appears in a review box.
- Edit tasks if desired, then click **Approve**.
- Each step runs in sequence (models that support edit will use Edit mode; text-only models run as analysis).
- Watch the feed and Activity panel for progress.

## 9. Run a cross-model review

- Make (or keep) some uncommitted changes in your workspace.
- Click **Review changes** in the Activity header.
- Pick a reviewer model (different from the one that made the changes is often useful).
- Click **Go**.
- The reviewer receives the git diff and produces a concise review with a final **APPROVE** or **REQUEST CHANGES** line.
- Results stream into the chat feed as a system/agent turn.

That's it. You are ready to test Crew Forge with human-reviewed changes.
