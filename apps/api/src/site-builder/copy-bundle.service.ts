import {
  COPY_BUNDLE_SCHEMA_VERSION,
  COPY_BUNDLE_SET_SCHEMA_VERSION,
  COPY_SLOT_CATALOG_VERSION,
  copyBundleInputHash,
  finalizeCopyBundle,
  type CopyBundleSetV1,
  type CopySlotType,
  type RestrictedRichTextNode,
} from "@global/contracts";
import type {
  PublishableClaimSnapshot,
  PublishableClaimSnapshotItem,
} from "./publishable-claim-snapshot";

export interface CopySlotDefinition {
  key: string;
  type: CopySlotType;
  maxGraphemes: number;
  factual: boolean;
}

export interface CopySlotGeneratorInput {
  locale: string;
  sourceLocale: string;
  slot: CopySlotDefinition;
  snapshot: Pick<PublishableClaimSnapshot, "digest" | "items">;
}

export interface CopySlotGeneratorResult {
  content: string | RestrictedRichTextNode;
  claimRefs: string[];
}

export interface CopySlotGenerator {
  generateSlot(input: CopySlotGeneratorInput): Promise<CopySlotGeneratorResult>;
}

export class CopyBundleGenerationError extends Error {
  constructor(
    readonly code: "COPY_DEFAULT_LOCALE_FAILED" | "COPY_LOCALE_SET_INVALID",
    message: string,
    readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = "CopyBundleGenerationError";
  }
}

export interface GenerateCopyBundlesInput {
  locales: readonly string[];
  sourceLocale: string;
  snapshotId: string;
  snapshot: PublishableClaimSnapshot;
  slots: readonly CopySlotDefinition[];
  approvedOutboundDomains: readonly string[];
}

export interface GenerateCopyBundlesResult {
  set: CopyBundleSetV1;
  degradedLocales: string[];
}

const PROTECTED_FACT =
  /\b(?:ISO\s*\d{3,5}(?::\d{4})?|CE|FDA|UL|\d+(?:[.,]\d+)?\s*(?:%|bar|mbar|pa|kpa|mpa|psi|hz|khz|mhz|ghz|rpm|v|mv|kv|a|ma|w|kw|mw|mm|cm|m|km|mg|g|kg|lb|ml|l))\b/giu;

/** Tokens that translation/tone may not silently normalize or convert. */
export function protectedFactTokens(
  item: PublishableClaimSnapshotItem,
): string[] {
  return [...new Set(item.statement.match(PROTECTED_FACT) ?? [])].sort();
}

export class CopyBundleService {
  constructor(
    private readonly generator: CopySlotGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async generate(
    input: GenerateCopyBundlesInput,
  ): Promise<GenerateCopyBundlesResult> {
    if (
      input.locales.length === 0 ||
      input.locales[0] !== input.sourceLocale ||
      new Set(input.locales).size !== input.locales.length ||
      new Set(input.slots.map((slot) => slot.key)).size !== input.slots.length
    ) {
      throw new CopyBundleGenerationError(
        "COPY_LOCALE_SET_INVALID",
        "source locale must be first and locales/slots must be unique",
      );
    }

    const claims = new Map(
      input.snapshot.items.map((item) => [
        item.claimId,
        { protectedTokens: protectedFactTokens(item) },
      ]),
    );
    const bundles: CopyBundleSetV1["bundles"] = {};
    const degradedLocales: string[] = [];

    for (const locale of input.locales) {
      try {
        const generated = await Promise.all(
          input.slots.map(async (slot) => ({
            slot,
            output: await this.generator.generateSlot({
              locale,
              sourceLocale: input.sourceLocale,
              slot,
              snapshot: {
                digest: input.snapshot.digest,
                items: input.snapshot.items,
              },
            }),
          })),
        );
        const inputHash = copyBundleInputHash({
          claimSnapshotDigest: input.snapshot.digest,
          locale,
          sourceLocale: input.sourceLocale,
          slots: input.slots,
        });
        bundles[locale] = finalizeCopyBundle(
          {
            schemaVersion: COPY_BUNDLE_SCHEMA_VERSION,
            slotCatalogVersion: COPY_SLOT_CATALOG_VERSION,
            locale,
            sourceLocale: input.sourceLocale,
            status: "complete",
            claimSnapshot: {
              id: input.snapshotId,
              digest: input.snapshot.digest,
            },
            inputHash,
            slots: Object.fromEntries(
              generated.map(({ slot, output }) => [
                slot.key,
                {
                  type: slot.type,
                  maxGraphemes: slot.maxGraphemes,
                  factual: slot.factual,
                  content: output.content,
                  claimRefs: output.claimRefs,
                },
              ]),
            ),
          },
          {
            supportedLocales: [...input.locales],
            claims,
            approvedOutboundDomains: input.approvedOutboundDomains,
          },
        );
      } catch (error) {
        if (locale === input.sourceLocale) {
          throw new CopyBundleGenerationError(
            "COPY_DEFAULT_LOCALE_FAILED",
            `source locale ${locale} did not produce a valid CopyBundle`,
            error,
          );
        }
        degradedLocales.push(locale);
      }
    }

    return {
      set: {
        schemaVersion: COPY_BUNDLE_SET_SCHEMA_VERSION,
        sourceLocale: input.sourceLocale,
        bundles,
      },
      degradedLocales,
    };
  }
}
