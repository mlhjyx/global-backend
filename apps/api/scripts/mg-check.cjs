// Proves the gateway presents ONE API over MANY providers, with fallback:
//   - register a 'flaky' provider (always throws) + the 'stub' provider
//   - router puts real providers first, stub last
//   - generateText routes flaky → (throws) → falls back to stub
const { ModelProviderRegistry } = require('../dist/model-gateway/model-provider.registry');
const { ModelRouter } = require('../dist/model-gateway/model-router');
const { RouterModelGateway } = require('../dist/model-gateway/router-model-gateway');
const { StubModelProvider } = require('../dist/model-gateway/providers/stub-model.provider');

const flaky = {
  id: 'flaky',
  supports: () => true,
  health: async () => ({ healthy: false }),
  generateText: async () => {
    throw new Error('provider down');
  },
  generateStructured: async () => {
    throw new Error('provider down');
  },
  embed: async () => {
    throw new Error('provider down');
  },
};

(async () => {
  const registry = new ModelProviderRegistry();
  registry.register(flaky);
  registry.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(registry));
  const ctx = { workspaceId: 'ws-1', userId: 'u-1' };

  const text = await gateway.generateText({ task: 'company_understanding', prompt: 'Summarize Acme Tech' }, ctx);
  const structured = await gateway.generateStructured(
    { task: 'extract_claims', prompt: 'x', schema: { required: ['name', 'claims'] } },
    ctx,
  );
  const emb = await gateway.embed({ task: 'retrieval', input: ['a', 'b'] }, ctx);

  console.log('providers registered :', registry.all().map((p) => p.id));
  console.log('generateText         →', text);
  console.log('generateStructured   →', structured);
  console.log('embed                →', { provider: emb.provider, n: emb.data.length, dims: emb.data[0].length });

  const ok =
    text.provider === 'stub' && // fell back flaky → stub
    structured.data && 'name' in structured.data && 'claims' in structured.data &&
    emb.data.length === 2;
  console.log(ok ? '\nMODEL GATEWAY: PASS ✅ (one API, multi-provider, flaky→stub fallback)' : '\nMODEL GATEWAY: FAIL ❌');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
