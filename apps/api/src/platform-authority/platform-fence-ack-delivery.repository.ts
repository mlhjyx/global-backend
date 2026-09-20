import { Prisma, type PrismaClient } from "@prisma/client";
import { attestExecutionBudgetPlatformWriterTransaction } from "../execution-budget/execution-budget-authority.repository";
import type { FenceAckCipherContext, EncryptedFenceAck } from "./platform-fence-ack-crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export interface StoredFenceAck extends FenceAckCipherContext, EncryptedFenceAck {}
function failure(): never { throw new Error("PLATFORM_FENCE_ACK_PERSISTENCE_UNAVAILABLE"); }
function valid(value: StoredFenceAck): boolean {
  return Boolean(value && UUID.test(value.receiptId) && SHA.test(value.commandSha256) && SHA.test(value.ackSha256) &&
    KEY.test(value.signingKeyId) && KEY.test(value.keyId) && Buffer.isBuffer(value.ciphertext) &&
    value.ciphertext.length >= 29 && value.ciphertext.length <= 16412);
}
function stored(rows: unknown, receiptId: string, commandSha: string, optional: boolean): StoredFenceAck | null {
  if (optional && Array.isArray(rows) && rows.length === 0) return null;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0] === null || typeof rows[0] !== "object") return failure();
  const row = rows[0];
  if (!(row.ciphertext instanceof Uint8Array)) return failure();
  const value: StoredFenceAck = { receiptId: row.receipt_id, commandSha256: row.command_token_sha256,
    ackSha256: row.ack_token_sha256, signingKeyId: row.signing_key_id, keyId: row.cipher_key_id, ciphertext: Buffer.from(row.ciphertext) };
  if (!valid(value) || value.receiptId !== receiptId || value.commandSha256 !== commandSha) return failure();
  return Object.freeze({ ...value, ciphertext: Buffer.from(value.ciphertext) });
}
/** Read and first-writer-wins insert only; no raw ACK JWS or app/owner fallback. */
export class PlatformFenceAckDeliveryRepository {
  constructor(private readonly writer?: Pick<PrismaClient, "$transaction"> | null) {}
  private async query(sql: Prisma.Sql): Promise<unknown> {
    if (!this.writer) return failure();
    return this.writer.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 5000");
      await attestExecutionBudgetPlatformWriterTransaction(tx);
      return tx.$queryRaw(sql);
    }, { maxWait: 1000, timeout: 5500 });
  }
  async read(receiptId: string, commandSha: string): Promise<StoredFenceAck | null> {
    try {
      if (!UUID.test(receiptId) || !SHA.test(commandSha)) return failure();
      return stored(await this.query(Prisma.sql`SELECT * FROM read_platform_fence_ack_v1(${receiptId}::uuid, ${commandSha}::text)`), receiptId, commandSha, true);
    } catch { return failure(); }
  }
  async store(value: StoredFenceAck): Promise<StoredFenceAck> {
    try {
      if (!valid(value)) return failure();
      const rows = await this.query(Prisma.sql`SELECT * FROM store_platform_fence_ack_v1(
        ${value.receiptId}::uuid, ${value.commandSha256}::text, ${value.ackSha256}::text,
        ${value.signingKeyId}::text, ${value.keyId}::text, ${value.ciphertext}::bytea)`);
      return stored(rows, value.receiptId, value.commandSha256, false)!;
    } catch { return failure(); }
  }
}
