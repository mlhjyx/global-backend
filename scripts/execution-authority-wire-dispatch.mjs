// Platform egress is authorized per physical wire. A live platform Tool passes
// sourcePhysicalWire(ctx, "<wire id>") to every adapter call, and an adapter
// sends only through the dispatcher it is given. Adapters fall back to a direct
// send when no dispatcher is passed (the customer path), so a Tool or adapter
// that drops the dispatcher would reach the network with no platform egress
// authorization, and ToolBroker would still accept the result. These checks
// keep that wiring in place without pinning whole files.
import ts from 'typescript';

export const PLATFORM_CONTRACT_PATH = 'apps/api/src/platform-authority/platform-execution-contract.ts';
const ADAPTER_DIRECTORY = 'apps/api/src/adapters/';

// Every exported adapter function that accepts a physical-wire dispatcher.
// A terminal adapter sends with `send` inside its executePhysicalWire closure;
// a forwarding adapter passes the dispatcher on to `forwardsTo`.
export const EXPECTED_WIRE_ADAPTERS = Object.freeze([
  Object.freeze({ path: 'apps/api/src/adapters/guarded-http.ts', name: 'requestPublicHttp', send: 'execute' }),
  Object.freeze({ path: 'apps/api/src/adapters/robots.ts', name: 'isAllowedByRobots', forwardsTo: 'requestPublicHttp' }),
  Object.freeze({ path: 'apps/api/src/adapters/trade-fair-algolia.ts', name: 'queryAlgoliaExhibitors', send: 'fetch' }),
  Object.freeze({ path: 'apps/api/src/adapters/web-crawler.ts', name: 'crawlHtml', send: 'fetch' }),
  Object.freeze({ path: 'apps/api/src/adapters/web-crawler.ts', name: 'crawlUrl', send: 'fetch' }),
]);

// Adapter-module functions a live platform Tool may call that never send.
export const EXPECTED_NON_WIRE_ADAPTER_CALLS = Object.freeze([
  'apps/api/src/adapters/bounded-fetch-response.ts#decodeJsonBytes',
]);

const NETWORK_MODULES = new Set(['http', 'https', 'net', 'tls', 'undici', 'node:http', 'node:https', 'node:net', 'node:tls']);

// The fail-closed core of sourcePhysicalWire, whitespace-normalized.
export const SOURCE_PHYSICAL_WIRE_BODY = [
  'const dispatch = ctx.dispatchPhysicalWire;',
  'if (ctx.workspaceId === "platform" && typeof dispatch !== "function") {',
  'throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");',
  '}',
  'return dispatch ? (execute) => dispatch(wireId, execute) : undefined;',
].join(' ');

function issue(code, path, message, producerId) {
  return Object.freeze(producerId ? { code, path, message, producerId } : { code, path, message });
}

function parse(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current)))
  ) current = current.expression;
  return current;
}

function descendants(root, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function within(node, container) {
  return node.pos >= container.pos && node.end <= container.end;
}

function propertyNamed(object, name) {
  return object.properties.find((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
    property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name);
}

function stringProperty(object, name) {
  const property = propertyNamed(object, name);
  const value = property && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function objectArrayProperty(object, name) {
  const property = propertyNamed(object, name);
  const value = property && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
  if (!value || !ts.isArrayLiteralExpression(value)) return undefined;
  const elements = value.elements.map(objectOf);
  return elements.every(Boolean) ? elements : undefined;
}

// An object literal, also through a single-object builder such as
// `technicalRow({ ... })` or `deepFreeze({ ... })`.
function objectOf(node) {
  let value = unwrap(node);
  if (value && ts.isCallExpression(value) && value.arguments.length === 1) value = unwrap(value.arguments[0]);
  return value && ts.isObjectLiteralExpression(value) ? value : undefined;
}

// Live platform Tool id -> the wire ids its dispatcher accepts, mirroring
// createPlatformToolWireDispatcher: a single-tool row allows all its wires, a
// multi-tool row only `<toolId>` and `<toolId>.*`. Null when unreadable.
export function livePlatformToolWires(contractSource) {
  const sourceFile = parse(PLATFORM_CONTRACT_PATH, contractSource);
  const declarations = descendants(sourceFile, (node) =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1');
  if (declarations.length !== 1) return null;
  const contract = objectOf(declarations[0].initializer);
  if (!contract) return null;
  const rows = objectArrayProperty(contract, 'rows');
  if (!rows) return null;
  const wires = new Map();
  for (const row of rows) {
    const costMode = stringProperty(row, 'costMode');
    const wireIds = objectArrayProperty(row, 'physicalWireContracts')?.map((wire) => stringProperty(wire, 'wireId'));
    const toolIds = objectArrayProperty(row, 'toolContracts')?.map((tool) => stringProperty(tool, 'toolId'));
    if (!costMode || !wireIds || !toolIds || [...wireIds, ...toolIds].some((value) => typeof value !== 'string')) return null;
    if (costMode === 'disabled_no_egress') continue;
    for (const toolId of toolIds) {
      if (wires.has(toolId)) return null;
      wires.set(toolId, toolIds.length === 1
        ? wireIds
        : wireIds.filter((wireId) => wireId === toolId || wireId.startsWith(`${toolId}.`)));
    }
  }
  return wires;
}

function isExported(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

// Exported functions of an adapter file that take a dispatcher, directly or
// through an options interface of the same file with that property.
export function dispatcherAdapterNames(path, source) {
  const sourceFile = parse(path, source);
  const carriers = new Set(descendants(sourceFile, (node) =>
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
    descendants(node, (member) => ts.isPropertySignature(member) && member.name.getText() === 'dispatchPhysicalWire').length > 0)
    .map((node) => node.name.text));
  const takesDispatcher = (parameters) => parameters.some((parameter) =>
    (ts.isIdentifier(parameter.name) && parameter.name.text === 'dispatchPhysicalWire') ||
    (parameter.type && ts.isTypeReferenceNode(parameter.type) && carriers.has(parameter.type.typeName.getText())));
  const names = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement) && takesDispatcher(statement.parameters)) {
      names.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
          takesDispatcher(value.parameters)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

function functionNamed(sourceFile, name) {
  const matches = descendants(sourceFile, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return matches.length === 1 ? matches[0] : null;
}

function calleeName(call) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

// Every send sits inside the one executePhysicalWire closure, and the closure
// runs only as `D ? await D(executePhysicalWire) : await executePhysicalWire()`
// where D is the given dispatcher.
export function terminalAdapterIssues(path, source, adapter) {
  const fn = functionNamed(parse(path, source), adapter.name);
  const fail = (message) => [issue('EXECUTION_AUTHORITY_WIRE_ADAPTER_SEND_UNDISPATCHED', path, `${adapter.name}: ${message}`)];
  if (!fn?.body) return fail('function not found');
  const closures = descendants(fn.body, (node) =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'executePhysicalWire');
  const closure = closures.length === 1 ? unwrap(closures[0].initializer) : undefined;
  if (!closure || !(ts.isArrowFunction(closure) || ts.isFunctionExpression(closure))) return fail('needs exactly one executePhysicalWire closure');
  const sends = descendants(fn.body, (node) => ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === adapter.send);
  if (sends.length === 0 || sends.some((send) => !within(send, closure))) return fail(`every ${adapter.send}() must sit inside executePhysicalWire`);
  const references = descendants(fn.body, (node) =>
    ts.isIdentifier(node) && node.text === 'executePhysicalWire' && node !== closures[0].name);
  const conditionals = descendants(fn.body, (node) => {
    if (!ts.isConditionalExpression(node)) return false;
    const test = unwrap(node.condition);
    const dispatched = unwrap(node.whenTrue);
    const direct = unwrap(node.whenFalse);
    return /(^|\.)dispatchPhysicalWire$/.test(test.getText()) &&
      ts.isCallExpression(dispatched) && unwrap(dispatched.expression).getText() === test.getText() &&
      dispatched.arguments.length === 1 && ts.isIdentifier(dispatched.arguments[0]) && dispatched.arguments[0].text === 'executePhysicalWire' &&
      ts.isCallExpression(direct) && ts.isIdentifier(direct.expression) && direct.expression.text === 'executePhysicalWire' &&
      direct.arguments.length === 0;
  });
  if (conditionals.length !== 1 || references.length !== 2 || references.some((reference) => !within(reference, conditionals[0]))) {
    return fail('executePhysicalWire must run only through `dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire()`');
  }
  return [];
}

function forwardedDispatcherValid(fn, property) {
  const value = ts.isShorthandPropertyAssignment(property) ? property.name : unwrap(property.initializer);
  if (ts.isPropertyAccessExpression(value) && value.name.text === 'dispatchPhysicalWire') return true;
  if (!ts.isIdentifier(value)) return false;
  // A local wrapper must be `given ? (execute) => ...given(execute)... : undefined`.
  const locals = descendants(fn, (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === value.text);
  const wrapper = locals.length === 1 ? unwrap(locals[0].initializer) : undefined;
  if (!wrapper || !ts.isConditionalExpression(wrapper)) return false;
  const given = unwrap(wrapper.condition).getText();
  const wrap = unwrap(wrapper.whenTrue);
  const none = unwrap(wrapper.whenFalse);
  if (!/\.dispatchPhysicalWire$/.test(given) || !ts.isIdentifier(none) || none.text !== 'undefined') return false;
  if (!(ts.isArrowFunction(wrap) || ts.isFunctionExpression(wrap)) || wrap.parameters.length !== 1) return false;
  const execute = wrap.parameters[0].name.getText();
  return descendants(wrap, (node) => ts.isCallExpression(node) && unwrap(node.expression).getText() === given &&
    node.arguments.length === 1 && node.arguments[0].getText() === execute).length > 0;
}

// Every call to the terminal adapter anywhere in the file sits inside the
// forwarding adapter and passes the dispatcher it was given.
export function forwardingAdapterIssues(path, source, adapter) {
  const sourceFile = parse(path, source);
  const fn = functionNamed(sourceFile, adapter.name);
  const fail = (message) => [issue('EXECUTION_AUTHORITY_WIRE_ADAPTER_FORWARD_MISSING', path, `${adapter.name}: ${message}`)];
  if (!fn?.body) return fail('function not found');
  const calls = descendants(sourceFile, (node) => ts.isCallExpression(node) &&
    descendants(unwrap(node.expression), (part) => ts.isIdentifier(part) && part.text === adapter.forwardsTo).length > 0 &&
    !ts.isTypeQueryNode(node.parent));
  if (calls.length === 0) return fail(`no ${adapter.forwardsTo}() call`);
  for (const call of calls) {
    if (!within(call, fn)) return fail(`${adapter.forwardsTo}() is called outside ${adapter.name}`);
    const carriers = call.arguments.map(unwrap).filter((argument) => ts.isObjectLiteralExpression(argument))
      .map((argument) => propertyNamed(argument, 'dispatchPhysicalWire')).filter(Boolean);
    if (carriers.length !== 1 || !forwardedDispatcherValid(fn, carriers[0])) {
      return fail(`${adapter.forwardsTo}() must receive the given dispatcher as dispatchPhysicalWire`);
    }
  }
  return [];
}

function normalizedText(node) {
  return node.getText().replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

export function sourcePhysicalWireIssues(path, source) {
  const fn = functionNamed(parse(path, source), 'sourcePhysicalWire');
  const body = fn?.body?.statements.map(normalizedText).join(' ');
  return body === SOURCE_PHYSICAL_WIRE_BODY
    ? []
    : [issue('EXECUTION_AUTHORITY_SOURCE_PHYSICAL_WIRE_DRIFT', path, 'sourcePhysicalWire must stay the fail-closed platform dispatcher accessor; review the change and update SOURCE_PHYSICAL_WIRE_BODY')];
}

// Tool object literals whose `id` is the Tool id, directly or through
// `const binding = platformExecutionToolContract("<id>")` + `binding.toolId`.
function toolObjects(sourceFile, toolId) {
  const bindings = new Set(descendants(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return false;
    const value = unwrap(node.initializer);
    return value && ts.isCallExpression(value) && ts.isIdentifier(value.expression) &&
      value.expression.text === 'platformExecutionToolContract' && value.arguments.length === 1 &&
      ts.isStringLiteralLike(value.arguments[0]) && value.arguments[0].text === toolId;
  }).map((node) => node.name.text));
  return descendants(sourceFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const id = propertyNamed(node, 'id');
    const value = id && ts.isPropertyAssignment(id) ? unwrap(id.initializer) : undefined;
    return Boolean(value) && (
      (ts.isStringLiteralLike(value) && value.text === toolId) ||
      (ts.isPropertyAccessExpression(value) && value.name.text === 'toolId' && ts.isIdentifier(value.expression) && bindings.has(value.expression.text)));
  });
}

function importSources(sourceFile, path) {
  const sources = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const module = specifier.startsWith('.')
      ? `${new URL(specifier, `file:///${path}`).pathname.slice(1)}.ts`
      : specifier;
    const clause = statement.importClause;
    if (clause?.name) sources.set(clause.name.text, { module, imported: 'default' });
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) sources.set(bindings.name.text, { module, imported: '*' });
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        sources.set(element.name.text, { module, imported: (element.propertyName ?? element.name).text });
      }
    }
  }
  return sources;
}

// The wire id of `sourcePhysicalWire(<ctx>, "<wire id>")`; undefined when the
// node is not such a call, null when it is malformed. A null ctxName accepts
// any identifier (a helper receives the context as a parameter).
function sourceWire(node, ctxName) {
  const call = unwrap(node);
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'sourcePhysicalWire') return undefined;
  const [ctx, wire] = call.arguments;
  return call.arguments.length === 2 && ts.isIdentifier(ctx) && (ctxName === null || ctx.text === ctxName) &&
    ts.isStringLiteralLike(wire) ? wire.text : null;
}

// A live platform Tool's execute body and the same-file helpers it reaches:
// every wire adapter call carries exactly one sourcePhysicalWire(ctx,
// "<declared wire>"), every declared wire is used, and nothing else there can
// reach the network (direct fetch, Node network modules, unregistered adapter
// functions). Functions imported from outside adapters/ are not followed.
export function platformToolIssues(path, source, toolId, allowedWires) {
  const sourceFile = parse(path, source);
  const objects = toolObjects(sourceFile, toolId);
  const fail = (code, message) => issue(code, path, `${toolId}: ${message}`, toolId);
  if (objects.length !== 1) return [fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND', 'expected exactly one Tool declaration')];
  const execute = propertyNamed(objects[0], 'execute');
  const fn = execute && ts.isPropertyAssignment(execute) ? unwrap(execute.initializer) : execute;
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) || fn.parameters.length < 2) {
    return [fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND', 'execute(input, ctx) not found')];
  }
  const imports = importSources(sourceFile, path);
  const helpers = localFunctions(sourceFile);
  const adapters = new Map(EXPECTED_WIRE_ADAPTERS.map((adapter) => [`${adapter.path}#${adapter.name}`, adapter]));
  const issues = [];
  const used = new Set();
  // execute itself and every same-file helper it reaches; in a helper the
  // context arrives as a parameter, so any identifier may carry it.
  const queue = [{ body: fn, ctxName: fn.parameters[1].name.getText() }];
  const visited = new Set();
  while (queue.length > 0) {
    const { body, ctxName } = queue.shift();
    if (visited.has(body)) continue;
    visited.add(body);
    for (const call of descendants(body, (node) => ts.isCallExpression(node))) {
      const callee = unwrap(call.expression);
      const root = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.expression.getText().split(/[.(]/)[0] : null;
      const origin = root ? imports.get(root) : undefined;
      if (ts.isIdentifier(callee) && !origin && helpers.has(callee.text)) {
        queue.push({ body: helpers.get(callee.text), ctxName: null });
        continue;
      }
      if (ts.isIdentifier(callee) && callee.text === 'fetch' && !origin) {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK', 'calls fetch() directly instead of a dispatched wire adapter'));
        continue;
      }
      if (origin && NETWORK_MODULES.has(origin.module)) {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK', `calls ${origin.module} directly instead of a dispatched wire adapter`));
        continue;
      }
      if (!origin || !origin.module.startsWith(ADAPTER_DIRECTORY)) continue;
      const key = `${origin.module}#${origin.imported}`;
      if (!adapters.has(key)) {
        if (!EXPECTED_NON_WIRE_ADAPTER_CALLS.includes(key)) {
          issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_ADAPTER_UNREGISTERED', `calls ${key}, which is neither a registered wire adapter nor a registered non-sending helper`));
        }
        continue;
      }
      const wires = call.arguments.flatMap((argument) => {
        const value = unwrap(argument);
        if (ts.isObjectLiteralExpression(value)) {
          const property = propertyNamed(value, 'dispatchPhysicalWire');
          return property && ts.isPropertyAssignment(property) ? [sourceWire(property.initializer, ctxName)] : property ? [null] : [];
        }
        const wire = sourceWire(value, ctxName);
        return wire === undefined ? [] : [wire];
      });
      if (wires.length !== 1 || typeof wires[0] !== 'string') {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', `${origin.imported}() must receive exactly one sourcePhysicalWire(ctx, "<wire id>")`));
        continue;
      }
      if (!allowedWires.includes(wires[0])) {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNDECLARED', `wire ${wires[0]} is not a physical wire the platform contract allows for this Tool`));
        continue;
      }
      used.add(wires[0]);
    }
  }
  for (const wire of allowedWires) {
    if (!used.has(wire)) issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED', `declared physical wire ${wire} is never dispatched`));
  }
  return issues;
}

// Top-level functions of the file, by name: declarations and const arrows.
function localFunctions(sourceFile) {
  const functions = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && statement.name.text !== 'sourcePhysicalWire') {
      functions.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
          functions.set(declaration.name.text, value);
        }
      }
    }
  }
  return functions;
}

export async function inspectPlatformWireDispatch({ readText, listFiles, toolSourcePaths }) {
  const issues = [];
  const contractPath = PLATFORM_CONTRACT_PATH;
  const toolWires = livePlatformToolWires(await readText(contractPath));
  if (!toolWires || toolWires.size === 0) {
    return [issue('EXECUTION_AUTHORITY_PLATFORM_WIRE_CONTRACT_UNREADABLE', contractPath, 'live platform Tools and their physical wires could not be read')];
  }
  const adapterPaths = (await listFiles(ADAPTER_DIRECTORY.slice(0, -1)))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'));
  const declared = [];
  for (const path of adapterPaths) {
    for (const name of dispatcherAdapterNames(path, await readText(path))) declared.push(`${path}#${name}`);
  }
  const expected = EXPECTED_WIRE_ADAPTERS.map((adapter) => `${adapter.path}#${adapter.name}`);
  if (declared.length !== expected.length || declared.some((key) => !expected.includes(key))) {
    issues.push(issue('EXECUTION_AUTHORITY_WIRE_ADAPTER_INVENTORY_MISMATCH', ADAPTER_DIRECTORY.slice(0, -1),
      `adapters that accept a physical-wire dispatcher must be exactly the registered ${expected.length}: found ${[...declared].sort().join(', ')}`));
  }
  for (const adapter of EXPECTED_WIRE_ADAPTERS) {
    const source = await readText(adapter.path);
    issues.push(...(adapter.send ? terminalAdapterIssues(adapter.path, source, adapter) : forwardingAdapterIssues(adapter.path, source, adapter)));
  }
  const sources = new Map();
  for (const path of toolSourcePaths) sources.set(path, await readText(path));
  for (const [toolId, wires] of toolWires) {
    const holders = [...sources].filter(([path, source]) => toolObjects(parse(path, source), toolId).length > 0);
    if (holders.length !== 1) {
      issues.push(issue('EXECUTION_AUTHORITY_PLATFORM_TOOL_NOT_FOUND', 'apps/api/src/tools', `${toolId}: expected exactly one Tool declaration`, toolId));
      continue;
    }
    const [path, source] = holders[0];
    issues.push(...sourcePhysicalWireIssues(path, source));
    issues.push(...platformToolIssues(path, source, toolId, wires));
  }
  const unique = new Map(issues.map((entry) => [`${entry.code} ${entry.path} ${entry.message}`, entry]));
  return [...unique.values()];
}
