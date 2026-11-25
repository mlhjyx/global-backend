import { createHash } from "node:crypto";
import { parseCanonicalMicrousd } from "../../tools/microusd";
import { buildTargetSnapshot } from "./enrichment-target-snapshot";
import {
  canonicalSafetyJson,
  closedSafetyRecord,
  deepFreezeSafety,
  EnrichmentSafetyError,
  invalidPlan,
  parseQuotedEnrichmentSlot,
  safetyDigest,
  safetyIdentifier,
  safetyInteger,
  type FrozenEnrichmentPlan,
  type QuotedEnrichmentSlot,
  type TrustedPlanInput,
} from "./enrichment-safety.contract";

/** No clock, registry, account opening or network: all authority facts precede this function. */
export function buildFrozenEnrichmentPlan(
  input: TrustedPlanInput,
): FrozenEnrichmentPlan {
  const row = closedSafetyRecord(input, [
    "workspaceId",
    "companyId",
    "entrypoint",
    "businessRunId",
    "requestSha256",
    "admittedAtMs",
    "deadlineAtMs",
    "targets",
    "slots",
    "limits",
  ]);
  if (row.entrypoint !== "http" && row.entrypoint !== "discovery_run")
    return invalidPlan();
  const entrypoint: TrustedPlanInput["entrypoint"] = row.entrypoint;
  if ((row.entrypoint === "http") !== (row.businessRunId === null))
    return invalidPlan();
  const admittedAtMs = safetyInteger(
    row.admittedAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const deadlineAtMs = safetyInteger(
    row.deadlineAtMs,
    admittedAtMs + 1,
    Number.MAX_SAFE_INTEGER,
  );
  if (deadlineAtMs - admittedAtMs > 600000) return invalidPlan();
  const rawLimits = closedSafetyRecord(row.limits, [
    "authorityCapMicrousd",
    "companyCapMicrousd",
    "contactCapMicrousd",
    "finderCompanyMax",
    "finderContactMax",
    "verifyAddressMax",
    "maxContacts",
  ]);
  const micro = (name: string): bigint => {
    const value = rawLimits[name];
    if (typeof value !== "string") return invalidPlan();
    return parseCanonicalMicrousd(name, value);
  };
  const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
  const authority = micro("authorityCapMicrousd");
  const company = min(
    micro("companyCapMicrousd"),
    authority,
    ...(row.entrypoint === "discovery_run" ? [500000n] : []),
  );
  const contact = min(micro("contactCapMicrousd"), 150000n);
  const limits = {
    authorityCapMicrousd: authority.toString(),
    companyCapMicrousd: company.toString(),
    contactCapMicrousd: contact.toString(),
    finderCompanyMax: safetyInteger(rawLimits.finderCompanyMax, 1, 10),
    finderContactMax: safetyInteger(rawLimits.finderContactMax, 1, 3),
    verifyAddressMax: safetyInteger(rawLimits.verifyAddressMax, 1, 6),
    maxContacts: safetyInteger(rawLimits.maxContacts, 1, 10),
  };
  const targets = buildTargetSnapshot(row.targets);
  if (
    targets.length > limits.maxContacts ||
    !Array.isArray(row.slots) ||
    row.slots.length > 70
  )
    return invalidPlan();
  const slots = row.slots.map(parseQuotedEnrichmentSlot);
  const byKey = new Map<string, QuotedEnrichmentSlot>();
  const targetMap = new Map(
    targets.map((target) => [target.contactId, target]),
  );
  const contactCosts = new Map<string, bigint>();
  const finderCounts = new Map<string, number>();
  const addressCounts = new Map<string, number>();
  let total = 0n;
  let finderTotal = 0;
  for (const slot of slots) {
    const target = targetMap.get(slot.contactId);
    if (
      !target ||
      target.contactOrdinal !== slot.contactOrdinal ||
      byKey.has(slot.slotKey)
    )
      return invalidPlan();
    byKey.set(slot.slotKey, slot);
    assertSupportedEnrichmentSlot(slot);
    const quote = parseCanonicalMicrousd("quoteMicrousd", slot.quoteMicrousd);
    if (slot.phase === "SMTP" && quote !== 0n) return invalidPlan();
    total += quote;
    contactCosts.set(
      slot.contactId,
      (contactCosts.get(slot.contactId) ?? 0n) + quote,
    );
    if (slot.phase === "FINDER") {
      if (slot.dependsOnSlotKey !== null) return invalidPlan();
      finderTotal += 1;
      finderCounts.set(
        slot.contactId,
        (finderCounts.get(slot.contactId) ?? 0) + 1,
      );
    } else if (slot.dependsOnSlotKey === null) return invalidPlan();
  }
  if (
    finderTotal > limits.finderCompanyMax ||
    [...finderCounts.values()].some((n) => n > limits.finderContactMax)
  )
    return invalidPlan();
  for (const slot of slots) {
    const seen = new Set<string>([slot.slotKey]);
    let current = slot;
    while (current.dependsOnSlotKey !== null) {
      const predecessor = byKey.get(current.dependsOnSlotKey);
      if (
        !predecessor ||
        predecessor.contactId !== slot.contactId ||
        seen.has(predecessor.slotKey)
      )
        return invalidPlan();
      seen.add(predecessor.slotKey);
      current = predecessor;
    }
    if (slot.phase !== "FINDER") {
      if (current.phase !== "FINDER") return invalidPlan();
      const count = (addressCounts.get(current.slotKey) ?? 0) + 1;
      addressCounts.set(current.slotKey, count);
      if (count > limits.verifyAddressMax) return invalidPlan();
    }
  }
  if (
    total > company ||
    total > authority ||
    [...contactCosts.values()].some((cost) => cost > contact)
  )
    throw new EnrichmentSafetyError("BUDGET_CAP_EXCEEDED");
  const body = {
    workspaceId: safetyIdentifier(row.workspaceId),
    companyId: safetyIdentifier(row.companyId),
    entrypoint,
    businessRunId:
      row.businessRunId === null ? null : safetyIdentifier(row.businessRunId),
    requestSha256: safetyDigest(row.requestSha256),
    admittedAtMs,
    deadlineAtMs,
    targets,
    slots,
    limits,
    version: 1 as const,
  };
  const planSha256 = createHash("sha256")
    .update(canonicalSafetyJson(body), "utf8")
    .digest("hex");
  return deepFreezeSafety({ ...body, planSha256 });
}

/** Shared closed producer check; never filters an unsupported reachable provider away. */
export function assertSupportedEnrichmentSlot(
  slot: QuotedEnrichmentSlot,
): void {
  const supported =
    slot.phase === "FINDER"
      ? (slot.provider === "hunter" &&
          slot.toolId === "contact_email.find.hunter") ||
        (slot.provider === "prospeo" &&
          slot.toolId === "contact_email.find.prospeo")
      : slot.phase === "SMTP"
        ? slot.provider === "smtp_self" && slot.toolId === "smtp.rcpt_probe"
        : slot.phase === "VERIFY" &&
          ["millionverifier", "emailable", "zerobounce"].includes(
            slot.provider,
          ) &&
          slot.toolId === "contact_email.verify." + slot.provider;
  if (!supported) throw new EnrichmentSafetyError("GOVERNANCE_PENDING");
  if (
    slot.phase === "SMTP" &&
    parseCanonicalMicrousd("SMTP quote", slot.quoteMicrousd) !== 0n
  )
    throw new EnrichmentSafetyError("CONTROL_MISMATCH");
}
