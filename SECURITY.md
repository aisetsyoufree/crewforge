# Security

Crew Forge is a **local-first** tool. Treat it with the same care you would a powerful terminal.

Report vulnerabilities privately through GitHub Security Advisories if the repository enables them. Otherwise, contact the maintainer privately before opening a public issue.

## Binding and network exposure

- The server listens exclusively on `127.0.0.1` (loopback). It is never reachable from other machines on your network by default.
- Do **not** set `CREW_FORGE_HOST=0.0.0.0` or proxy/port-forward the port. Overriding the bind address exposes a **code-execution surface** to your network — the folder browser and Edit-mode agents can read paths you give them and run arbitrary shell commands. Only bind to loopback unless you fully understand and accept that risk.
- The folder browser and agents can read any path you give them — only run the dashboard on a trusted machine.

## Repository maintainer checklist

- Keep only the deploy keys that are actively needed. For this repository, a single repo-scoped write deploy key is enough for publishing from the local machine; remove unused personal SSH deploy keys after the push succeeds.
- Prefer deploy keys over broad personal access tokens. If a token is ever used, make it fine-grained, repo-scoped, short-lived, and rotate it after publishing.
- Enable GitHub security features before inviting testers: private vulnerability reporting, secret scanning, Dependabot alerts, and branch protection for `main`.
- Do not grant write access to public testers. Ask testers to open issues or pull requests; repository owners decide what gets merged.

## Edit mode and code execution

- **EDIT mode** lets the selected agent run arbitrary shell commands (`Bash`, exec, etc.) and modify files inside the chosen workspace.
- Use Edit mode **only with workspaces you fully trust**.
- The combination of a folder picker + agent code execution is intentionally powerful; it is effectively a controlled terminal running inside your repo.
- Never point the dashboard at a sensitive directory (e.g. `~`, `/`, production checkouts, directories containing private keys or customer data) unless you accept the risk.

## Credentials and data storage

### API keys (BYOK)

- Provider API keys (e.g. Gemini) are stored locally in `data/keys.json` (gitignored, file mode `600`).
- On server start, saved keys are loaded into the corresponding environment variables (`GEMINI_API_KEY`, etc.) for the provider adapters.
- The Connections panel shows keys **masked** in the UI (last four characters only).
- Keys are stored as **plaintext at rest** on disk. Anyone with access to your user account and the `data/` directory can read them.
- Keys are sent only to the provider endpoint for that adapter (e.g. Google's Generative Language API for Gemini).

### CLI provider credentials

- The three CLI-based providers (claude, codex, grok) authenticate using the credentials/tokens stored by their own CLIs (usually in user home directories under hidden folders). The dashboard never sees or stores those tokens.

### Session and workspace data

- Session history, workspace list, and teams are stored **unencrypted** under `data/` (JSON + JSONL). The directory is listed in `.gitignore`.
- **Never commit the `data/` directory** (or `runs/`). It contains your chat history, workspace paths, and any API keys you have saved.

## Prompt injection and untrusted content

- Any file in the workspace, git history, or external content the agents fetch can influence model behavior.
- Treat repository contents and anything the models read as **untrusted input**.
- A malicious file or web page can attempt to make an agent exfiltrate data or run unwanted commands when operating in Edit mode.
- Review plans and diffs before approving team delegation or Edit-mode actions.

## Reporting a vulnerability

If you discover a security issue:

1. Do **not** open a public issue.
2. Report privately through GitHub Security Advisories or another maintainer-provided private channel with a clear description and reproduction steps.
3. Allow reasonable time for a fix before any public disclosure.

Use responsibly. This tool gives AI agents real access to your files and shell — you are in control.
