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
const codes = (issues) => [...new Set(issues.map((entry) => entry.code))].sort();

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
const row = (costMode, wires, tools, builder = 'technicalRow') => `${builder}({ costMode: "${costMode}",
  physicalWireContracts: [${wires.map((wire) => `{ wireId: "${wire}" }`).join(',')}],
  toolContracts: [${tools.map((tool) => `{ toolId: "${tool}" }`).join(',')}] })`;

test('a multi-tool row gives each Tool only its own wires, as the dispatcher does', () => {
  const wires = livePlatformToolWires(contract([
    row('zero_paid_dispatch', ['a.page', 'b', 'c.page'], ['a', 'b']),
    row('tool_estimated_cents', ['robots.public_http', 'r.dispatch'], ['r']),
    row('disabled_no_egress', ['p.query'], ['p']),
  ]));

  assert.deepEqual(Object.fromEntries(wires), { a: ['a.page'], b: ['b'], r: ['robots.public_http', 'r.dispatch'] });
});

test('a contract that cannot be read exactly yields no wire map', () => {
  for (const source of [
    'export const OTHER = {};',
    contract([row('zero_paid_dispatch', ['a'], ['a']), row('zero_paid_dispatch', ['a.x'], ['a'])]),
    contract(['{ costMode: "zero_paid_dispatch", physicalWireContracts: [{ wireId: WIRE }], toolContracts: [{ toolId: "a" }] }']),
    contract([row('zero_paid_dispatch', ['a'], ['a']).replace('{ costMode', '{ ...live, costMode')]),
    contract([row('zero_paid_dispatch', ['a'], ['a'], 'customBuilder')]),
  ]) assert.equal(livePlatformToolWires(source), null, source);
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

const CRAWLER = 'apps/api/src/adapters/web-crawler.ts';
const terminal = (body, outside = '') => `${outside}
export async function crawlHtml(url: string, dispatchPhysicalWire?: DispatchPhysicalWire) {\n${body}\n}`;
const DISPATCHED = `
  const executePhysicalWire = async () => fetch(url);
  return dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire();`;
const HTML = { name: 'crawlHtml', send: 'fetch' };

test('a terminal adapter sends once, inside executePhysicalWire, run through its own dispatcher', () => {
  assert.deepEqual(terminalAdapterIssues(CRAWLER, terminal(DISPATCHED), HTML), []);
  const undispatched = [
    terminal(`await fetch(url);${DISPATCHED}`),
    terminal('const executePhysicalWire = async () => fetch(url);\n  return await executePhysicalWire();'),
    terminal(DISPATCHED.replace('return ', 'await executePhysicalWire();\n  return ')),
    terminal(DISPATCHED.replace(/dispatchPhysicalWire/g, 'other')),
    terminal(`await globalThis.fetch(url);${DISPATCHED}`),
    terminal(`await ping(url);${DISPATCHED}`, 'function ping(target: string) { return fetch(target); }'),
    terminal(`await crawlUrl(url);${DISPATCHED}`, 'export async function crawlUrl(target: string) { return target; }'),
    terminal(`if (process.env.X) dispatchPhysicalWire = undefined;${DISPATCHED}`),
    terminal(DISPATCHED.replace('async () => fetch(url)', 'async () => { for (let i = 0; i < 3; i++) { try { return await fetch(url); } catch {} } }')),
    terminal(DISPATCHED.replace('async () => fetch(url)', 'async () => { await fetch(url); return fetch(url); }')),
    terminal(DISPATCHED.replace('async () => fetch(url)', 'async () => { await globalThis.fetch(url); return fetch(url); }')),
  ];
  for (const source of undispatched) {
    assert.deepEqual(codes(terminalAdapterIssues(CRAWLER, source, HTML)), ['EXECUTION_AUTHORITY_WIRE_ADAPTER_SEND_UNDISPATCHED'], source);
  }
});

test('a dispatcher read from a copy of the options, not the parameter, does not count', () => {
  const source = `export async function requestPublicHttp(raw: string, dependencies: Deps = {}) {
    const execute = dependencies.executePinned ?? executePinnedHttp;
    const options = { ...dependencies, dispatchPhysicalWire: undefined };
    const executePhysicalWire = () => execute(raw);
    return options.dispatchPhysicalWire ? await options.dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire();
  }
  function executePinnedHttp(target: string) { return httpsRequest(target); }`;
  const imports = 'import { request as httpsRequest } from "node:https";\n';
  const adapter = { name: 'requestPublicHttp', send: 'execute' };

  assert.deepEqual(
    terminalAdapterIssues('apps/api/src/adapters/guarded-http.ts', imports + source.replace(/options\.dispatchPhysicalWire/g, 'dependencies.dispatchPhysicalWire').replace('const options = { ...dependencies, dispatchPhysicalWire: undefined };\n', ''), adapter),
    [],
  );
  assert.deepEqual(codes(terminalAdapterIssues('apps/api/src/adapters/guarded-http.ts', imports + source, adapter)), ['EXECUTION_AUTHORITY_WIRE_ADAPTER_SEND_UNDISPATCHED']);
  assert.deepEqual(
    codes(terminalAdapterIssues('apps/api/src/adapters/guarded-http.ts', imports + source.replace(/options\.dispatchPhysicalWire/g, 'dependencies.dispatchPhysicalWire').replace('const options = { ...dependencies, dispatchPhysicalWire: undefined };', 'await executePinnedHttp(raw);'), adapter)),
    ['EXECUTION_AUTHORITY_WIRE_ADAPTER_SEND_UNDISPATCHED'],
  );
});

const ROBOTS = 'apps/api/src/adapters/robots.ts';
const forwarding = (body, outside = '') => `${outside}
export async function isAllowedByRobots(url: string, dependencies: Deps = {}) {
  const dispatchPhysicalWire = dependencies.dispatchPhysicalWire
    ? async (execute) => { try { return await dependencies.dispatchPhysicalWire!(execute); } finally { done(); } }
    : undefined;
  ${body}
}`;
const FORWARDING = { name: 'isAllowedByRobots', forwardsTo: 'requestPublicHttp' };
const FORWARDED = 'const request = (raw) => (dependencies.request ?? requestPublicHttp)(raw, {}, { dispatchPhysicalWire });\n  return load(url, request);';

test('a forwarding adapter passes the dispatcher it was given to every terminal call in its file', () => {
  assert.deepEqual(forwardingAdapterIssues(ROBOTS, forwarding(FORWARDED), FORWARDING), []);
  assert.deepEqual(forwardingAdapterIssues(ROBOTS, forwarding('return requestPublicHttp(url, {}, { dispatchPhysicalWire: dependencies.dispatchPhysicalWire });'), FORWARDING), []);
  for (const source of [
    forwarding('return requestPublicHttp(url, {}, {});'),
    forwarding(FORWARDED).replace('dependencies.dispatchPhysicalWire!(execute)', 'execute()'),
    forwarding(FORWARDED).replace('try { return', 'try { if (url.length > 9) return execute(); return'),
    forwarding(FORWARDED, 'async function preload(url: string) { return requestPublicHttp(url); }'),
    forwarding('return load(url, dependencies.request ?? requestPublicHttp);'),
    forwarding('return url;'),
  ]) {
    assert.deepEqual(codes(forwardingAdapterIssues(ROBOTS, source, FORWARDING)), ['EXECUTION_AUTHORITY_WIRE_ADAPTER_FORWARD_MISSING'], source);
  }
});

const SOURCE_PHYSICAL_WIRE = `function sourcePhysicalWire(ctx: ToolContext, wireId: string): DispatchPhysicalWire | undefined {
  const dispatch = ctx.dispatchPhysicalWire;
  if (ctx.workspaceId === "platform" && typeof dispatch !== "function") {
    throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");
  }
  return dispatch ? (execute) => dispatch(wireId, execute) : undefined;
}`;

test('sourcePhysicalWire stays the single fail-closed platform dispatcher accessor', () => {
  assert.deepEqual(sourcePhysicalWireIssues('t.ts', SOURCE_PHYSICAL_WIRE), []);
  for (const source of [
    SOURCE_PHYSICAL_WIRE.replace('ctx.workspaceId === "platform" && ', ''),
    'const x = 1;',
    `${SOURCE_PHYSICAL_WIRE}\nfunction run() { const sourcePhysicalWire = () => undefined; return sourcePhysicalWire; }`,
  ]) assert.deepEqual(codes(sourcePhysicalWireIssues('t.ts', source)), ['EXECUTION_AUTHORITY_SOURCE_PHYSICAL_WIRE_DRIFT'], source);
});

const TOOL_PATH = 'apps/api/src/tools/source-tools.ts';
const tool = (execute, extra = '') => `
import { requestPublicHttp } from "../adapters/guarded-http.js";
import { isAllowedByRobots } from "../adapters/robots";
import { wikidataSearchEntity } from "../adapters/wikidata";
import { decodeJsonBytes } from "../adapters/bounded-fetch-response";
import { fetchSitemap } from "../discovery/sitemap";
import { request as httpsRequest } from "node:https";
import axios from "axios";
import type { ToolContext } from "./tool-contract";
const contract = platformExecutionToolContract("demo.fetch");
${SOURCE_PHYSICAL_WIRE}
${extra}
export const demoTool = { id: contract.toolId, execute: async (input, ctx: ToolContext) => {
${execute}
} };`;
const ALL_WIRES = `
  await isAllowedByRobots(input.url, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "robots.public_http") });
  const res = await requestPublicHttp(input.url, {}, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "demo.fetch") });
  return decodeJsonBytes(res.body, "X");`;
const WIRES = ['robots.public_http', 'demo.fetch'];
const before = (statement) => ALL_WIRES.replace('  return ', `  ${statement}\n  return `);
const toolCodes = (execute, extra) => codes(platformToolIssues(TOOL_PATH, tool(execute, extra), 'demo.fetch', WIRES));

test('a live platform Tool passes a declared sourcePhysicalWire to every wire adapter call', () => {
  assert.deepEqual(platformToolIssues(TOOL_PATH, tool(ALL_WIRES), 'demo.fetch', WIRES), []);
  const cases = [
    [ALL_WIRES.replace(', { dispatchPhysicalWire: sourcePhysicalWire(ctx, "demo.fetch") }', ''), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [ALL_WIRES.replace('sourcePhysicalWire(ctx, "demo.fetch")', 'sourcePhysicalWire(input, "demo.fetch")'), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [ALL_WIRES.replace('"demo.fetch"', '"other.fetch"'), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNDECLARED', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
  ];
  for (const [execute, expected] of cases) assert.deepEqual(toolCodes(execute), expected, execute);
});

test('a live platform Tool cannot add a send beside its dispatched wires', () => {
  const direct = ['EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK'];
  const unregistered = ['EXECUTION_AUTHORITY_PLATFORM_TOOL_IMPORT_UNREGISTERED'];
  const missing = ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING'];
  for (const [statement, expected] of [
    ['await fetch(input.url);', direct],
    ['await globalThis.fetch(input.url);', direct],
    ['await fetch.call(null, input.url);', direct],
    ['httpsRequest(input.url);', direct],
    ['await axios.get(input.url);', direct],
    ['await wikidataSearchEntity(input.url);', unregistered],
    ['await fetchSitemap(input.url);', unregistered],
    ['await import("../adapters/guarded-http");', unregistered],
    ['const raw = requestPublicHttp; await raw(input.url);', missing],
    ['await isAllowedByRobots(input.url, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "robots.public_http"), request: requestPublicHttp });', missing],
  ]) assert.deepEqual(toolCodes(before(statement)), expected, statement);
});

test('same-file declarations a live platform Tool reaches are held to the same wiring', () => {
  const viaHelper = ALL_WIRES.replace(
    'const res = await requestPublicHttp(input.url, {}, { dispatchPhysicalWire: sourcePhysicalWire(ctx, "demo.fetch") });',
    'const res = await download(input.url, ctx);',
  );
  const dispatched = 'async function download(url: string, context: ToolContext) { return requestPublicHttp(url, {}, { dispatchPhysicalWire: sourcePhysicalWire(context, "demo.fetch") }); }';

  assert.deepEqual(toolCodes(viaHelper, dispatched), []);
  for (const [execute, extra, expected] of [
    [viaHelper, 'async function download(url: string) { return requestPublicHttp(url); }', ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [viaHelper, 'const download = async (url: string) => fetch(url);', ['EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK', 'EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED']],
    [before('await withRetry(plain);'), 'const withRetry = (send) => send();\nconst plain = () => requestPublicHttp("https://x");', ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING']],
    [before('await helpers.get(input.url);'), 'const helpers = { get: (url: string) => requestPublicHttp(url) };', ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING']],
    [
      ALL_WIRES.replace('sourcePhysicalWire(ctx, "robots.public_http") }', 'sourcePhysicalWire(ctx, "robots.public_http"), request: plainRequest }'),
      'const plainRequest = (raw: string, options: object) => requestPublicHttp(raw, options);',
      ['EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING'],
    ],
  ]) assert.deepEqual(toolCodes(execute, extra), expected, extra);
});

test('a live platform Tool must be declared exactly once', () => {
  assert.deepEqual(codes(platformToolIssues(TOOL_PATH, tool(ALL_WIRES), 'missing.tool', WIRES)), ['EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND']);
  assert.deepEqual(
    codes(platformToolIssues(TOOL_PATH, `${tool(ALL_WIRES)}\nexport const copy = { id: "demo.fetch", execute: async (input, ctx) => null };`, 'demo.fetch', WIRES)),
    ['EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND'],
  );
});
