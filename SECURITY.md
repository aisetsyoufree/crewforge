# Security

Crew Forge is a **local-first** tool. Treat it with the same care you would a powerful terminal.

Report vulnerabilities privately through GitHub Security Advisories if the repository enables them. Otherwise, contact the maintainer privately before opening a public issue.

## Binding and network exposure

- The server listens exclusively on `127.0.0.1` (loopback). It is never reachable from other machines on your network by default.
- Do **not** set `CREW_FORGE_HOST=0.0.0.0` or proxy/port-forward the port. Overriding the bind address exposes a **code-execution surface** to your network — the folder browser and Edit-mode agents can read paths you give them and run arbitrary shell commands. Remote binding requires both `CREW_FORGE_ALLOW_REMOTE=1` and `CREW_FORGE_AUTH_TOKEN`; open the app with `?token=<value>` once to establish the browser session.
- The folder browser is home-scoped by default and blocks sensitive hidden folders such as `.ssh`. Set `CREW_FORGE_ALLOW_SENSITIVE_PATHS=1` only for trusted local testing when you understand the risk.

## Trust model (single-user localhost)

Crew Forge is designed for **one trusted operator on the same machine**.

| Mode                                                                     | Default | Assumptions                                                                           | Protections                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Localhost** (`127.0.0.1`)                                              | Yes     | Only you can reach the port; other local users/processes are outside the threat model | HttpOnly session cookie, `SameSite=Strict`, process-wide CSRF token in the page meta, origin checks, JSON-only mutating bodies                                                     |
| **Remote / LAN** (`CREW_FORGE_ALLOW_REMOTE=1` + `CREW_FORGE_AUTH_TOKEN`) | No      | Anyone who can reach the host and present the token is effectively an admin           | Same as localhost, plus `Secure` cookie flag (TLS required), bearer/header/query token auth, and **periodically rotating CSRF** (30 min, with a short previous-token grace window) |

### Explicit risks of remote / LAN mode

- The bind address is a **code-execution and filesystem-browsing surface**. A stolen or guessed `CREW_FORGE_AUTH_TOKEN` lets an attacker run agents, read workspace files (within browser scope), integrate worktrees, and start dev processes.
- CSRF protection on remote is stronger than localhost (rotating tokens), but it is **not** multi-user authorization, SSO, or per-role ACL. There is still a single shared auth token for the process.
- Bearer/header/query token clients skip the CSRF header (they are not cookie-session browsers). Treat that token like a root password: long, random, never committed, rotate after exposure.
- Do not expose Crew Forge on the public internet without TLS termination, a private network boundary, and understanding that agents run with your OS user privileges.
- Prefer SSH port-forwarding or a VPN to a localhost bind over opening `0.0.0.0`.

## Repository maintainer checklist

- Keep only the deploy keys that are actively needed. For this repository, a single repo-scoped write deploy key is enough for publishing from the local machine; remove unused personal SSH deploy keys after the push succeeds.
- Prefer deploy keys over broad personal access tokens. If a token is ever used, make it fine-grained, repo-scoped, short-lived, and rotate it after publishing.
- Enable GitHub security features before inviting testers: private vulnerability reporting, secret scanning, Dependabot alerts, and branch protection for `main`.
- Do not grant write access to public testers. Ask testers to open issues or pull requests; repository owners decide what gets merged.

## Edit mode and code execution

- **EDIT mode** lets the selected agent run arbitrary shell commands (`Bash`, exec, etc.) and modify files inside the chosen workspace.
- **Claude**, **Grok**, and **Antigravity** edit sessions use their local CLIs and can execute host commands with your user privileges, the same as running those tools directly in a terminal.
- **Antigravity** runs with `--sandbox`, explicit `--new-project` / `--add-dir` workspace binding, and `accept-edits` or `plan` mode. That sandbox limits some Antigravity-side behavior; it is **not** a hard host isolation boundary — `agy` still runs on your machine with your credentials.
- Use Edit mode **only with Git workspaces you fully trust**. Crew Forge blocks Edit-mode runs for non-Git folders in this beta.
- The combination of a folder picker + agent code execution is intentionally powerful; it is effectively a controlled terminal running inside your repo.
- Never point the dashboard at a sensitive directory (e.g. `~`, `/`, production checkouts, directories containing private keys or customer data) unless you accept the risk.
- CLI-backed providers are spawned with a reduced environment so API-provider keys saved in Crew Forge are not passed to unrelated CLI processes.

## Credentials and data storage

### API keys (BYOK)

- The preferred Antigravity integration uses the authenticated local `agy` CLI and does not require Crew Forge to store a Google API key.
- Optional legacy provider API keys (e.g. Gemini API) are stored locally in `data/keys.json` (gitignored, file mode `600`).
- On server start, saved keys are loaded into the corresponding environment variables (`GEMINI_API_KEY`, etc.) for the provider adapters.
- The Connections panel shows keys **masked** in the UI (last four characters only).
- Keys are stored as **plaintext at rest** on disk. Anyone with access to your user account and the `data/` directory can read them.
- Keys are sent only to the provider endpoint for that adapter (e.g. Google's Generative Language API for Gemini).

### CLI provider credentials

- The four CLI-based providers (claude, codex, grok, antigravity) authenticate using the credentials/tokens stored by their own CLIs or companion apps (usually in user home directories under hidden folders). The dashboard never sees or stores those tokens.

### Session and workspace data

- Session history, workspace list, and teams are stored **unencrypted** under `data/` (JSON + JSONL). The directory is listed in `.gitignore`.
- Session CSV exports can contain prompts, responses, commands, local paths, and provider-generated text. Formula-like cells are neutralized, but you should still review an export before sharing it.
- The execution ledger (`data/ledger/entries.jsonl`) is an append-only local audit log of run/plan/integration transitions. It is intentionally redacted: it does **not** store prompt text, environment variables, API keys, auth tokens, unbounded command output, or patent materials. Field lengths are capped; likely secrets are stripped; CSV exports neutralize spreadsheet formula injection. Entries are scoped by workspace/session/project when those ids exist. Ledger list/export endpoints use the same app session and CSRF conventions as other APIs.
- **Context policy** (`relevant-only` default, `metadata-only`, `full-workspace`) is user-selectable, validated by the server, and enforced when Crew Forge builds prompts, trees, diffs, and continuation capsules. Default exclusions cover `.env*`, credential/key files, `.ssh` / `.aws` / `.config` secrets, `node_modules`, `.git`, runtime `data/` / `runs/`, worktrees, `patent/`, and related patterns. This is **local control with provider processing** — inference still runs in the selected provider CLI/API and is not local/private to Crew Forge alone. Full-workspace still excludes sensitive paths from Crew Forge-built context but warns that the provider may read broader non-excluded workspace files through its CLI.
- **Continuation capsules** (`data/capsules/`) store a bounded, redacted resume package when a run fails, is cancelled with partial progress, hits a rate-limit signal, or is otherwise incomplete. Capsules omit env vars, credentials, tokens, absolute host paths, and unbounded command output. Resume is always explicit with a user-selected provider/model/effort/mode — there is no automatic provider switch or silent failover.
- **Never commit the `data/` directory** (or `runs/`). It contains your chat history, workspace paths, and any API keys you have saved.

## Prompt injection and untrusted content

- Any file in the workspace, git history, or external content the agents fetch can influence model behavior.
- Treat repository contents and anything the models read as **untrusted input**.
- A malicious file or web page can attempt to make an agent exfiltrate data or run unwanted commands when operating in Edit mode.
- Review plans and diffs before approving team delegation or Edit-mode actions.

## Workspace guard and Git worktrees

- `workspace_guard` is **advisory**: it rewrites or blocks some streamed `file_change` events that point outside the selected workspace path. It does **not** contain agents, intercept every CLI action, or prevent shell commands from touching other paths.
- Team **edit** steps run in isolated Git worktrees under `.crewforge-worktrees/` so your main checkout stays unchanged until you **integrate**. Worktrees protect the selected repo checkout and enable review; they are **not** a host sandbox — agents still run on your machine with your credentials.
- Team edit changes require **explicit integration** in the UI (or equivalent API). Rejecting a pending worktree discards that branch’s changes without merging them into the workspace root.
- **Quality gates** are rule-based over persisted evidence (review findings, checks, diagnostics, diffs, failures). They block integration when mandatory evidence is blocked/incomplete. Human approval cannot silently override missing evidence — an explicit non-empty `overrideReason` is required and is recorded in task evidence and the ledger. Gates never use model self-reported confidence.
- **Auto-repair** after `REQUEST_CHANGES` is opt-in (default off). When enabled, repair attempts are bounded (default 2, hard cap 5), assigned to the original implementer/provider/model, and never silently switch providers.

## Reporting a vulnerability

If you discover a security issue:

1. Do **not** open a public issue.
2. Report privately through GitHub Security Advisories or another maintainer-provided private channel with a clear description and reproduction steps.
3. Allow reasonable time for a fix before any public disclosure.

Use responsibly. This tool gives AI agents real access to your files and shell — you are in control.
