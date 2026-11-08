import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelRuntimeError } from './errors';

/**
 * 密钥引用解析器（章节 §6.3.4，D6-3）：manifest 只存引用 `channel/<slug>/<keyName>`，
 * 值落在宿主受保护目录（file，默认）或环境变量（env，测试/临时），永不进 config/日志/API 响应。
 *
 * 引用语法就是路径白名单：slug/keyName 只允许 [A-Za-z0-9_.-]，不可能穿越目录。
 * 解析失败统一 `CHANNEL_SECRET_UNAVAILABLE`（不区分 not-found / 坏文件，防探测）；
 * 任何错误信息只含引用本身（引用不是秘密），绝不含值。
 */

export const CHANNEL_SECRET_REF_PATTERN = /^channel\/([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,64})$/u;

/** Nest 注入令牌（ChannelsModule 提供 env→file 的复合解析器）。 */
export const CHANNEL_SECRET_RESOLVER = 'CHANNEL_SECRET_RESOLVER';

export interface ResolvedChannelSecret {
  readonly value: string;
  readonly version: number;
  readonly provider: 'file' | 'env';
}

export interface ChannelSecretResolver {
  resolve(ref: string): Promise<ResolvedChannelSecret>;
}

export class ChannelSecretUnavailableError extends ChannelRuntimeError {
  constructor(ref: string) {
    super('CHANNEL_SECRET_UNAVAILABLE', `channel secret unavailable: ${ref}`);
    this.name = 'ChannelSecretUnavailableError';
  }
}

function parseRef(ref: string): { slug: string; keyName: string } | null {
  const match = CHANNEL_SECRET_REF_PATTERN.exec(ref);
  if (!match) return null;
  return { slug: match[1]!, keyName: match[2]! };
}

export interface FileChannelSecretResolverOptions {
  readonly rootDir: string;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/**
 * file：`<rootDir>/<slug>/<keyName>.v<N>.json`（目录 0700、文件 0600），内容 `{"value":"..."}`。
 * 不带版本取最大 N；轮换写 N+1，运行中的请求继续用旧版本，缓存 60s 后自然生效。
 */
export class FileChannelSecretResolver implements ChannelSecretResolver {
  private readonly rootDir: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; secret: ResolvedChannelSecret }>();

  constructor(options: FileChannelSecretResolverOptions) {
    this.rootDir = options.rootDir;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async resolve(ref: string): Promise<ResolvedChannelSecret> {
    const cached = this.cache.get(ref);
    if (cached && cached.expiresAt > this.now()) return cached.secret;
    const parsed = parseRef(ref);
    if (!parsed) throw new ChannelSecretUnavailableError(ref);
    const directory = join(this.rootDir, parsed.slug);
    let versions: number[];
    try {
      if (!statSync(directory).isDirectory()) throw new Error('not a directory');
      const prefix = `${parsed.keyName}.v`;
      versions = readdirSync(directory)
        .map((name) => {
          if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
          const raw = name.slice(prefix.length, -'.json'.length);
          return /^\d{1,9}$/u.test(raw) ? Number(raw) : null;
        })
        .filter((value): value is number => value !== null)
        .sort((a, b) => b - a);
    } catch {
      throw new ChannelSecretUnavailableError(ref);
    }
    if (versions.length === 0) throw new ChannelSecretUnavailableError(ref);
    const version = versions[0]!;
    let value: string;
    try {
      const payload = JSON.parse(
        readFileSync(join(directory, `${parsed.keyName}.v${version}.json`), 'utf8'),
      ) as { value?: unknown };
      if (typeof payload.value !== 'string' || payload.value.length === 0) {
        throw new Error('invalid secret payload');
      }
      value = payload.value;
    } catch {
      throw new ChannelSecretUnavailableError(ref);
    }
    const secret: ResolvedChannelSecret = { value, version, provider: 'file' };
    this.cache.set(ref, { expiresAt: this.now() + this.cacheTtlMs, secret });
    return secret;
  }
}

/** env：`CHANNEL_SECRET_<SLUG>_<KEY>`（大写，非字母数字转下划线）。只用于测试/临时接入。 */
export class EnvChannelSecretResolver implements ChannelSecretResolver {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async resolve(ref: string): Promise<ResolvedChannelSecret> {
    const parsed = parseRef(ref);
    if (!parsed) throw new ChannelSecretUnavailableError(ref);
    const key = `CHANNEL_SECRET_${parsed.slug}_${parsed.keyName}`.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
    const value = this.env[key];
    if (typeof value !== 'string' || value.length === 0) throw new ChannelSecretUnavailableError(ref);
    return { value, version: 1, provider: 'env' };
  }
}

/** 顺序回退：装配顺序即优先级（模块默认 [env, file]，env 作显式覆盖，file 是正式来源）。 */
export class CompositeChannelSecretResolver implements ChannelSecretResolver {
  private readonly resolvers: readonly ChannelSecretResolver[];

  constructor(resolvers: readonly ChannelSecretResolver[]) {
    this.resolvers = resolvers;
  }

  async resolve(ref: string): Promise<ResolvedChannelSecret> {
    for (const resolver of this.resolvers) {
      try {
        return await resolver.resolve(ref);
      } catch (error) {
        if (!(error instanceof ChannelSecretUnavailableError)) throw error;
      }
    }
    throw new ChannelSecretUnavailableError(ref);
  }
}
