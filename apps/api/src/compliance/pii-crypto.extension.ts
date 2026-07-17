import { Prisma } from '@prisma/client';
import { encryptPii, decryptPii, isEncryptedPii } from './pii-crypto';

/**
 * 收口⑥ PII 透明加解密（Prisma v6 **client extension**）。挂在 PrismaService 上 →
 * canonical_contact.full_name / contact_point.value 的写路径自动加密、读路径自动解密（含嵌套 include），
 * **零调用点改动**（免漏改读点致密文泄进身份匹配）。确定性加密使 contact_point 唯一键/where-by-value 仍成立。
 *
 * 注：v6 已移除 `$use` 中间件（runtime undefined），故用 `$extends`。extension 的 `client` 组件重挂
 * withWorkspace（否则 $extends 会剥掉 PrismaService 自定义方法）。
 */

interface FieldSpec {
  field: string;
  /** contact_point：value 仅当同记录 type ∈ piiTypes 时加密（external_id 非 PII 不加密）。 */
  typeField?: string;
  piiTypes?: ReadonlySet<string>;
  /** where 复合键名（contact_point 的 contactId_type_value）。 */
  compositeWhereKey?: string;
}

const SPECS: Record<string, FieldSpec> = {
  CanonicalContact: { field: 'fullName' },
  ContactPoint: {
    field: 'value',
    typeField: 'type',
    piiTypes: new Set(['email', 'phone', 'linkedin']),
    compositeWhereKey: 'contactId_type_value',
  },
};

/** 记录对象（data/create/update/where 复合键）内目标字段加密（就地）。 */
function encryptRecord(rec: unknown, spec: FieldSpec): void {
  if (!rec || typeof rec !== 'object') return;
  const r = rec as Record<string, unknown>;
  const v = r[spec.field];
  if (typeof v !== 'string') return;
  if (spec.piiTypes) {
    const t = r[spec.typeField as string];
    if (typeof t !== 'string' || !spec.piiTypes.has(t)) return; // 无 type 上下文 / 非 PII → 不加密
  }
  r[spec.field] = encryptPii(v);
}

function encryptWhere(where: unknown, spec: FieldSpec): void {
  if (!where || typeof where !== 'object') return;
  const w = where as Record<string, unknown>;
  if (spec.compositeWhereKey && w[spec.compositeWhereKey]) encryptRecord(w[spec.compositeWhereKey], spec);
  if (typeof w[spec.field] === 'string') {
    if (spec.piiTypes) {
      const t = w[spec.typeField as string];
      if (typeof t !== 'string' || !spec.piiTypes.has(t)) return;
    }
    w[spec.field] = encryptPii(w[spec.field] as string);
  }
}

/** 依 operation 就地加密入参（导出供单测）。 */
export function encryptArgs(operation: string, args: Record<string, unknown> | undefined, spec: FieldSpec): void {
  if (!args) return;
  switch (operation) {
    case 'create':
      encryptRecord(args.data, spec);
      break;
    case 'createMany':
    case 'createManyAndReturn':
      if (Array.isArray(args.data)) args.data.forEach((d) => encryptRecord(d, spec));
      else encryptRecord(args.data, spec);
      break;
    case 'update':
    case 'updateMany':
      encryptRecord(args.data, spec);
      encryptWhere(args.where, spec);
      break;
    case 'upsert':
      encryptRecord(args.create, spec);
      encryptRecord(args.update, spec);
      encryptWhere(args.where, spec);
      break;
    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'findFirst':
    case 'findFirstOrThrow':
    case 'findMany':
    case 'count':
    case 'delete':
    case 'deleteMany':
      encryptWhere(args.where, spec);
      break;
    default:
      break;
  }
}

function decryptRecord(rec: unknown, spec: FieldSpec): void {
  if (!rec || typeof rec !== 'object') return;
  const r = rec as Record<string, unknown>;
  const v = r[spec.field];
  if (typeof v === 'string' && isEncryptedPii(v)) r[spec.field] = decryptPii(v);
}

/** 结果（对象或数组）内目标字段解密（导出供单测）。安全：只作用于 enc: 前缀，legacy 明文不动。 */
export function decryptResult<T>(result: T, spec: FieldSpec): T {
  if (Array.isArray(result)) {
    result.forEach((r) => decryptRecord(r, spec));
    return result;
  }
  decryptRecord(result, spec);
  return result;
}

/** 目标模型的字段规格（导出供单测）。 */
export function piiSpecFor(model: string | undefined): FieldSpec | undefined {
  return model ? SPECS[model] : undefined;
}

const CONTACT_SPEC = SPECS.CanonicalContact;
const POINT_SPEC = SPECS.ContactPoint;

/** 解密嵌套 include 里的 contact/contactPoint（company/lead 查询把它们嵌在结果里）。只作用于 enc: 前缀，安全。 */
function decryptNested(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(decryptNested);
    return;
  }
  const o = node as Record<string, unknown>;
  decryptRecord(o, CONTACT_SPEC);
  decryptRecord(o, POINT_SPEC);
  for (const key of ['contacts', 'contact', 'contactPoints']) {
    if (key in o) decryptNested(o[key]);
  }
}

/**
 * PII 透明加解密扩展。$allModels.$allOperations 对目标模型加密入参 / 解密结果；
 * 另对结果做浅层嵌套解密（覆盖 include: {contacts:{contactPoints}} 场景）。
 */
export const piiExtension = Prisma.defineExtension({
  name: 'pii-crypto',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const spec = piiSpecFor(model);
        if (spec) encryptArgs(operation, args as Record<string, unknown>, spec);
        const result = await query(args);
        if (spec) decryptResult(result, spec);
        decryptNested(result);
        return result;
      },
    },
  },
  client: {
    /** 重挂 withWorkspace（$extends 剥掉自定义方法）：设租户 RLS 上下文的事务包装。 */
    async withWorkspace<T>(
      workspaceId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { maxWait?: number; timeout?: number },
    ): Promise<T> {
      const ctx = Prisma.getExtensionContext(this) as unknown as {
        $transaction: (
          cb: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { maxWait?: number; timeout?: number },
        ) => Promise<T>;
      };
      return ctx.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return fn(tx);
      }, options);
    },
    /** NestJS 生命周期（$extends 会剥掉，故在 client 组件重挂，保持既有连接行为）。 */
    async onModuleInit(): Promise<void> {
      await (
        Prisma.getExtensionContext(this) as unknown as {
          $connect: () => Promise<void>;
        }
      ).$connect();
    },
    async onModuleDestroy(): Promise<void> {
      await (
        Prisma.getExtensionContext(this) as unknown as {
          $disconnect: () => Promise<void>;
        }
      ).$disconnect();
    },
  },
});
