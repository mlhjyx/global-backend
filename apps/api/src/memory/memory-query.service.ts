import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MEMORY_SCOPE_TYPES,
  MEMORY_WORKFLOW_DISCOVERY,
  MemoryScopeType,
  MemorySemanticConfig,
  readMemorySemanticConfig,
  wilsonInterval,
} from './memory.contracts';

export interface MemoryScopeRef {
  type: MemoryScopeType;
  key: string;
}

export interface RunEpisodeView {
  id: string;
  phase: string;
  occurredAt: string;
  sourceEventId: string;
  payload: unknown;
  provenance: unknown;
  privacyClassification: string;
}

export interface KnowledgeStatView {
  id: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  statKey: string;
  successes: number;
  failures: number;
  n: number;
  rate: number;
  ciLow: number;
  ciHigh: number;
  mayInfluenceStrategy: boolean;
  usage: 'eligible' | 'hint_only';
  validFrom: string;
  validTo: string | null;
  provenance: unknown;
}

export interface MemoryBrief {
  text: string;
  citations: Array<{
    table: 'mem_run_episode' | 'mem_knowledge_stat';
    id: string;
    sourceEventId?: string;
    validFrom?: string;
  }>;
  tokenEstimate: number;
  truncated: boolean;
  semanticEnabled: boolean;
}

export interface BuildMemoryBriefInput {
  workflowType?: string;
  runId?: string;
  scopes?: MemoryScopeRef[];
  maxTokens?: number;
}

function assertScopes(scopes: MemoryScopeRef[]): void {
  for (const scope of scopes) {
    if (!(MEMORY_SCOPE_TYPES as readonly string[]).includes(scope.type)) {
      throw new Error(`unknown memory scope type '${scope.type}'`);
    }
    if (scope.key.length === 0 || scope.key.length > 200) {
      throw new Error('memory scope key must be 1..200 characters');
    }
  }
}

/**
 * D-MA-7 memory retrieval (v0): SQL exact/hierarchical reads + a cited brief.
 * All reads run through app_user + withWorkspace, so RLS enforces tenant scope.
 * No LLM, no embeddings, no ToolBroker.
 */
@Injectable()
export class MemoryQueryService {
  private readonly semanticConfig: MemorySemanticConfig;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() config?: MemorySemanticConfig,
  ) {
    this.semanticConfig = config ?? readMemorySemanticConfig();
  }

  async getRunEpisodes(
    workspaceId: string,
    input: { workflowType?: string; runId: string },
  ): Promise<RunEpisodeView[]> {
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const rows = await tx.memRunEpisode.findMany({
        where: {
          workflowType: input.workflowType ?? MEMORY_WORKFLOW_DISCOVERY,
          runId: input.runId,
        },
        orderBy: { occurredAt: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        phase: row.phase,
        occurredAt: row.occurredAt.toISOString(),
        sourceEventId: row.sourceEventId,
        payload: row.payload,
        provenance: row.provenance,
        privacyClassification: row.privacyClassification,
      }));
    });
  }

  /**
   * Latest currently-valid version per (scope, stat). The caller supplies the
   * child→parent scope chain; SQL matches the set exactly (no recursive query).
   */
  async listKnowledgeStats(
    workspaceId: string,
    input: { scopes: MemoryScopeRef[]; statKey?: string },
    now: Date = new Date(),
  ): Promise<KnowledgeStatView[]> {
    if (!this.semanticConfig.enabled) return [];
    assertScopes(input.scopes);
    if (input.scopes.length === 0) return [];
    const rows = await this.prisma.withWorkspace(workspaceId, async (tx) =>
      tx.memKnowledgeStat.findMany({
        where: {
          AND: [
            {
              OR: input.scopes.map((scope) => ({
                scopeType: scope.type,
                scopeKey: scope.key,
              })),
            },
            { validFrom: { lte: now } },
            { OR: [{ validTo: null }, { validTo: { gt: now } }] },
          ],
          ...(input.statKey ? { statKey: input.statKey } : {}),
        },
        orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
      }),
    );
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.scopeType}\u0000${row.scopeKey}\u0000${row.statKey}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()].map((row) => {
      const n = row.successes + row.failures;
      const { low, high } = wilsonInterval(row.successes, row.failures);
      const mayInfluenceStrategy =
        n >= this.semanticConfig.minN &&
        high - low <= this.semanticConfig.maxCiWidth;
      return {
        id: row.id,
        scopeType: row.scopeType as MemoryScopeType,
        scopeKey: row.scopeKey,
        statKey: row.statKey,
        successes: row.successes,
        failures: row.failures,
        n,
        rate: n === 0 ? 0 : row.successes / n,
        ciLow: low,
        ciHigh: high,
        mayInfluenceStrategy,
        usage: mayInfluenceStrategy ? 'eligible' : 'hint_only',
        validFrom: row.validFrom.toISOString(),
        validTo: row.validTo ? row.validTo.toISOString() : null,
        provenance: row.provenance,
      };
    });
  }

  async buildMemoryBrief(
    workspaceId: string,
    input: BuildMemoryBriefInput,
  ): Promise<MemoryBrief> {
    const maxTokens = Math.min(
      2000,
      Math.max(
        200,
        Math.trunc(input.maxTokens ?? this.semanticConfig.briefMaxTokens),
      ),
    );
    const maxChars = maxTokens * 4;
    const episodes = input.runId
      ? (await this.getRunEpisodes(workspaceId, {
          workflowType: input.workflowType,
          runId: input.runId,
        })).slice(-3)
      : [];
    const stats = input.scopes?.length
      ? (await this.listKnowledgeStats(
          workspaceId,
          { scopes: input.scopes },
          new Date(),
        )).slice(0, 10)
      : [];

    const citations: MemoryBrief['citations'] = [];
    const lines: string[] = [
      `Memory brief (workflow=${input.workflowType ?? MEMORY_WORKFLOW_DISCOVERY}${
        input.runId ? `, run=${input.runId}` : ''
      }; semantic_enabled=${this.semanticConfig.enabled})`,
    ];
    for (const episode of episodes) {
      const payload = episode.payload as
        | { status?: string; cost?: number; scored?: number }
        | null;
      const detail =
        episode.phase === 'run_completed'
          ? `status=${payload?.status ?? 'unknown'} cost=${payload?.cost ?? 0}`
          : `scored=${payload?.scored ?? 0}`;
      lines.push(
        `- [${episode.phase}] ${episode.occurredAt} ${detail} (mem_run_episode:${episode.id}; event=${episode.sourceEventId})`,
      );
      citations.push({
        table: 'mem_run_episode',
        id: episode.id,
        sourceEventId: episode.sourceEventId,
      });
    }
    for (const stat of stats) {
      lines.push(
        `- [${stat.usage}] ${stat.scopeType}:${stat.scopeKey} ${stat.statKey}=${stat.rate.toFixed(
          3,
        )} n=${stat.n} ci95=[${stat.ciLow.toFixed(3)},${stat.ciHigh.toFixed(
          3,
        )}] valid_from=${stat.validFrom} (mem_knowledge_stat:${stat.id})`,
      );
      citations.push({
        table: 'mem_knowledge_stat',
        id: stat.id,
        validFrom: stat.validFrom,
      });
    }

    let text = '';
    let truncated = false;
    for (const line of lines) {
      const next = text.length === 0 ? line : `${text}\n${line}`;
      if (next.length > maxChars - 20) {
        truncated = true;
        break;
      }
      text = next;
    }
    if (truncated) text = `${text}\n…[truncated]`;
    if (text.length === 0) text = lines[0].slice(0, maxChars);

    return {
      text,
      citations,
      tokenEstimate: Math.ceil(text.length / 4),
      truncated,
      semanticEnabled: this.semanticConfig.enabled,
    };
  }
}
