// Proves the app calls ONE gateway (中转站) with a task-selected model name, and
// falls back to the stub if the gateway is down — without any real vendor call.
const { ModelProviderRegistry } = require('../dist/model-gateway/model-provider.registry');
const { ModelRouter } = require('../dist/model-gateway/model-router');
const { RouterModelGateway } = require('../dist/model-gateway/router-model-gateway');
const { StubModelProvider } = require('../dist/model-gateway/providers/stub-model.provider');

// Fake 中转站 provider: echoes back the model name it was asked to resolve.
const gatewayFake = (fail = false) => ({
  id: 'gateway',
  supports: () => true,
  health: async () => ({ healthy: !fail }),
  generateText: async (input) => {
    if (fail) throw new Error('gateway down');
    return { data: `resolved:${input.model}`, provider: 'gateway', model: input.model };
  },
  generateStructured: async (input) => {
    if (fail) throw new Error('gateway down');
    return { data: { claims: [] }, provider: 'gateway', model: input.model };
  },
  embed: async () => ({ data: [[0]], provider: 'gateway', model: 'x' }),
});

const gatewayWith = (...providers) => {
  const registry = new ModelProviderRegistry();
  for (const p of providers) registry.register(p);
  return new RouterModelGateway(new ModelRouter(registry));
};
const ctx = { workspaceId: 'ws-1' };

(async () => {
  // 1) app → 中转站, carrying the task-selected model name.
  const routed = await gatewayWith(new StubModelProvider(), gatewayFake()).generateText(
    { task: 'company_understanding.extract_claims', prompt: 'x', model: 'deepseek-chat' },
    ctx,
  );
  // 2) 中转站 down → fall back to stub so the pipeline still runs in dev.
  const fellBack = await gatewayWith(new StubModelProvider(), gatewayFake(true)).generateText(
    { task: 'company_understanding.extract_claims', prompt: 'x', model: 'deepseek-chat' },
    ctx,
  );

  console.log('via gateway →', routed.provider, '| model passthrough →', routed.data);
  console.log('gateway down → fallback →', fellBack.provider);

  const ok = routed.provider === 'gateway' && routed.data === 'resolved:deepseek-chat' && fellBack.provider === 'stub';
  console.log(
    ok
      ? '\nMODEL GATEWAY: PASS ✅ (single 中转站 endpoint, task-selected model, stub fallback)'
      : '\nMODEL GATEWAY: FAIL ❌',
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
