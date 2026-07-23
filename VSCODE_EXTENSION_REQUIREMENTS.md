# Crew Forge VS Code Extension Requirements

**Status:** Proposed  
**Target:** Public beta, desktop VS Code  
**Product:** Crew Forge for VS Code  
**Source of truth:** This document defines the initial extension scope and acceptance criteria.

## 1. Product Summary

Crew Forge for VS Code brings Crew Forge's local-first, multi-model team orchestration into the editor. A user can assign an objective to a lead agent, delegate work to model-backed team members with roles and skills, monitor task progress, and review proposed changes without leaving VS Code.

The extension must reuse Crew Forge's existing orchestration and provider adapter behavior. It must not create a separate implementation with different safety rules, model handling, or session semantics.

## 2. Problem

Developers may have several authenticated coding-agent subscriptions available through local CLIs, but each tool operates independently. Coordinating planning, implementation, review, and QA across those tools requires manual prompting, context transfer, progress tracking, and change review.

The extension should make those local tools behave like a configurable software team while keeping the user in control of execution and file changes.

## 3. Goals

1. Run Crew Forge against the folder or workspace already open in VS Code.
2. Support direct single-model work and delegated team workflows.
3. Reuse existing Claude, Codex, Grok, Antigravity, and supported API adapters.
4. Show plans, tasks, agent activity, approvals, usage, and pending changes in VS Code.
5. Open files and diffs using native VS Code editors.
6. Preserve Crew Forge's local-first operation, reviewability, and human approval gates.
7. Package and publish a testable pre-release through the VS Code Marketplace.

## 4. Non-Goals for the Initial Beta

- Running in `vscode.dev`, `github.dev`, or other browser-only extension hosts.
- Replacing provider authentication or selling model access.
- Silently executing edit-capable agents when a workspace is untrusted.
- Cloud synchronization, shared organizations, or remote team collaboration.
- Fully autonomous merging or deployment.
- Rebuilding the full browser UI inside an unmodified webview.
- Guaranteeing support for every provider CLI version or operating system in the first beta.

## 5. Target Users

- Developers with two or more supported local AI coding tools.
- Technical beta testers comfortable with Git and reviewing generated changes.
- Users who want explicit agent roles, skills, delegation, and progress tracking.
- Existing Crew Forge users who prefer to work inside VS Code.

## 6. Product Principles

- **Local first:** Provider CLIs execute on the user's machine; workspace data remains local by default.
- **Human controlled:** Planning may be automatic, but edit-capable work requires visible approval.
- **Reviewable:** Generated changes must be inspectable through native VS Code diffs before integration.
- **One engine:** Browser and VS Code clients use the same orchestration, adapters, validation, and persistence contracts.
- **Workspace aware:** The active VS Code workspace is the execution boundary.
- **Honest security:** Git worktrees provide isolation and recovery, not a hard security sandbox.

## 7. Primary User Workflows

### 7.1 First Run

1. User installs the pre-release extension.
2. Extension displays a short walkthrough.
3. Extension detects supported provider CLIs and reports readiness without consuming model credits where possible.
4. User opens a trusted workspace.
5. User creates or imports a Crew Forge team.

### 7.2 Direct Model Run

1. User selects a provider, model, supported effort, Plan or Edit mode, and context settings.
2. User enters an objective.
3. Extension streams normalized events into the Crew Forge panel.
4. Files mentioned or changed by the model can be opened in VS Code.
5. Edit-mode changes are presented in the Source Control or diff experience for review.

### 7.3 Team Delegation

1. User selects a team containing one lead and one or more members.
2. Each member has a provider, model, role, and optional skill.
3. Lead produces a structured plan with assignments.
4. User reviews and approves, edits, or cancels the plan.
5. Approved steps run in order with visible status and ownership.
6. Reviewer or QA feedback is attached to the relevant task.
7. User reviews final changes before integration.

### 7.4 Recovery

1. A run fails, times out, is cancelled, or VS Code restarts.
2. The session remains visible with an accurate terminal state.
3. Pending worktrees and unreviewed changes remain discoverable.
4. User can resume supported work, inspect changes, or discard them explicitly.

## 8. Functional Requirements

### FR-1: Extension Structure

- Add the extension as an independently packageable workspace, preferably `packages/vscode-extension/`.
- Extract or expose reusable Crew Forge behavior through a shared core boundary.
- Do not import browser DOM code into the extension host.
- Do not duplicate adapter argument construction, orchestration rules, or persistence validation.

### FR-2: Workspace Integration

- Use `vscode.workspace.workspaceFolders` as the source of available workspaces.
- Clearly show which workspace folder is active in multi-root workspaces.
- Require explicit selection before running when multiple folders are open.
- Planning may operate in a non-Git workspace.
- Edit-capable runs retain Crew Forge's Git workspace requirement for the beta.
- All file operations must remain confined to the selected workspace or an approved Crew Forge worktree.

### FR-3: Workspace Trust

- Declare limited support for untrusted workspaces.
- Permit read-only browsing and non-executing UI in Restricted Mode.
- Block provider CLI execution, shell commands, and file modification until trust is granted.
- Enforce trust in command handlers, not only by hiding buttons.
- Explain why trust is required when an action is blocked.

### FR-4: Provider and Model Discovery

- Detect supported local provider CLIs and readiness.
- Refresh model lists on demand and at a bounded interval, not continuously.
- Preserve known fallback models when dynamic discovery is unavailable.
- Display only effort levels valid for the selected provider and model.
- Show actionable errors for missing, unauthenticated, or incompatible CLIs.
- Discovery should avoid paid inference calls whenever the CLI provides local metadata commands.

### FR-5: Team Management

- Create, edit, delete, export, and import teams.
- Require exactly one lead per team.
- Store member name, provider, model, role, skill, and lead status.
- Allow skills to be created and edited.
- Include role and skill instructions in the context passed by the orchestrator.
- Validate stale provider or model references before a run.

### FR-6: Composer

- Provide provider, model, effort, Plan/Edit, context provider, and context level controls.
- Make the direct-model path visually distinct from team delegation.
- Support multiline input and common submit/newline keyboard behavior.
- Disable submission with a clear reason when required conditions are missing.
- Preserve unsent text when changing non-destructive settings or switching views.

### FR-7: Sessions and Events

- List sessions for the active workspace, newest first by default.
- Allow sorting and basic filtering.
- Stream the existing normalized Crew Forge event schema.
- Render messages, reasoning summaries, commands, file changes, usage, errors, and completion states distinctly.
- Avoid exposing unreadable dark-on-dark command output.
- Provide copy and export actions, including CSV or JSON export where supported by core.

### FR-8: Plans, Tasks, and Approvals

- Show the lead's plan as structured tasks with owner, status, and sequence.
- Allow the user to edit task instructions before approval.
- Keep approval controls visible without requiring scrolling below the composer.
- Distinguish Plan approval from permission to modify files.
- Record approval, cancellation, failure, and retry events.
- Never reinterpret a read-only approval as edit permission.

### FR-9: File and Diff Experience

- Open text files with `vscode.window.showTextDocument`.
- Use native diff editors for generated changes.
- Refresh affected editors and Source Control state after changes.
- Provide safe previews or an external-open action for supported non-text files.
- Do not implement a competing general-purpose code editor in a webview.
- Make pending worktrees and their integration state visible.

### FR-10: Process Control

- Launch provider CLIs without shell interpolation where possible.
- Stream stdout and stderr without blocking the extension host.
- Support stop/cancel and propagate termination to child processes.
- Apply configurable soft timeouts and report when a process remains active.
- Prevent duplicate execution caused by repeated button presses.
- Clean up child processes on extension deactivation while preserving recoverable workspace changes.

### FR-11: State and Secrets

- Store secrets in VS Code `SecretStorage` or rely on provider-native authentication and environment variables.
- Never store API keys in workspace settings, logs, source control, or plaintext extension state.
- Use extension global state for user-level preferences and workspace state for workspace-specific UI state.
- Reuse or migrate existing Crew Forge sessions and teams without silently deleting browser-app data.
- Document backup, export, import, migration, and reset behavior.

### FR-12: Notifications and Diagnostics

- Use non-blocking VS Code notifications for important errors and completion events.
- Provide a named Output channel for diagnostic logs.
- Redact secrets, authorization headers, and sensitive environment values.
- Include enough context to identify provider, model, workspace, session, and failed stage.
- Offer a privacy-reviewed diagnostic export suitable for bug reports.

## 9. User Interface Requirements

### Activity Bar Container

Crew Forge should have a recognizable Activity Bar icon and a dedicated container containing:

- **Teams:** Active team and member configuration.
- **Tasks:** Plan, assignees, statuses, approvals, and retries.
- **Sessions:** Workspace session history.
- **Changes:** Pending worktrees and review actions.

### Main Panel

A webview panel may be used for the conversation stream and rich orchestration timeline. It must:

- Use VS Code theme variables.
- Support keyboard navigation, focus visibility, ARIA labels, and zoom.
- Use a strict Content Security Policy and nonce-based scripts.
- Sanitize all model-generated content before rendering.
- Communicate with the extension host through message passing.
- Avoid direct access to arbitrary local files or unrestricted localhost resources.

### Commands

At minimum, contribute commands for:

- `Crew Forge: Open`
- `Crew Forge: Run Objective`
- `Crew Forge: Delegate to Team`
- `Crew Forge: Refresh Providers and Models`
- `Crew Forge: Stop Active Run`
- `Crew Forge: Review Pending Changes`
- `Crew Forge: Open Diagnostics`

## 10. Technical Architecture

### Recommended Components

1. **Shared core**
   - Provider adapters and model discovery
   - Orchestration and task validation
   - Context saving and compaction
   - Session, team, skill, and usage contracts
   - Workspace guards and run outcomes

2. **VS Code extension host**
   - Activation and commands
   - Workspace Trust enforcement
   - Process lifecycle
   - SecretStorage and extension state
   - Native editor, diff, notification, and Output APIs

3. **VS Code presentation layer**
   - Native Tree Views for compact structured information
   - Webview panel only for the conversation and orchestration surface
   - Typed messages between webview and extension host

### Integration Rule

The initial implementation may temporarily run the existing Crew Forge backend as a child process for rapid prototyping. Marketplace beta should prefer direct core-library integration or a tightly controlled transport with random ports, authentication, lifecycle ownership, and loopback-only binding.

## 11. Security Requirements

- Treat all model output, repository content, filenames, and CLI output as untrusted input.
- Require Workspace Trust before executing local tools.
- Preserve Plan versus Edit separation at the API and command-handler levels.
- Enforce workspace path confinement, including symlink and traversal checks.
- Use argument arrays instead of command-string concatenation.
- Sanitize rendered Markdown and prohibit arbitrary script execution.
- Apply a restrictive webview Content Security Policy.
- Store secrets only through approved secure mechanisms.
- Do not claim worktrees are a hard sandbox.
- Warn users that provider CLIs may execute commands with their local account permissions.
- Run secret scanning, dependency auditing, linting, and tests in CI.

## 12. Performance and Reliability

- Extension activation should not start provider CLIs or the orchestration engine unnecessarily.
- Long-running work must not block the extension host event loop.
- Large histories should use pagination or virtualization.
- Model discovery must have timeouts and cached fallback results.
- State writes must be atomic or recoverable.
- Reloading the VS Code window must not create orphaned duplicate runs.
- Errors from one provider must not corrupt unrelated sessions or teams.

## 13. Compatibility

### Beta Support

- macOS: required.
- Windows and Linux: best effort until CI and manual smoke tests pass.
- VS Code desktop: required.
- VS Code Insiders: supported for development testing.
- Remote SSH, Dev Containers, and Codespaces: explicitly documented as unsupported or experimental until process locality is designed and tested.

The `engines.vscode` value must match the oldest version exercised in automated tests.

## 14. Testing Requirements

### Automated

- Unit tests for shared core boundaries and extension command handlers.
- Adapter argument and effort-level contract tests.
- Workspace Trust and path-confinement tests.
- Webview message-schema and sanitization tests.
- State migration and recovery tests.
- Extension-host integration tests using the official VS Code test tooling.
- Package-content test to ensure secrets, local data, and development artifacts are excluded.

### Manual Smoke Test

1. Install the generated VSIX into a clean VS Code profile.
2. Open an untrusted folder and confirm execution is blocked.
3. Trust the folder and run a read-only direct-model task.
4. Create a team and generate a delegated plan.
5. Approve a controlled edit in a disposable Git repository.
6. Open and review the resulting diff.
7. Cancel a running provider and verify process cleanup.
8. Reload VS Code and verify session and pending-change recovery.
9. Remove the extension and confirm no workspace files are removed.

No test should spend provider credits without an explicit opt-in environment flag.

## 15. Marketplace Requirements

- Unique extension name and publisher identifier.
- Valid `package.json` with commands, views, activation, categories, keywords, compatibility, and restricted-workspace capability.
- PNG icon of at least 128 by 128 pixels.
- Marketplace-focused README with screenshots and a concise security model.
- CHANGELOG, LICENSE, SECURITY, SUPPORT, privacy disclosure, and provider disclaimers.
- `.vscodeignore` that excludes source maps where inappropriate, tests, local data, credentials, and unrelated application assets.
- Bundled production output with no unnecessary runtime dependencies.
- Clean `vsce package` result and install test of the generated VSIX.
- Publish as a pre-release before promoting a stable version.

## 16. Acceptance Criteria for Public Beta

The extension is ready for public beta when:

1. A new user can install it, open a folder, detect at least one provider, and complete a Plan run.
2. A user can create a team, receive a structured delegated plan, approve it, and observe task status.
3. Edit mode cannot run in an untrusted or non-Git workspace.
4. Generated changes open in a native VS Code diff and remain unmerged until the user acts.
5. Stop, timeout, failure, and VS Code reload produce accurate recoverable states.
6. Secrets and local Crew Forge data are absent from the VSIX and repository.
7. Automated tests, lint, formatting, dependency audit, and packaging checks pass.
8. The extension passes a clean-profile macOS smoke test.
9. Documentation accurately states limitations, permissions, provider dependencies, and security boundaries.
10. No known critical or high-severity security defect remains open.

## 17. Delivery Plan

### Milestone 1: Architecture and Prototype

- Define shared-core API boundaries.
- Scaffold the TypeScript extension.
- Add Activity Bar container and Open command.
- Resolve the active workspace and enforce Workspace Trust.
- Complete one read-only provider run.

### Milestone 2: Usable MVP

- Add provider/model discovery and composer controls.
- Add sessions, teams, skills, and team planning.
- Add streaming events and cancellation.
- Open files and diffs natively.
- Add secure state and migration behavior.

### Milestone 3: Beta Hardening

- Add edit worktrees, approvals, recovery, and diagnostics.
- Complete accessibility and webview security review.
- Add integration tests and clean-profile smoke tests.
- Package a VSIX and complete pre-release documentation.

### Milestone 4: Marketplace Pre-Release

- Create publisher identity.
- Publish pre-release.
- Collect opt-in feedback and crash reports.
- Address beta blockers before stable promotion.

## 18. Suggested Agent Work Packages

- **Lead/Architect:** Shared-core boundaries, sequencing, architectural decisions, and integration review.
- **Product Manager:** User stories, workflow acceptance criteria, onboarding, and beta feedback plan.
- **Extension Engineer:** Extension host, commands, views, workspace APIs, process lifecycle, and packaging.
- **Frontend/UX Engineer:** Conversation webview, accessibility, responsive VS Code-native interaction, and visual QA.
- **Security Reviewer:** Workspace Trust, process execution, path confinement, secret handling, CSP, and package audit.
- **QA Engineer:** Automated extension tests, disposable-repository edit tests, recovery tests, and VSIX smoke testing.
- **Technical Writer:** Marketplace README, setup, provider prerequisites, limitations, privacy, and troubleshooting.

Work packages may run in parallel only after the lead defines shared interfaces. Security review and final QA must be independent from the primary implementation agent.

## 19. Definition of Done

- All public-beta acceptance criteria pass.
- The implementation reuses shared Crew Forge behavior instead of forking it.
- User-facing permissions and security boundaries are understandable and accurate.
- The generated VSIX installs and runs in a clean VS Code profile.
- Repository and package contents have been reviewed for credentials and unnecessary files.
- Final implementation receives independent engineering, security, and QA review.

## 20. Team Execution Prompt

Use the following prompt with a Crew Forge team:

> Build the Crew Forge VS Code extension according to `VSCODE_EXTENSION_REQUIREMENTS.md`. The lead must first inspect the existing repository and produce a phased implementation plan that preserves one shared orchestration core. Assign architecture, extension implementation, UX, security, testing, and documentation to members whose roles and skills fit the work. Do not begin edit-capable work until I approve the structured plan. Keep every change scoped to the selected workspace, use Git worktrees for edit tasks, and require independent security and QA review before declaring the Marketplace pre-release ready. Report progress against the requirement IDs and acceptance criteria, and surface unresolved risks instead of silently reducing scope.
