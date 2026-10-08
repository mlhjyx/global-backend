import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

// Explicitly opted-in, disposable and migrated PostgreSQL only. PREPARE
// parses and plans each statement and DEALLOCATE drops it again: nothing is
// executed and nothing is written.
const databaseUrl = process.env.RAW_SQL_TYPES_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/global_test', '/raw_sql_types_test'].includes(url.pathname)
  ) {
    throw new Error('raw SQL type test requires a loopback test database');
  }
}

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The PostgreSQL type Prisma 6 binds for a raw query parameter. A string is
 * always `text`, so comparing it with a uuid column, or passing it to a uuid
 * argument, needs an explicit cast; an integer is `bigint`, so an `integer`
 * or `smallint` argument needs one too. The first test measures this table
 * against the database, so a Prisma upgrade that changes it fails here.
 */
const BOUND_TYPES: ReadonlyArray<readonly [string, unknown, string]> = [
  ['string', 'abc', 'text'],
  ['integer', 42, 'bigint'],
  ['fraction', 4.5, 'numeric'],
  ['bigint', 2n, 'bigint'],
  ['boolean', true, 'boolean'],
  ['Date', new Date('2026-10-08T00:00:00Z'), 'timestamp with time zone'],
  ['Buffer', Buffer.from('x'), 'bytea'],
  ['object', { a: 1 }, 'jsonb'],
  ['string[]', ['a'], 'text[]'],
  ['number[]', [1], 'bigint[]'],
];

const PARAMETER = '\u0000';
const STATEMENT = /^\s*(?:select|insert|update|delete|with)\b/iu;
const MAX_DEPTH = 6;
const MAX_VARIANTS = 16;
const UNCHECKABLE = Symbol('uncheckable');

interface Variant {
  readonly sql: string;
  readonly types: readonly string[];
}

interface Statement {
  readonly where: string;
  readonly variants: readonly Variant[];
}

/** Static TypeScript type of a parameter → the type Prisma binds (see BOUND_TYPES). */
function boundType(checker: ts.TypeChecker, type: ts.Type): string | typeof UNCHECKABLE {
  const value = checker.getNonNullableType(type);
  // A parameter that can only be null binds untyped, and PostgreSQL infers it.
  if (value.flags & ts.TypeFlags.Never) return 'unknown';
  if (value.isUnion()) {
    const members = new Set(value.types.map((member) => boundType(checker, member)));
    return members.size === 1 ? [...members][0]! : UNCHECKABLE;
  }
  if (value.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return UNCHECKABLE;
  if (value.flags & ts.TypeFlags.StringLike) return 'text';
  // A fractional number binds as numeric; counts, limits and attempts are integers.
  if (value.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) return 'bigint';
  if (value.flags & ts.TypeFlags.BooleanLike) return 'boolean';
  const name = (value.getSymbol() ?? value.aliasSymbol)?.getName();
  if (name === 'Date') return 'timestamptz';
  if (name === 'Buffer' || name === 'Uint8Array') return 'bytea';
  if (name === 'Decimal') return 'numeric';
  if (name === 'Sql') return UNCHECKABLE;
  if (checker.isArrayType(value)) {
    const [element] = checker.getTypeArguments(value as ts.TypeReference);
    const inner = element ? boundType(checker, element) : UNCHECKABLE;
    return inner === UNCHECKABLE || inner === 'unknown' ? UNCHECKABLE : `${inner}[]`;
  }
  if (value.flags & ts.TypeFlags.Object) return 'jsonb';
  return UNCHECKABLE;
}

function isPrismaMember(node: ts.Node, member: string): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === member &&
    node.expression.getText() === 'Prisma';
}

/** `Prisma.sql\`…\``, `tx.$queryRaw\`…\`` and `tx.$executeRaw\`…\``. */
function rawSqlTemplate(node: ts.Node): ts.TemplateLiteral | null {
  if (!ts.isTaggedTemplateExpression(node)) return null;
  const tag = node.tag;
  if (isPrismaMember(tag, 'sql')) return node.template;
  if (ts.isPropertyAccessExpression(tag) && ['$queryRaw', '$executeRaw'].includes(tag.name.text)) {
    return node.template;
  }
  return null;
}

function combine(left: readonly Variant[], right: readonly Variant[]): Variant[] {
  return left
    .flatMap((head) => right.map((tail) => ({ sql: head.sql + tail.sql, types: [...head.types, ...tail.types] })))
    .slice(0, MAX_VARIANTS);
}

function literal(sql: string): Variant[] {
  return [{ sql, types: [] }];
}

class RawSqlCollector {
  private readonly checker: ts.TypeChecker;

  constructor(private readonly program: ts.Program) {
    this.checker = program.getTypeChecker();
  }

  /** Every raw SQL statement in the program's own sources, expanded to its variants. */
  collect(rootNames: ReadonlySet<string>): { statements: Statement[]; uncheckable: string[] } {
    const statements: Statement[] = [];
    const uncheckable: string[] = [];
    for (const source of this.program.getSourceFiles()) {
      if (!rootNames.has(source.fileName)) continue;
      const visit = (node: ts.Node): void => {
        const template = rawSqlTemplate(node);
        // A template embedded in another one is checked as part of that statement.
        if (template && !ts.isTemplateSpan(node.parent)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const where = `${path.relative(API_ROOT, source.fileName)}:${line}`;
          const variants = this.template(template, 0);
          if (!variants) uncheckable.push(where);
          else if (variants.every((variant) => STATEMENT.test(variant.sql))) {
            statements.push({ where, variants });
          }
          // Otherwise it is a fragment, checked through the statements that embed it.
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return { statements, uncheckable };
  }

  private template(template: ts.TemplateLiteral, depth: number): Variant[] | null {
    if (ts.isNoSubstitutionTemplateLiteral(template)) return literal(template.text);
    let variants = literal(template.head.text);
    for (const span of template.templateSpans) {
      const piece = this.expression(span.expression, depth);
      if (!piece) return null;
      variants = combine(combine(variants, piece), literal(span.literal.text));
    }
    return variants;
  }

  private expression(node: ts.Expression, depth: number): Variant[] | null {
    if (depth > MAX_DEPTH) return null;
    if (ts.isParenthesizedExpression(node)) return this.expression(node.expression, depth);
    const nested = rawSqlTemplate(node);
    if (nested) return this.template(nested, depth + 1);
    if (isPrismaMember(node, 'empty')) return literal('');
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.expression(node.whenTrue, depth + 1);
      const whenFalse = this.expression(node.whenFalse, depth + 1);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse].slice(0, MAX_VARIANTS) : null;
    }
    if (ts.isCallExpression(node) && isPrismaMember(node.expression, 'raw')) {
      const [argument] = node.arguments;
      return argument && ts.isStringLiteralLike(argument) ? literal(argument.text) : null;
    }
    if (ts.isCallExpression(node) && isPrismaMember(node.expression, 'join')) {
      // One element stands for the joined list: the same type check applies to each.
      const [list] = node.arguments;
      const mapped = list && this.mappedTemplate(list);
      if (mapped) return this.template(mapped, depth + 1);
      const listType = list && this.checker.getTypeAtLocation(list);
      if (!listType || !this.checker.isArrayType(listType)) return null;
      const [element] = this.checker.getTypeArguments(listType as ts.TypeReference);
      return element ? this.parameter(element) : null;
    }
    const type = this.checker.getTypeAtLocation(node);
    if (ts.isIdentifier(node) && this.isSql(type)) {
      const declaration = this.checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (
        declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        return this.expression(declaration.initializer, depth + 1);
      }
      return null;
    }
    return this.parameter(type);
  }

  /** `ids.map((id) => Prisma.sql\`${id}::uuid\`)`: the template every element becomes. */
  private mappedTemplate(node: ts.Expression): ts.TemplateLiteral | null {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    if (node.expression.name.text !== 'map') return null;
    const [callback] = node.arguments;
    if (!callback || !ts.isArrowFunction(callback) || ts.isBlock(callback.body)) return null;
    return rawSqlTemplate(callback.body);
  }

  private parameter(type: ts.Type): Variant[] | null {
    const bound = boundType(this.checker, type);
    return bound === UNCHECKABLE ? null : [{ sql: PARAMETER, types: [bound] }];
  }

  private isSql(type: ts.Type): boolean {
    return (type.getSymbol() ?? type.aliasSymbol)?.getName() === 'Sql';
  }
}

function numbered(sql: string): string {
  const [head, ...rest] = sql.split(PARAMETER);
  return rest.reduce((text, piece, index) => `${text}$${index + 1}${piece}`, head ?? '');
}

function postgresError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = /Code: `([^`]+)`/u.exec(text)?.[1];
  const message = /Message: `([^`]+)`/u.exec(text)?.[1] ?? text.split('\n').at(-1);
  return code ? `${code} ${message}` : String(message);
}

function singleConnection(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

describe.runIf(Boolean(databaseUrl))('raw SQL parameter types on PostgreSQL', () => {
  const prisma = new PrismaClient({ datasourceUrl: singleConnection(databaseUrl ?? '') });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('binds raw query parameters with the types the checker assumes', async () => {
    for (const [label, value, expected] of BOUND_TYPES) {
      const rows = await prisma.$queryRaw<Array<{ bound: string }>>`SELECT pg_typeof(${value})::text AS bound`;
      expect(rows[0]?.bound, label).toBe(expected);
    }
  });

  it('prepares every raw SQL statement with the parameter types Prisma binds', async () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(API_ROOT, 'tsconfig.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    if (!parsed) throw new Error('apps/api/tsconfig.json did not parse');
    const rootNames = parsed.fileNames.filter((file) => !/\.(?:spec|test)\.ts$/u.test(file));
    const program = ts.createProgram(rootNames, { ...parsed.options, noEmit: true });
    const { statements, uncheckable } = new RawSqlCollector(program).collect(new Set(rootNames));

    // 2026-10-08: 172 statements. A sharp drop means the collector stopped
    // recognizing raw SQL, not that the code got safer.
    expect(statements.length).toBeGreaterThan(150);
    // A template the collector cannot expand would go unchecked. Give each
    // parameter a concrete type and each fragment a const, or teach the
    // collector the new shape.
    expect(uncheckable).toEqual([]);

    const failures: string[] = [];
    for (const [index, statement] of statements.entries()) {
      for (const [variantIndex, variant] of statement.variants.entries()) {
        const name = `raw_sql_type_check_${index}_${variantIndex}`;
        const declared = variant.types.length > 0 ? ` (${variant.types.join(', ')})` : '';
        try {
          await prisma.$executeRawUnsafe(`PREPARE ${name}${declared} AS ${numbered(variant.sql)}`);
          await prisma.$executeRawUnsafe(`DEALLOCATE ${name}`);
        } catch (error) {
          failures.push(`${statement.where} ${postgresError(error)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);
});
