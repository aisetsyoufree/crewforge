# Contributing

Thanks for your interest in improving Crew Forge.

## Running locally

```bash
npm start
```

The server prints the local URL. The UI is served from `public/index.html`; all logic is vanilla JS + a tiny Node HTTP server.

## Tests

```bash
npm test
```

Tests live in `test/` and use Node's built-in test runner. Run them before submitting changes.

## Adapter smoke runner

```bash
npm run adapter:run -- claude "Summarize this repo" . plan
```

This streams normalized adapter events in the terminal and is useful when changing provider adapters.

## Code conventions

- Vanilla JavaScript only — no runtime dependencies (`package.json` has zero `dependencies`; dev tooling is allowed).
- Keep the server, adapters, and lib modules small and focused.
- CSS uses custom properties (variables) defined in `:root` in `public/styles.css`.
- Prefer clarity over cleverness. Error messages and status updates should be human-readable.
- All persistent state lives under `data/` (gitignored).

## Adding a new model / provider

The adapter system is deliberately minimal. To add a new provider:

1. Create `adapters/yourmodel.js` that exports an object with this shape:

```js
module.exports = {
  id: 'yourmodel', // stable lowercase id used in URLs and storage
  label: 'Your Model', // human label shown in UI
  kind: 'cli' | 'api', // 'cli' = spawns a binary; 'api' = direct HTTP
  canEdit: true | false, // whether it supports the 'edit' permission mode
  defaultModel: 'default', // shown first in the model selector
  models: ['default', 'alt'], // list of selectable model strings (may be empty)

  // The only required method:
  run(spec, onEvent) {
    // spec = { prompt: string, model?: string, cwd?: string, mode?: 'plan'|'edit' }
    // onEvent receives normalized events (see below)
    // Must return a Promise that resolves to { finalText?, usage?, error? }
  },
};
```

2. Register it in `adapters/index.js`:

```js
const adapters = {
  ...,
  yourmodel: require('./yourmodel'),
};
```

3. The `run` function must stream events via the supplied `onEvent` callback. Use the shared `ev` helper from `adapters/base.js` when convenient.

## Normalized event contract

Every adapter must emit events of these types (via `onEvent(ev(type, text, meta))`):

- `status` — lifecycle notes ("Claude session started", "planning team delegation...")
- `reasoning` — model thinking / chain-of-thought (supports `meta.delta` and `meta.final`)
- `message` — the final visible response to the user (supports delta/final, can contain markdown)
- `command` — shell / tool command the agent executed (e.g. a Bash command)
- `file_change` — a file was created, edited, or patched (`meta.file` recommended)
- `usage` — token / cost accounting (`meta.usage`, `meta.cost`)
- `rate_limit` — rate-limit or quota signal from the provider
- `done` — the turn finished (`meta.finalText`, `meta.usage`, etc.)
- `error` — something went wrong

Delta vs final semantics (for streaming adapters):

- `{ type: 'message', text: '...', meta: { delta: true } }` → append token
- `{ type: 'message', text: 'full response', meta: { final: true } }` → replace/confirm complete block

See `adapters/base.js`, `adapters/claude.js`, `adapters/grok.js`, etc. for concrete examples.

## Pull requests

- Keep changes focused.
- Update or add tests when behavior changes.
- Make sure `npm test` passes.
- If your change affects the UI or user-facing behavior, briefly describe the before/after in the PR description.
- Contributions are accepted under the repository license. Do not submit code you cannot license for noncommercial source-available distribution.

Thanks for helping test and improve Crew Forge.
