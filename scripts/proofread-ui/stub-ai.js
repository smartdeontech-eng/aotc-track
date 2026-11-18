// Preloaded into the server: answers Claude calls with a fixed draft.
const real = global.fetch;
global.fetch = async (u, o) => {
  if (String(u).includes('anthropic.com')) return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'The legal team was to be shared with the legal teams of the Presbytery and Head Office.' }], stop_reason: 'end_turn' }) };
  return real(u, o);
};
