import { encryptPii, decryptPii, isEncryptedPii } from './pii-crypto';

/**
 * 收口⑥ PII 透明加解密（Prisma v6 中间件）。挂在 PrismaService 上 → 所有 canonical_contact.full_name /
 * contact_point.value 的写路径自动加密、读路径自动解密，**零调用点改动**（免漏改读点致密文泄进身份匹配）。
 * 确定性加密（见 pii-crypto）使 contact_point 的唯一键/where-by-value 在密文上仍成立。
 *
 * 注：用 v6 `$use` 而非 client `$extends`——后者会剥掉 PrismaService.withWorkspace 自定义方法。
 * 升级 Prisma 7 时迁移为 client extension。
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

/** 记录对象（data/create/update/where 复合键）内的目标字段加密（就地）。 */
function encryptRecord(rec: unknown, spec: FieldSpec): void {
  if (!rec || typeof rec !== 'object') return;
  const r = rec as Record<string, unknown>;
  const v = r[spec.field];
  if (typeof v !== 'string') return;
  if (spec.piiTypes) {
    const t = r[spec.typeField as string];
    // 无 type 上下文或非 PII 类型 → 不加密（避免误加密 external_id / 破坏语义）。
    if (typeof t !== 'string' || !spec.piiTypes.has(t)) return;
  }
  r[spec.field] = encryptPii(v);
}

function encryptWhere(where: unknown, spec: FieldSpec): void {
  if (!where || typeof where !== 'object') return;
  const w = where as Record<string, unknown>;
  if (spec.compositeWhereKey && w[spec.compositeWhereKey]) encryptRecord(w[spec.compositeWhereKey], spec);
  // 直接 where.field 简单等值（复杂 filter 对象跳过）。
  if (typeof w[spec.field] === 'string') {
    if (spec.piiTypes) {
      const t = w[spec.typeField as string];
      if (typeof t !== 'string' || !spec.piiTypes.has(t)) return;
    }
    w[spec.field] = encryptPii(w[spec.field] as string);
  }
}

/** 依 action 就地加密入参（导出供单测）。 */
export function encryptArgs(action: string, args: Record<string, unknown> | undefined, spec: FieldSpec): void {
  if (!args) return;
  switch (action) {
    case 'create':
      encryptRecord(args.data, spec);
      break;
    case 'createMany':
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
    case 'findFirst':
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

type MiddlewareParams = { model?: string; action: string; args: Record<string, unknown> };
type PrismaUse = { $use: (mw: (params: MiddlewareParams, next: (p: MiddlewareParams) => Promise<unknown>) => Promise<unknown>) => void };

/** 在 PrismaService 上注册 PII 透明加解密中间件。 */
export function applyPiiEncryption(prisma: PrismaUse): void {
  prisma.$use(async (params, next) => {
    const spec = piiSpecFor(params.model);
    if (!spec) return next(params);
    encryptArgs(params.action, params.args, spec);
    const result = await next(params);
    return decryptResult(result, spec);
  });
}
