import {
  validateDesignBriefV2AgainstCatalog,
  type DesignBriefV2,
  type DesignCatalogV2,
  type SiteSpecComponentType,
} from '@global/contracts';
import type { CopySlotDefinition } from '../copy-bundle.service';
import { COMPONENT_ASSEMBLY_ADAPTERS } from './component-assembly-adapters';

export interface QualifiedComponentTemplateRepository {
  /** Returns a trusted M1-e-A fixture template, never model output. */
  get(componentType: SiteSpecComponentType): Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function slotKey(
  pageKey: string,
  sectionId: string,
  path: readonly (string | number)[],
): string {
  return `${pageKey}.${sectionId}.${path
    .map(String)
    .join('.')
    .replace(/key$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')}`.toLowerCase();
}

function semanticLimit(
  limits: Readonly<Record<string, number>>,
  property: string,
): number {
  const normalized = property
    .replace(/key$/i, '')
    .replace(/^q$/i, 'question')
    .replace(/^a$/i, 'answer')
    .replace(/^sub$/i, 'subhead')
    .replace(/^desc$/i, 'description')
    .toLowerCase();
  const exact = Object.entries(limits).find(
    ([key]) => key.toLowerCase() === normalized,
  )?.[1];
  if (exact !== undefined) return exact;
  const related = Object.entries(limits)
    .filter(
      ([key]) =>
        key.toLowerCase().includes(normalized) ||
        normalized.includes(key.toLowerCase()),
    )
    .map(([, value]) => value);
  if (related.length > 0) return Math.min(...related);
  const textLimits = Object.values(limits).filter((value) => value >= 24);
  return textLimits.length > 0 ? Math.min(...textLimits) : 24;
}

function collectTemplateSlots(input: {
  value: unknown;
  pageKey: string;
  sectionId: string;
  familyMaximum: number;
  componentLimits: Readonly<Record<string, number>>;
  factual: boolean;
  path?: Array<string | number>;
  output: CopySlotDefinition[];
}): void {
  const path = input.path ?? [];
  if (Array.isArray(input.value)) {
    input.value.forEach((item, index) =>
      collectTemplateSlots({ ...input, value: item, path: [...path, index] }),
    );
    return;
  }
  if (!record(input.value)) return;
  for (const [key, value] of Object.entries(input.value)) {
    const childPath = [...path, key];
    if (key.endsWith('Key') && typeof value === 'string') {
      input.output.push({
        key: slotKey(input.pageKey, input.sectionId, childPath),
        type: /body|description|intro|statement|answer/i.test(key)
          ? 'rich_text'
          : 'plain_text',
        maxGraphemes: Math.min(
          input.familyMaximum,
          semanticLimit(input.componentLimits, key),
        ),
        factual: input.factual,
      });
      continue;
    }
    collectTemplateSlots({
      ...input,
      value,
      path: childPath,
    });
  }
}

/** Derives the only copy surface the model may fill. */
export function deriveCopySlotDefinitions(input: {
  brief: DesignBriefV2;
  catalog: DesignCatalogV2;
  templates: QualifiedComponentTemplateRepository;
}): CopySlotDefinition[] {
  const family = validateDesignBriefV2AgainstCatalog(
    input.catalog,
    input.brief,
  );
  const output: CopySlotDefinition[] = [
    {
      key: 'footer.tagline',
      type: 'plain_text',
      maxGraphemes: 120,
      factual: false,
    },
  ];
  for (const [pageKey, blueprintId] of Object.entries(
    input.brief.blueprintIds,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const blueprint = family.blueprints[pageKey]?.find(
      (candidate) => candidate.id === blueprintId,
    );
    if (!blueprint) {
      throw new Error(
        `CONTROLLED_ASSEMBLY_BLUEPRINT_UNKNOWN: ${pageKey}/${blueprintId}`,
      );
    }
    output.push(
      {
        key: `nav.${pageKey}`,
        type: 'plain_text',
        maxGraphemes: 32,
        factual: false,
      },
      {
        key: `seo.${pageKey}.title`,
        type: 'seo_title',
        maxGraphemes: 60,
        factual: false,
      },
      {
        key: `seo.${pageKey}.description`,
        type: 'seo_description',
        maxGraphemes: 160,
        factual: false,
      },
    );
    const safeId = family.safeFallbackBlueprintIds[pageKey];
    const safe = family.blueprints[pageKey]?.find(
      (candidate) => candidate.id === safeId,
    );
    for (const selectedBlueprint of [
      blueprint,
      ...(safe && safe.id !== blueprint.id ? [safe] : []),
    ]) {
      for (const section of selectedBlueprint.sections) {
        const adapter =
          COMPONENT_ASSEMBLY_ADAPTERS[
            section.componentType as keyof typeof COMPONENT_ASSEMBLY_ADAPTERS
          ];
        if (!adapter) {
          throw new Error(
            `CONTROLLED_ASSEMBLY_ADAPTER_MISSING: ${section.componentType}`,
          );
        }
        const familyBudget = family.contentBudgets[section.contentBudgetKey];
        if (!familyBudget) {
          throw new Error(
            `CONTROLLED_ASSEMBLY_BUDGET_UNKNOWN: ${section.contentBudgetKey}`,
          );
        }
        collectTemplateSlots({
          value: input.templates.get(section.componentType),
          pageKey,
          sectionId: section.id,
          familyMaximum: familyBudget.maximum,
          componentLimits: adapter.copyLimits,
          factual: section.requiresEvidence,
          output,
        });
      }
    }
  }
  const unique = new Map(output.map((slot) => [slot.key, slot]));
  if (unique.size !== output.length) {
    throw new Error('CONTROLLED_ASSEMBLY_COPY_SLOT_DUPLICATE');
  }
  return [...unique.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}
