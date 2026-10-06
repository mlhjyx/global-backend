import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  dispatcherAdapterNames,
  forwardingAdapterIssues,
  inspectPlatformWireDispatch,
  livePlatformToolWires,
  PLATFORM_CONTRACT_PATH,
  platformToolIssues,
  sourcePhysicalWireIssues,
  terminalAdapterIssues,
} from './execution-authority-wire-dispatch.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const codes = (issues) => issues.map((entry) => entry.code);

async function listFiles(relative) {
  const entries = await readdir(resolve(repositoryRoot, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test('the repository routes every live platform Tool wire through the authorized dispatcher', async () => {
  const issues = await inspectPlatformWireDispatch({
    readText: (path) => readFile(resolve(repositoryRoot, path), 'utf8'),
    listFiles,
    toolSourcePaths: ['apps/api/src/tools/builtin-tools.ts', 'apps/api/src/tools/source-tools.ts'],
  });

  assert.deepEqual(issues, []);
});

test('live platform Tools and their dispatchable wires come from the platform contract', async () => {
  const contract = await readFile(resolve(repositoryRoot, PLATFORM_CONTRACT_PATH), 'utf8');

  assert.deepEqual(Object.fromEntries(livePlatformToolWires(contract)), {
    'crawl4ai.render': ['robots.public_http', 'crawl4ai.render.dispatch'],
    'mapyourshow.fetch': ['mapyourshow.fetch'],
    'sanctions.download': ['sanctions.public_http'],
    'tradefair.algolia': ['tradefair.algolia.page'],
  });
});

const contract = (rows) => `export const PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 = deepFreeze({ rows: [${rows.join(',')}] } as const);`;
const row = (costMode, wires, tools) => `technicalRow({ costMode: "${costMode}",
  physicalWireContracts: [${wires.map((wire) => `{ wireId: "${wire}" }`).join(',')}],
  toolContracts: [${tools.map((tool) => `{ toolId: "${tool}" }`).join(',')}] })`;

test('a multi-tool row gives each Tool only its own wires, as the dispatcher does', () => {
  const wires = livePlatformToolWires(contract([
    row('zero_paid_dispatch', ['a.page', 'b', 'c.page'], ['a', 'b']),
    row('tool_estimated_cents', ['robots.public_http', 'r.dispatch'], ['r']),
    row('disabled_no_egress', ['p.query'], ['p']),
  ]));

  assert.deepEqual(Object.fromEntries(wires), {
    a: ['a.page'],
    b: ['b'],
    r: ['robots.public_http', 'r.dispatch'],
  });
});

test('an unreadable contract or a Tool on two rows yields no wire map', () => {
  assert.equal(livePlatformToolWires('export const OTHER = {};'), null);
  assert.equal(livePlatformToolWires(contract([row('zero_paid_dispatch', ['a'], ['a']), row('zero_paid_dispatch', ['a.x'], ['a'])])), null);
  assert.equal(livePlatformToolWires(contract([`{ costMode: "zero_paid_dispatch", physicalWireContracts: [{ wireId: WIRE }], toolContracts: [{ toolId: "a" }] }`])), null);
});

test('adapters that take a dispatcher are found directly and through an options interface', () => {
  const names = dispatcherAdapterNames('apps/api/src/adapters/x.ts', `
    export interface XDependencies { dispatchPhysicalWire?: DispatchPhysicalWire }
    export async function direct(url: string, dispatchPhysicalWire?: DispatchPhysicalWire) {}
    export async function viaOptions(url: string, dependencies: XDependencies = {}) {}
    export const arrow = async (dispatchPhysicalWire?: DispatchPhysicalWire) => {};
    export async function unrelated(url: string) {}
    async function internal(dispatchPhysicalWire?: DispatchPhysicalWire) {}
  `);

  assert.deepEqual(names, ['direct', 'viaOptions', 'arrow']);
});

const terminal = (body) => `export async function send(url: string, dispatchPhysicalWire?: DispatchPhysicalWire) {\n${body}\n}`;
const DISPATCHED = `
  const executePhysicalWire = async () => fetch(url);
  return dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire();`;
const TERMINAL = { name: 'send', send: 'fetch' };

test('a terminal adapter sends only inside executePhysicalWire, run through the dispatch conditional', () => {
  assert.deepEqual(terminalAdapterIssues('a.ts', terminal(DISPATCHED), TERMINAL), []);
  for (const body of [
    `await fetch(url);${DISPATCHED}`,
    `const executePhysicalWire = async () => fetch(url);\n  return await executePhysicalWire();`,
    `${DISPATCHED.replace('return ', 'await executePhysicalWire();\n  return ')}`,
    `const executePhysicalWire = async () => fetch(url);\n  return other ? await other(executePhysicalWire) : await executePhysicalWire();`,
    `const executePhysicalWire = async () => url;\n  await fetch(url);\n  return dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire();`,
  ]) {
    assert.deepEqual(codes(terminalAdapterIssues('a.ts', terminal(body), TERMINAL)), ['EXECUTION_AUTHORITY_WIRE_ADAPTER_SEND_UNDISPATCHED'], body);
  }
});

const forwarding = (body, outside = '') => `${outside}
export async function check(url: string, dependencies: Deps = {}) {
  const dispatchPhysicalWire = dependencies.dispatchPhysicalWire
    ? async (execute) => { try { return await dependencies.dispatchPhysicalWire!(execute); } finally { done(); } }
    : undefined;
  ${body}
}`;
const FORWARDING = { name: 'check', forwardsTo: 'requestPublicHttp' };

test('a forwarding adapter passes the dispatcher it was given to every terminal call in its file', () => {
  const good = 'return (dependencies.request ?? requestPublicHttp)(url, {}, { dispatchPhysicalWire });';
  assert.deepEqual(forwardingAdapterIssues('r.ts', forwarding(good), FORWARDING), []);
  assert.deepEqual(forwardingAdapterIssues('r.ts', forwarding('return requestPublicHttp(url, {}, { dispatchPhysicalWire: dependencies.dispatchPhysicalWire });'), FORWARDING), []);
  for (const source of [
    forwarding('return requestPublicHttp(url, {}, {});'),
    forwarding(good).replace('dependencies.dispatchPhysicalWire!(execute)', 'execute()'),
    forwarding(good, 'async function preload(url: string) { return requestPublicHttp(url); }'),
    forwarding('return url;'),
  ]) {
    assert.deepEqual(codes(forwardingAdapterIssues('r.ts', source, FORWARDING)), ['EXECUTION_AUTHORITY_WIRE_ADAPTER_FORWARD_MISSING'], source);
  }
});

const SOURCE_PHYSICAL_WIRE = `function sourcePhysicalWire(ctx: ToolContext, wireId: string): DispatchPhysicalWire | undefined {
  const dispatch = ctx.dispatchPhysicalWire;
  if (ctx.workspaceId === "platform" && typeof dispatch !== "function") {
    throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");
  }
  return dispatch ? (execute) => dispatch(wireId, execute) : undefined;
}`;

test('sourcePhysicalWire stays the fail-closed platform dispatcher accessor', () => {
  assert.deepEqual(sourcePhysicalWireIssues('t.ts', SOURCE_PHYSICAL_WIRE), []);
  assert.deepEqual(
    codes(sourcePhysicalWireIssues('t.ts', SOURCE_PHYSICAL_WIRE.replace('ctx.workspaceId === "platform" && ', ''))),
    ['EXECUTION_AUTHORITY_SOURCE_PHYSICAL_WIRE_DRIFT'],
  );
  assert.deepEqual(codes(sourcePhysicalWireIssues('t.ts', 'const x = 1;')), ['EXECUTION_AUTHORITY_SOURCE_PHYSICAL_WIRE_DRIFT']);
});

const TOOL_PATH = 'apps/api/src/tools/source-tools.ts';
const tool = (execute, extra = '') => `
import { requestPublicHttp } from "../adapters/guarded-http";
import { isAllowedByRobots } from "../adapters/robots";
import { wikidataSearchEntity } from "../adapters/wikidata";
import { decodeJsonBytes } from "../adapters/bounded-fetch-response";
import { request as httpsRequest } from "node:https";
const contract = platformExecutionToolContract("demo.fetch");
${SOURCE_PHYSICAL_WIRE}
${extra}
export const demoTool = { id: contract.toolId, execute: async (input, ctx) => {
${execute}
} };`;
const ALL_WIRES = `
  await isAllowedByRobots(input.url, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "robots.public_http") });
  const res = await requestPublicHttp(input.url, {}, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "demo.fetch") });
  return decodeJsonBytes(res.body, "X");`;
const WIRES = ['robots.public_http', 'demo.fetch'];

test('a live platform Tool passes a declared sourcePhysicalWire to every wire adapter call', () => {
  assert.deepEqual(platformToolIssues(TOOL_PATH, tool(ALL_WIRES), 'demo.fetch', WIRES), []);
  const cases = [
    [ALL_WIRES.replace(', { dispatchPhysicalWire: sourcePhysicalWire(ctx, "demo.fetch") }', ''), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [ALL_WIRES.replace('sourcePhysicalWire(ctx, "demo.fetch")', 'sourcePhysicalWire(input, "demo.fetch")'), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [ALL_WIRES.replace('"demo.fetch"', '"other.fetch"'), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNDECLARED', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [`${ALL_WIRES.replace('return ', 'await fetch(input.url);\n  return ')}`, ['EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK']],
    [`${ALL_WIRES.replace('return ', 'httpsRequest(input.url);\n  return ')}`, ['EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK']],
    [`${ALL_WIRES.replace('return ', 'await wikidataSearchEntity(input.url);\n  return ')}`, ['EXECUTION_AUTHORITY_PLATFORM_TOOL_ADAPTER_UNREGISTERED']],
  ];
  for (const [execute, expected] of cases) {
    assert.deepEqual(codes(platformToolIssues(TOOL_PATH, tool(execute), 'demo.fetch', WIRES)), expected, execute);
  }
});

test('same-file helpers a live platform Tool reaches are held to the same wiring', () => {
  const viaHelper = ALL_WIRES.replace(
    'const res = await requestPublicHttp(input.url, {}, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "demo.fetch") });',
    'const res = await download(input.url, ctx);',
  );
  const dispatched = 'async function download(url: string, context: ToolContext) { return requestPublicHttp(url, {}, { dispatchPhysicalWire: sourcePhysicalWire(context, "demo.fetch") }); }';

  assert.deepEqual(platformToolIssues(TOOL_PATH, tool(viaHelper, dispatched), 'demo.fetch', WIRES), []);
  assert.deepEqual(
    codes(platformToolIssues(TOOL_PATH, tool(viaHelper, 'async function download(url: string) { return requestPublicHttp(url); }'), 'demo.fetch', WIRES)),
    ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED'],
  );
  assert.deepEqual(
    codes(platformToolIssues(TOOL_PATH, tool(viaHelper, 'const download = async (url: string) => fetch(url);'), 'demo.fetch', WIRES)),
    ['EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED'],
  );
});

test('a live platform Tool must be declared exactly once', () => {
  assert.deepEqual(codes(platformToolIssues(TOOL_PATH, tool(ALL_WIRES), 'missing.tool', WIRES)), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND']);
  assert.deepEqual(
    codes(platformToolIssues(TOOL_PATH, `${tool(ALL_WIRES)}\nexport const copy = { id: "demo.fetch", execute: async (input, ctx) => null };`, 'demo.fetch', WIRES)),
    ['EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND'],
  );
});
