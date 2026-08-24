import type {
  PatentRecord,
  PatentSearchOptions,
  RefreshInventorRow,
  RefreshScanResult,
} from "../adapters/bigquery-patents";
import type { PatentRefreshScanner } from "../adapters/patent-inventor-cache";
import { PLATFORM_WORKSPACE } from "../discovery/provider-contract";
import type { ExecutionBroker, ToolContext } from "../tools/tool-contract";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import type {
  GooglePatentsInput,
  GooglePatentsOutput,
} from "../tools/source-tools";

const MAX_PATENTS_PER_ANCHOR = 25;

function applicantFromAnchor(anchor: string): string {
  return anchor
    .replace(/^%/, "")
    .replace(/%$/, "")
    .replace(/\\([\\%_])/g, "$1");
}

function rowsFromPatents(
  patents: readonly PatentRecord[],
): RefreshInventorRow[] {
  const rows: RefreshInventorRow[] = [];
  for (const patent of patents) {
    if (patent.applicants.length !== 1) continue;
    const applicant = patent.applicants[0];
    if (!applicant?.name) continue;
    for (const inventor of patent.inventors) {
      if (!inventor.name) continue;
      rows.push({
        assigneeName: applicant.name,
        ...(applicant.country ? { assigneeCountry: applicant.country } : {}),
        inventorName: inventor.name,
      });
    }
  }
  return rows;
}

/**
 * Product Patent Cache scans are intentionally expressed as bounded,
 * individually replayable ToolBroker operations. The legacy batch BigQuery
 * scanner remains available only to explicit verification scripts.
 */
export function createPatentCacheBrokerScanner(input: {
  readonly broker: ExecutionBroker;
  readonly accountKey: string;
  readonly onDurableReceipt?: (
    producerId: string,
    receipt: DurableExecutionReceipt,
  ) => void;
}): PatentRefreshScanner {
  const context: ToolContext = Object.freeze({
    workspaceId: PLATFORM_WORKSPACE,
    runId: input.accountKey,
    correlationId: input.accountKey,
    purpose: "discovery",
    onDurableReceipt: input.onDurableReceipt,
  });
  return {
    async searchInventorsForAnchorsWithStats(
      anchors: string[],
      options: PatentSearchOptions,
    ): Promise<RefreshScanResult> {
      if (anchors.length === 0) {
        return { rows: [], bytesScanned: null, scanned: false };
      }
      const rows: RefreshInventorRow[] = [];
      let bytesScanned: number | null = null;
      let scanned = false;
      for (const anchor of anchors) {
        const applicant = applicantFromAnchor(anchor);
        if (!applicant) continue;
        const result = await input.broker.invoke<
          GooglePatentsInput,
          GooglePatentsOutput
        >(
          "google_patents.search",
          {
            applicant,
            fromYear: options.fromYear,
            toYear: options.toYear,
            maxRows: Math.min(
              options.maxRows ?? MAX_PATENTS_PER_ANCHOR,
              MAX_PATENTS_PER_ANCHOR,
            ),
          },
          context,
        );
        const costFacts = result.data.costFacts;
        const observedBytesBilled = costFacts.observedBytesBilled;
        const maximumBytesBilled = Number(costFacts.maximumBytesBilled);
        if (
          !["not_incurred", "estimated_upper_bound", "provider_reported"].includes(costFacts.costBasis) ||
          (observedBytesBilled !== null && typeof observedBytesBilled !== "string") ||
          !Number.isSafeInteger(maximumBytesBilled) ||
          maximumBytesBilled < 0
        ) {
          throw new Error("GOOGLE_PATENTS_COST_FACTS_UNAVAILABLE");
        }
        if (costFacts.costBasis === "not_incurred") {
          if (
            maximumBytesBilled !== 0 ||
            observedBytesBilled !== null ||
            costFacts.maxRows !== 0 ||
            (result.data.patents ?? []).length > 0
          ) {
            throw new Error("GOOGLE_PATENTS_COST_FACTS_UNAVAILABLE");
          }
          continue;
        }
        if (observedBytesBilled !== null) {
          const observedBytes = Number(observedBytesBilled);
          if (
            !Number.isSafeInteger(observedBytes) ||
            observedBytes < 0 ||
            observedBytes > maximumBytesBilled
          ) {
            throw new Error("GOOGLE_PATENTS_COST_FACTS_UNAVAILABLE");
          }
          bytesScanned = (bytesScanned ?? 0) + observedBytes;
        }
        scanned = true;
        rows.push(...rowsFromPatents(result.data.patents ?? []));
      }
      return { rows, bytesScanned, scanned };
    },
  };
}
