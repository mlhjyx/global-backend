// Platform egress is authorized per physical wire. A live platform Tool passes
// sourcePhysicalWire(ctx, "<wire id>") to every adapter call, and an adapter
// sends only through the dispatcher it is given. Adapters fall back to a direct
// send when no dispatcher is passed (the customer path), so a Tool or adapter
// that drops the dispatcher would reach the network with no platform egress
// authorization, and ToolBroker would still accept the result. These checks
// keep that wiring in place without pinning whole files. They are a tripwire
// against regressions, not the egress boundary itself: they read the Tool and
// adapter files, so a send hidden in a module they do not admit is reported,
// but one hidden inside an admitted module is out of their view.
import { posix } from 'node:path';
import ts from 'typescript';

export const PLATFORM_CONTRACT_PATH = 'apps/api/src/platform-authority/platform-execution-contract.ts';
const ADAPTER_DIRECTORY = 'apps/api/src/adapters';

// Every exported adapter function that accepts a physical-wire dispatcher.
// A terminal adapter sends once with `send` inside its executePhysicalWire
// closure; a forwarding adapter passes the dispatcher on to `forwardsTo`.
export const EXPECTED_WIRE_ADAPTERS = Object.freeze([
  Object.freeze({ path: 'apps/api/src/adapters/guarded-http.ts', name: 'requestPublicHttp', send: 'execute' }),
  Object.freeze({ path: 'apps/api/src/adapters/robots.ts', name: 'isAllowedByRobots', forwardsTo: 'requestPublicHttp' }),
  Object.freeze({ path: 'apps/api/src/adapters/trade-fair-algolia.ts', name: 'queryAlgoliaExhibitors', send: 'fetch' }),
  Object.freeze({ path: 'apps/api/src/adapters/web-crawler.ts', name: 'crawlHtml', send: 'fetch' }),
  Object.freeze({ path: 'apps/api/src/adapters/web-crawler.ts', name: 'crawlUrl', send: 'fetch' }),
]);

// The only other imported bindings a live platform Tool may reach; none of
// them sends. `<module>#*` admits every binding of that module.
export const EXPECTED_PLATFORM_TOOL_IMPORTS = Object.freeze([
  'apps/api/src/adapters/bounded-fetch-response.ts#decodeJsonBytes',
  'apps/api/src/adapters/guarded-http.ts#EgressBlockedError',
  'apps/api/src/execution-budget/execution-control-error.ts#ExecutionControlError',
  'apps/api/src/platform-authority/platform-execution-contract.ts#*',
  'apps/api/src/tools/tool-contract.ts#assertToolExternalActionAuthorized',
  'node:crypto#createHash',
]);

const NETWORK_MODULES = new Set([
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'child_process',
  'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:child_process',
  'undici', 'axios', 'node-fetch', 'got',
]);
const NETWORK_GLOBALS = new Set(['fetch', 'globalThis', 'global', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'require']);
const CONTRACT_BUILDERS = new Set(['deepFreeze', 'technicalRow']);

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
      ts.isAwaitExpression(current) || ts.isSatisfiesExpression(current))
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
  return Boolean(container) && node.pos >= container.pos && node.end <= container.end;
}

function inTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

// Identifiers that read a binding, as opposed to declaring one or naming a
// property, an import specifier or a type.
function references(root) {
  return descendants(root, (node) => {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) ||
        ts.isSetAccessor(parent)) && parent.name === node) ||
      ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) ||
      (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
      ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)
    ) return false;
    return !inTypePosition(node);
  });
}

// The call whose callee this identifier is (through `!`, parentheses and a
// member access on it), or undefined.
function calleeCall(identifier) {
  let current = identifier;
  if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) current = current.parent;
  while (ts.isNonNullExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isCallExpression(current.parent) && current.parent.expression === current ? current.parent : undefined;
}

function propertyNamed(object, name) {
  return object.properties.find((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
    property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name);
}

// An object literal, also through a known single-object builder such as
// `technicalRow({ ... })`; spreads make it unreadable (fail closed).
function objectOf(node) {
  let value = unwrap(node);
  if (value && ts.isCallExpression(value) && ts.isIdentifier(value.expression) &&
    CONTRACT_BUILDERS.has(value.expression.text) && value.arguments.length === 1) value = unwrap(value.arguments[0]);
  return value && ts.isObjectLiteralExpression(value) && !value.properties.some(ts.isSpreadAssignment) ? value : undefined;
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

// Live platform Tool id -> the wire ids its dispatcher accepts, mirroring
// createPlatformToolWireDispatcher: a single-tool row allows all its wires, a
// multi-tool row only `<toolId>` and `<toolId>.*`. Null when unreadable.
export function livePlatformToolWires(contractSource) {
  const sourceFile = parse(PLATFORM_CONTRACT_PATH, contractSource);
  const declarations = descendants(sourceFile, (node) =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1');
  const contract = declarations.length === 1 ? objectOf(declarations[0].initializer) : undefined;
  const rows = contract ? objectArrayProperty(contract, 'rows') : undefined;
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

// Top-level declarations by name: functions, and variables with their whole
// declaration (so an object of methods or a callback is followed too).
function topLevelDeclarations(sourceFile) {
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isClassDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
    }
  }
  return declarations;
}

// A top-level function-like declaration: `function name` or `const name = () =>`.
function functionNamed(sourceFile, name) {
  const declaration = topLevelDeclarations(sourceFile).get(name);
  if (declaration && ts.isFunctionDeclaration(declaration)) return declaration.body ? declaration : null;
  const value = declaration && ts.isVariableDeclaration(declaration) ? unwrap(declaration.initializer) : undefined;
  return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : null;
}

function importSources(sourceFile, path) {
  const sources = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const module = specifier.startsWith('.')
      ? `${posix.join(posix.dirname(path), specifier).replace(/\.(?:m?js|ts)$/, '')}.ts`
      : specifier;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (clause?.name) sources.set(clause.name.text, { module, imported: 'default' });
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) sources.set(bindings.name.text, { module, imported: '*' });
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) sources.set(element.name.text, { module, imported: (element.propertyName ?? element.name).text });
      }
    }
  }
  return sources;
}

const wireAdapterKey = (origin) => `${origin.module}#${origin.imported}`;
const WIRE_ADAPTER_KEYS = new Set(EXPECTED_WIRE_ADAPTERS.map((adapter) => `${adapter.path}#${adapter.name}`));

// Names in an adapter file that can send: network globals and imports, the
// registered wire adapters, and every top-level declaration reaching one.
function senderNames(path, sourceFile, extra) {
  const names = new Set([...NETWORK_GLOBALS, ...extra]);
  for (const [local, origin] of importSources(sourceFile, path)) {
    if (NETWORK_MODULES.has(origin.module) || WIRE_ADAPTER_KEYS.has(wireAdapterKey(origin))) names.add(local);
  }
  for (const adapter of EXPECTED_WIRE_ADAPTERS) if (adapter.path === path) names.add(adapter.name);
  const declarations = topLevelDeclarations(sourceFile);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, declaration] of declarations) {
      if (!names.has(name) && references(declaration).some((reference) => names.has(reference.text))) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

function isAssignment(node) {
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

// The dispatcher test must read the function's own parameter
// (`dispatchPhysicalWire` or `<param>.dispatchPhysicalWire`), and nothing in
// the function may reassign, delete or shadow it.
function dispatcherParameterIssue(fn, test) {
  const parameters = new Set(fn.parameters.map((parameter) => parameter.name.getText()));
  const root = ts.isIdentifier(test) ? test : ts.isPropertyAccessExpression(test) && ts.isIdentifier(test.expression) ? test.expression : null;
  if (!root || !parameters.has(root.text) || (ts.isPropertyAccessExpression(test) && test.name.text !== 'dispatchPhysicalWire') ||
    (ts.isIdentifier(test) && test.text !== 'dispatchPhysicalWire')) {
    return 'the dispatch test must read the function\'s own dispatcher parameter';
  }
  const touched = descendants(fn.body, (node) =>
    (isAssignment(node) && [test.getText(), root.text].includes(unwrap(node.left).getText())) ||
    (ts.isDeleteExpression(node) && unwrap(node.expression).getText() === test.getText()) ||
    ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) && node.name.text === root.text && !fn.parameters.includes(node)));
  return touched.length > 0 ? `${root.text} must not be reassigned, deleted or shadowed` : null;
}

function loopBetween(node, container) {
  for (let current = node.parent; current && current !== container; current = current.parent) {
    if (ts.isIterationStatement(current, false)) return true;
  }
  return false;
}

// Every send sits inside the one executePhysicalWire closure, which sends once
// and runs only as `D ? await D(executePhysicalWire) : await executePhysicalWire()`
// where D is the function's own dispatcher parameter.
export function terminalAdapterIssues(path, source, adapter) {
  const sourceFile = parse(path, source);
  const fn = functionNamed(sourceFile, adapter.name);
  const fail = (message) => [issue('EXECUTION_AUTHORITY_WIRE_ADAPTER_SEND_UNDISPATCHED', path, `${adapter.name}: ${message}`)];
  if (!fn?.body) return fail('function not found');
  const closures = descendants(fn.body, (node) =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'executePhysicalWire');
  const closure = closures.length === 1 ? unwrap(closures[0].initializer) : undefined;
  if (!closure || !(ts.isArrowFunction(closure) || ts.isFunctionExpression(closure))) return fail('needs exactly one executePhysicalWire closure');
  const aliases = descendants(fn.body, (node) =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === adapter.send);
  if (aliases.length > 1) return fail(`${adapter.send} is declared more than once`);
  const senders = senderNames(path, sourceFile, [adapter.send]);
  const stray = references(fn.body).filter((reference) => senders.has(reference.text) &&
    !within(reference, closure) && !(aliases[0] && within(reference, aliases[0].initializer)));
  if (stray.length > 0) return fail(`${stray[0].text} can send outside executePhysicalWire`);
  const inside = references(closure).filter((reference) => senders.has(reference.text));
  const sends = inside.filter((reference) => reference.text === adapter.send && calleeCall(reference));
  if (sends.length !== 1 || inside.length !== 1 || loopBetween(sends[0], closure)) {
    return fail(`executePhysicalWire must make exactly one ${adapter.send}() call, outside any loop, and no other send`);
  }
  const references_ = references(fn.body).filter((reference) => reference.text === 'executePhysicalWire');
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
  if (conditionals.length !== 1 || references_.length !== 2 || references_.some((reference) => !within(reference, conditionals[0]))) {
    return fail('executePhysicalWire must run only through `dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire()`');
  }
  const parameterIssue = dispatcherParameterIssue(fn, unwrap(conditionals[0].condition));
  return parameterIssue ? fail(parameterIssue) : [];
}

function forwardedDispatcherIssue(fn, property) {
  const value = ts.isShorthandPropertyAssignment(property) ? property.name : unwrap(property.initializer);
  if (ts.isPropertyAccessExpression(value)) return dispatcherParameterIssue(fn, value);
  if (!ts.isIdentifier(value)) return 'the dispatcher must be passed by name';
  // A local wrapper must be `given ? (execute) => ...given(execute)... : undefined`
  // and run execute only through the given dispatcher.
  const locals = descendants(fn, (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === value.text);
  const wrapper = locals.length === 1 ? unwrap(locals[0].initializer) : undefined;
  if (!wrapper || !ts.isConditionalExpression(wrapper)) return 'the forwarded dispatcher must be the given one or a wrapper of it';
  const given = unwrap(wrapper.condition);
  const wrap = unwrap(wrapper.whenTrue);
  const none = unwrap(wrapper.whenFalse);
  if (!ts.isIdentifier(none) || none.text !== 'undefined' || !(ts.isArrowFunction(wrap) || ts.isFunctionExpression(wrap)) ||
    wrap.parameters.length !== 1 || !ts.isIdentifier(wrap.parameters[0].name)) {
    return 'the dispatcher wrapper must be `given ? (execute) => given(execute) : undefined`';
  }
  const parameterIssue = dispatcherParameterIssue(fn, given);
  if (parameterIssue) return parameterIssue;
  const execute = wrap.parameters[0].name.text;
  const uses = references(wrap.body).filter((reference) => reference.text === execute);
  const routed = uses.filter((reference) => {
    const call = reference.parent;
    return ts.isCallExpression(call) && call.arguments.length === 1 && call.arguments[0] === reference &&
      unwrap(call.expression).getText() === given.getText();
  });
  return uses.length > 0 && routed.length === uses.length ? null : 'the dispatcher wrapper may run execute only through the given dispatcher';
}

// Every reference to the terminal adapter anywhere in the file is the callee
// of a call inside the forwarding adapter that passes the dispatcher it was
// given.
export function forwardingAdapterIssues(path, source, adapter) {
  const sourceFile = parse(path, source);
  const fn = functionNamed(sourceFile, adapter.name);
  const fail = (message) => [issue('EXECUTION_AUTHORITY_WIRE_ADAPTER_FORWARD_MISSING', path, `${adapter.name}: ${message}`)];
  if (!fn?.body) return fail('function not found');
  const uses = references(sourceFile).filter((reference) => reference.text === adapter.forwardsTo);
  if (uses.length === 0) return fail(`no ${adapter.forwardsTo}() call`);
  for (const use of uses) {
    if (!within(use, fn)) return fail(`${adapter.forwardsTo} is used outside ${adapter.name}`);
    const call = descendants(fn, (node) => ts.isCallExpression(node) && within(use, node.expression))
      .sort((left, right) => (left.end - left.pos) - (right.end - right.pos))[0];
    if (!call) return fail(`${adapter.forwardsTo} may only be called, not passed on as a value`);
    const carriers = call.arguments.map(unwrap).filter((argument) => ts.isObjectLiteralExpression(argument))
      .map((argument) => propertyNamed(argument, 'dispatchPhysicalWire')).filter(Boolean);
    const problem = carriers.length === 1 ? forwardedDispatcherIssue(fn, carriers[0]) : 'the dispatcher is not passed';
    if (problem) return fail(`${adapter.forwardsTo}(): ${problem}`);
  }
  return [];
}

function normalizedText(node) {
  return node.getText().replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

export function sourcePhysicalWireIssues(path, source) {
  const sourceFile = parse(path, source);
  const fn = functionNamed(sourceFile, 'sourcePhysicalWire');
  const bindings = descendants(sourceFile, (node) =>
    (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
      ts.isImportSpecifier(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === 'sourcePhysicalWire');
  const body = fn && ts.isFunctionDeclaration(fn) ? fn.body.statements.map(normalizedText).join(' ') : undefined;
  return bindings.length === 1 && body === SOURCE_PHYSICAL_WIRE_BODY
    ? []
    : [issue('EXECUTION_AUTHORITY_SOURCE_PHYSICAL_WIRE_DRIFT', path, 'sourcePhysicalWire must stay the single fail-closed platform dispatcher accessor; review the change and update SOURCE_PHYSICAL_WIRE_BODY')];
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

function admittedImport(origin) {
  return EXPECTED_PLATFORM_TOOL_IMPORTS.includes(`${origin.module}#${origin.imported}`) ||
    EXPECTED_PLATFORM_TOOL_IMPORTS.includes(`${origin.module}#*`);
}

function dispatchedWires(call, ctxName) {
  return call.arguments.flatMap((argument) => {
    const value = unwrap(argument);
    if (ts.isObjectLiteralExpression(value)) {
      const property = propertyNamed(value, 'dispatchPhysicalWire');
      return property && ts.isPropertyAssignment(property) ? [sourceWire(property.initializer, ctxName)] : property ? [null] : [];
    }
    const wire = sourceWire(value, ctxName);
    return wire === undefined ? [] : [wire];
  });
}

// A live platform Tool's execute and every same-file declaration it reaches
// (called, passed as a callback or used as an object of methods): each wire
// adapter is called directly with exactly one sourcePhysicalWire(ctx,
// "<declared wire>"), every declared wire is used, and nothing else there can
// reach the network: no network global or module, no dynamic import, and no
// imported binding outside EXPECTED_PLATFORM_TOOL_IMPORTS.
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
  const declarations = topLevelDeclarations(sourceFile);
  const issues = [];
  const used = new Set();
  const queue = [{ node: fn, ctxName: fn.parameters[1].name.getText() }];
  const visited = new Set();
  while (queue.length > 0) {
    const { node, ctxName } = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);
    if (descendants(node, (child) => ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword).length > 0) {
      issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_IMPORT_UNREGISTERED', 'uses a dynamic import()'));
    }
    for (const reference of references(node)) {
      const name = reference.text;
      const origin = imports.get(name);
      if (origin && WIRE_ADAPTER_KEYS.has(wireAdapterKey(origin))) {
        const call = calleeCall(reference);
        if (!call || call.expression !== reference && unwrap(call.expression) !== reference) {
          issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', `${name} must be called directly, not used as a value`));
          continue;
        }
        const wires = dispatchedWires(call, ctxName);
        if (wires.length !== 1 || typeof wires[0] !== 'string') {
          issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_MISSING', `${origin.imported}() must receive exactly one sourcePhysicalWire(ctx, "<wire id>")`));
        } else if (!allowedWires.includes(wires[0])) {
          issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNDECLARED', `wire ${wires[0]} is not a physical wire the platform contract allows for this Tool`));
        } else {
          used.add(wires[0]);
        }
      } else if (origin && NETWORK_MODULES.has(origin.module)) {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK', `uses ${origin.module} directly instead of a dispatched wire adapter`));
      } else if (origin && !admittedImport(origin)) {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_IMPORT_UNREGISTERED', `reaches ${origin.module}#${origin.imported}, which is neither a registered wire adapter nor in EXPECTED_PLATFORM_TOOL_IMPORTS`));
      } else if (!origin && NETWORK_GLOBALS.has(name) && !declarations.has(name)) {
        issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_DIRECT_NETWORK', `uses ${name} directly instead of a dispatched wire adapter`));
      } else if (!origin && name !== 'sourcePhysicalWire' && declarations.has(name)) {
        queue.push({ node: declarations.get(name), ctxName: null });
      }
    }
  }
  for (const wire of allowedWires) {
    if (!used.has(wire)) issues.push(fail('EXECUTION_AUTHORITY_PLATFORM_TOOL_WIRE_UNUSED', `declared physical wire ${wire} is never dispatched`));
  }
  return issues;
}

export async function inspectPlatformWireDispatch({ readText, listFiles, toolSourcePaths }) {
  const issues = [];
  const toolWires = livePlatformToolWires(await readText(PLATFORM_CONTRACT_PATH));
  if (!toolWires || toolWires.size === 0) {
    return [issue('EXECUTION_AUTHORITY_PLATFORM_WIRE_CONTRACT_UNREADABLE', PLATFORM_CONTRACT_PATH, 'live platform Tools and their physical wires could not be read')];
  }
  const adapterPaths = (await listFiles(ADAPTER_DIRECTORY)).filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'));
  const declared = [];
  for (const path of adapterPaths) {
    for (const name of dispatcherAdapterNames(path, await readText(path))) declared.push(`${path}#${name}`);
  }
  if (declared.length !== WIRE_ADAPTER_KEYS.size || declared.some((key) => !WIRE_ADAPTER_KEYS.has(key))) {
    issues.push(issue('EXECUTION_AUTHORITY_WIRE_ADAPTER_INVENTORY_MISMATCH', ADAPTER_DIRECTORY,
      `adapters that accept a physical-wire dispatcher must be exactly the registered ${WIRE_ADAPTER_KEYS.size}: found ${[...declared].sort().join(', ')}`));
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
