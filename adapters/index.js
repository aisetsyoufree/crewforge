'use strict';

// Adapter registry — the backbone every upper layer (router, server, UI) talks to.
const adapters = {
  claude: require('./claude'),
  codex: require('./codex'),
  grok: require('./grok'),
  gemini: require('./gemini'),
};

function get(id) {
  const a = adapters[id];
  if (!a) throw new Error(`unknown adapter: ${id}`);
  return a;
}

// Catalog for the UI: which providers exist, their models, edit capability.
function catalog() {
  return Object.values(adapters).map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    canEdit: a.canEdit,
    defaultModel: a.defaultModel,
    models: a.models,
  }));
}

// Uniform entry point: run one agent turn, streaming normalized events.
function run(adapterId, spec, onEvent) {
  return get(adapterId).run(spec, onEvent);
}

module.exports = { adapters, get, catalog, run };
