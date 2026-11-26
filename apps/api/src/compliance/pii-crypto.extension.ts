import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { assertCandidateTenantAccess } from '../runtime/development-candidate';
import {
  isAuthorizedAppDatabasePrincipal,
  type DatabasePrincipalEvidence,
  type DatabaseReadiness,
} from '../prisma/prisma.service';
import {
  encryptPii,
  decryptPii,
  isEncryptedPii,
  PII_PURPOSE,
} from './pii-crypto';

/**
 * 收口⑥ PII 透明加解密（Prisma v6 **client extension**）。挂在 PrismaService 上 →
 * canonical_contact.full_name / contact_point.value 的写路径自动加密、读路径自动解密（含嵌套 include），
 * 并在 MT-P2 经 `withWorkspace` 的 `AsyncLocalStorage` 传递 `workspaceId` 以派生每租户 HKDF DEK + AAD。
 */

interface FieldSpec {
  field: string;
  purpose: string;
  /** contact_point：value 仅当同记录 type ∈ piiTypes 时加密（external_id 非 PII 不加密）。 */
  typeField?: string;
  piiTypes?: ReadonlySet<string>;
  /** where 复合键名（contact_point 的 contactId_type_value）。 */
  compositeWhereKey?: string;
}

const SPECS: Record<string, FieldSpec> = {
  CanonicalContact: {
    field: 'fullName',
    purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
  },
  ContactPoint: {
    field: 'value',
    purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    typeField: 'type',
    piiTypes: new Set(['email', 'phone', 'linkedin']),
    compositeWhereKey: 'contactId_type_value',
  },
};

const workspacePiiStorage = new AsyncLocalStorage<string>();

export function runWithWorkspacePiiContext<T>(workspaceId: string, fn: () => T): T {
  return workspacePiiStorage.run(workspaceId, fn);
}

export function currentWorkspacePiiContext(): string | undefined {
  return workspacePiiStorage.getStore();
}

function resolveWorkspaceId(
  contextWorkspaceId: string | undefined,
  explicitWorkspaceId: unknown,
): string | undefined {
  const ctxWs =
    typeof contextWorkspaceId === 'string' && contextWorkspaceId.trim().length > 0
      ? contextWorkspaceId.trim()
      : undefined;
  const expWs =
    typeof explicitWorkspaceId === 'string' && explicitWorkspaceId.trim().length > 0
      ? explicitWorkspaceId.trim()
      : undefined;
  if (ctxWs && expWs && ctxWs.toLowerCase() !== expWs.toLowerCase()) {
    throw new Error(
      'PII_WORKSPACE_CONTEXT_MISMATCH: record/where workspaceId conflicts with active workspace context',
    );
  }
  return expWs ?? ctxWs;
}

/** 记录对象（data/create/update/where 复合键）内目标字段加密（就地）。 */
function encryptRecord(
  rec: unknown,
  spec: FieldSpec,
  fallbackWorkspaceId?: string,
): void {
  if (!rec || typeof rec !== 'object') return;
  const r = rec as Record<string, unknown>;
  const v = r[spec.field];
  if (typeof v !== 'string') return;
  if (spec.piiTypes) {
    const t = r[spec.typeField as string];
    if (typeof t !== 'string' || !spec.piiTypes.has(t)) return; // 无 type 上下文 / 非 PII → 不加密
  }
  const workspaceId = resolveWorkspaceId(fallbackWorkspaceId, r.workspaceId);
  if (!workspaceId) {
    throw new Error('PII_WORKSPACE_REQUIRED: workspaceId is required for PII encryption');
  }
  r[spec.field] = encryptPii(v, { workspaceId, purpose: spec.purpose });
}

function encryptWhere(
  where: unknown,
  spec: FieldSpec,
  fallbackWorkspaceId?: string,
): void {
  if (!where || typeof where !== 'object') return;
  const w = where as Record<string, unknown>;
  const compositeKeyWs =
    w.workspaceId_dedupeKey && typeof w.workspaceId_dedupeKey === 'object'
      ? (w.workspaceId_dedupeKey as Record<string, unknown>).workspaceId
      : undefined;
  const whereWs = resolveWorkspaceId(fallbackWorkspaceId, w.workspaceId ?? compositeKeyWs);
  if (spec.compositeWhereKey && w[spec.compositeWhereKey]) {
    encryptRecord(w[spec.compositeWhereKey], spec, whereWs);
  }
  if (typeof w[spec.field] === 'string') {
    if (spec.piiTypes) {
      const t = w[spec.typeField as string];
      if (typeof t !== 'string' || !spec.piiTypes.has(t)) return;
    }
    if (!whereWs) {
      throw new Error('PII_WORKSPACE_REQUIRED: workspaceId is required for PII lookup');
    }
    w[spec.field] = encryptPii(w[spec.field] as string, {
      workspaceId: whereWs,
      purpose: spec.purpose,
    });
  }
}

/** 依 operation 就地加密入参（导出供单测）。 */
export function encryptArgs(
  operation: string,
  args: Record<string, unknown> | undefined,
  spec: FieldSpec,
  workspaceId = currentWorkspacePiiContext(),
): void {
  if (!args) return;
  const createWs =
    args.create && typeof args.create === 'object'
      ? resolveWorkspaceId(workspaceId, (args.create as Record<string, unknown>).workspaceId)
      : workspaceId;
  const dataWs =
    args.data && typeof args.data === 'object' && !Array.isArray(args.data)
      ? resolveWorkspaceId(workspaceId, (args.data as Record<string, unknown>).workspaceId)
      : workspaceId;
  switch (operation) {
    case 'create':
      encryptRecord(args.data, spec, workspaceId);
      break;
    case 'createMany':
    case 'createManyAndReturn':
      if (Array.isArray(args.data)) {
        args.data.forEach((d) => encryptRecord(d, spec, workspaceId));
      } else {
        encryptRecord(args.data, spec, workspaceId);
      }
      break;
    case 'update':
    case 'updateMany':
      encryptRecord(args.data, spec, dataWs);
      encryptWhere(args.where, spec, dataWs);
      break;
    case 'upsert':
      encryptRecord(args.create, spec, createWs);
      encryptRecord(args.update, spec, createWs);
      encryptWhere(args.where, spec, createWs);
      break;
    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'findFirst':
    case 'findFirstOrThrow':
    case 'findMany':
    case 'count':
    case 'delete':
    case 'deleteMany':
      encryptWhere(args.where, spec, workspaceId);
      break;
    default:
      break;
  }
}

function decryptRecord(
  rec: unknown,
  spec: FieldSpec,
  fallbackWorkspaceId?: string,
): void {
  if (!rec || typeof rec !== 'object') return;
  const r = rec as Record<string, unknown>;
  const v = r[spec.field];
  if (typeof v !== 'string') return;
  if (spec.piiTypes) {
    const t = r[spec.typeField as string];
    if (typeof t === 'string') {
      if (!spec.piiTypes.has(t)) return; // external_id 等非 PII 类型不解密
    } else if (!isEncryptedPii(v)) {
      return; // 未 select type 列且非密文时无法判定是否为 external_id，不误判
    }
  }
  const workspaceId = resolveWorkspaceId(fallbackWorkspaceId, r.workspaceId);
  if (!workspaceId) {
    throw new Error('PII_WORKSPACE_REQUIRED: workspaceId is required for PII decryption');
  }
  r[spec.field] = decryptPii(v, { workspaceId, purpose: spec.purpose });
}

/** 结果（对象或数组）内目标字段解密（导出供单测）；默认拒绝明文回退，非 PII 类型不触碰。 */
export function decryptResult<T>(
  result: T,
  spec: FieldSpec,
  workspaceId = currentWorkspacePiiContext(),
): T {
  if (Array.isArray(result)) {
    result.forEach((r) => decryptRecord(r, spec, workspaceId));
    return result;
  }
  decryptRecord(result, spec, workspaceId);
  return result;
}

/** 目标模型的字段规格（导出供单测）。 */
export function piiSpecFor(model: string | undefined): FieldSpec | undefined {
  return model ? SPECS[model] : undefined;
}

const CONTACT_SPEC = SPECS.CanonicalContact;
const POINT_SPEC = SPECS.ContactPoint;

const databaseReadiness = new WeakMap<object, DatabaseReadiness>();

function extensionContext(value: object): object & {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $queryRawUnsafe: <T>(query: string) => Promise<T>;
} {
  return Prisma.getExtensionContext(value) as unknown as object & {
    $connect: () => Promise<void>;
    $disconnect: () => Promise<void>;
    $queryRawUnsafe: <T>(query: string) => Promise<T>;
  };
}

/** 受限 app 角色的会话证据查询（启动自检与运维脚本共用；只读 pg_catalog，无 PII）。 */
export const DATABASE_PRINCIPAL_QUERY = `
  SELECT session_user::text AS "sessionUser",
         current_user::text AS "currentUser",
         principal.rolsuper AS "rolSuper",
         principal.rolbypassrls AS "rolBypassRls",
         principal.rolcreatedb AS "rolCreateDb",
         principal.rolcreaterole AS "rolCreateRole",
         principal.rolreplication AS "rolReplication",
         principal.rolinherit AS "rolInherit",
         COALESCE(
           array_agg(granted.rolname::text ORDER BY granted.rolname)
             FILTER (WHERE granted.rolname IS NOT NULL),
           ARRAY[]::text[]
         ) AS memberships
    FROM pg_roles principal
    LEFT JOIN pg_auth_members membership ON membership.member = principal.oid
    LEFT JOIN pg_roles granted ON granted.oid = membership.roleid
   WHERE principal.rolname = session_user
   GROUP BY principal.oid,
            principal.rolsuper,
            principal.rolbypassrls,
            principal.rolcreatedb,
            principal.rolcreaterole,
            principal.rolreplication,
            principal.rolinherit`;

async function reconnectDatabase(value: object): Promise<DatabaseReadiness> {
  const context = extensionContext(value);
  try {
    await context.$connect();
  } catch {
    const result = Object.freeze({
      status: 'not_ready' as const,
      code: 'DATABASE_UNAVAILABLE' as const,
    });
    databaseReadiness.set(context, result);
    console.error('[database] startup connection unavailable; readiness remains closed');
    return result;
  }
  let evidence: DatabasePrincipalEvidence[];
  try {
    evidence = await context.$queryRawUnsafe<DatabasePrincipalEvidence[]>(
      DATABASE_PRINCIPAL_QUERY,
    );
  } catch {
    const result = Object.freeze({
      status: 'not_ready' as const,
      code: 'DATABASE_UNAVAILABLE' as const,
    });
    databaseReadiness.set(context, result);
    console.error('[database] principal verification unavailable; readiness remains closed');
    return result;
  }
  if (evidence.length !== 1 || !isAuthorizedAppDatabasePrincipal(evidence[0])) {
    const result = Object.freeze({
      status: 'not_ready' as const,
      code: 'DATABASE_PRINCIPAL_INVALID' as const,
    });
    databaseReadiness.set(context, result);
    console.error('[database] runtime principal is not authorized; readiness remains closed');
    return result;
  }
  const result = Object.freeze({ status: 'ready' as const });
  databaseReadiness.set(context, result);
  return result;
}

/** 解密嵌套 include 里的 contacts/contact/contactPoints（仅作用于对应关系子节点，避免误伤其他带 value 列的非 PII 模型）。 */
function decryptNested(
  node: unknown,
  inheritedWorkspaceId = currentWorkspacePiiContext(),
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => decryptNested(item, inheritedWorkspaceId));
    return;
  }
  const o = node as Record<string, unknown>;
  const nodeWorkspaceId = resolveWorkspaceId(inheritedWorkspaceId, o.workspaceId);
  if ('contacts' in o) {
    decryptResult(o.contacts, CONTACT_SPEC, nodeWorkspaceId);
    decryptNested(o.contacts, nodeWorkspaceId);
  }
  if ('contact' in o) {
    decryptResult(o.contact, CONTACT_SPEC, nodeWorkspaceId);
    decryptNested(o.contact, nodeWorkspaceId);
  }
  if ('contactPoints' in o) {
    decryptResult(o.contactPoints, POINT_SPEC, nodeWorkspaceId);
    decryptNested(o.contactPoints, nodeWorkspaceId);
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
        const workspaceId = currentWorkspacePiiContext();
        const spec = piiSpecFor(model);
        if (spec) encryptArgs(operation, args as Record<string, unknown>, spec, workspaceId);
        const result = await query(args);
        if (spec) decryptResult(result, spec, workspaceId);
        decryptNested(result, workspaceId);
        return result;
      },
    },
  },
  client: {
    /** 重挂 withWorkspace（$extends 剥掉自定义方法）：设租户 RLS 上下文与 PII ALS 上下文的事务包装。 */
    async withWorkspace<T>(
      workspaceId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { maxWait?: number; timeout?: number },
    ): Promise<T> {
      assertCandidateTenantAccess(workspaceId);
      const ctx = Prisma.getExtensionContext(this) as unknown as {
        $transaction: (
          cb: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { maxWait?: number; timeout?: number },
        ) => Promise<T>;
      };
      return ctx.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return runWithWorkspacePiiContext(workspaceId, () => fn(tx));
      }, options);
    },
    /** NestJS 生命周期（$extends 会剥掉，故在 client 组件重挂，保持既有连接行为）。 */
    async onModuleInit(): Promise<void> {
      await reconnectDatabase(this);
    },
    async reconnect(): Promise<DatabaseReadiness> {
      return reconnectDatabase(this);
    },
    getReadiness(): DatabaseReadiness {
      const context = extensionContext(this);
      return (
        databaseReadiness.get(context) ?? {
          status: 'not_ready',
          code: 'DATABASE_UNAVAILABLE',
        }
      );
    },
    async onModuleDestroy(): Promise<void> {
      const context = extensionContext(this);
      try {
        await context.$disconnect();
      } finally {
        databaseReadiness.set(context, {
          status: 'not_ready',
          code: 'DATABASE_UNAVAILABLE',
        });
      }
    },
  },
});
