import { envelope, pageEnvelope } from "../../common/envelope";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { closedSafetyRecord, denseSafetyArray } from "./enrichment-safety.contract";
import {
  CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA,
  parseContactEnrichmentQualityFacts,
} from "./contact-enrichment-quality-facts.dto";
import {
  decodeContactEnrichmentResultCursor,
  parseContactEnrichmentResultsQuery,
  type ContactEnrichmentResultsQuery,
} from "./contact-enrichment-results.dto";
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../../auth/auth.guard";
import { ScopesGuard } from "../../auth/scopes.guard";
import { RequireScopes } from "../../auth/require-scopes.decorator";
import { Ctx } from "../../auth/ctx.decorator";
import type { RequestContext } from "../../auth/request-context";
import {
  ApiEnvelope,
  ApiPageEnvelope,
} from "../../common/api-envelope.decorator";
import {
  CONTACT_ENRICHMENT_RESULTS_PORT,
  type ContactEnrichmentResultsPort,
} from "./contact-enrichment-results.controller";
/** Versioned complete A01-A07 facts face. The closed V1 prerequisite carrier stays untouched. */
@ApiTags("Contact enrichment quality")
@ApiBearerAuth()
@Controller("canonical-companies/:id/contact-enrichment-quality-facts")
@UseGuards(AuthGuard, ScopesGuard)
export class ContactEnrichmentQualityFactsController {
  constructor(
    @Inject(CONTACT_ENRICHMENT_RESULTS_PORT)
    private readonly _port: Pick<
      ContactEnrichmentResultsPort,
      "listEnrichmentQualityFacts" | "readEnrichmentQualityFacts"
    >,
  ) {}
  @Get()
  @Header("Cache-Control", "no-store")
  @RequireScopes("acquisition:read", "contact-discovery:read")
  @ApiOperation({
    operationId: "listContactEnrichmentQualityFacts_v2",
    summary: "读取公司已准入的完整联系人质量事实",
    description:
      "固定 page10，createdAt/id keyset；仅原执行、决策与同事务质量事实；不消费 Grant、不恢复、不结算、不外联。",
  })
  @ApiParam({ name: "id", type: "string", format: "uuid" })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string", maxLength: 256 },
  })
  @ApiQuery({
    name: "runId",
    required: false,
    schema: { type: "string", format: "uuid" },
  })
  @ApiPageEnvelope(CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA)
  async list(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    this.address(ctx, id);
    let parsed: ContactEnrichmentResultsQuery;
    try {
      parsed = parseContactEnrichmentResultsQuery(query);
    } catch {
      throw new BadRequestException("invalid contact enrichment quality query");
    }
    const value = await this._port.listEnrichmentQualityFacts(ctx, id, parsed);
    if (value === null) return this.notFound();
    const row = closedSafetyRecord(value, ["items", "nextCursor", "hasMore"]);
    const items = denseSafetyArray(row.items, 10).map((item) =>
      this.publicResult(item, id),
    );
    if (
      new Set(items.map((item) => item.operationRef)).size !== items.length ||
      typeof row.hasMore !== "boolean" ||
      (row.nextCursor !== null && typeof row.nextCursor !== "string")
    )
      throw new InternalServerErrorException(
        "contact enrichment quality metadata unavailable",
      );
    const nextCursor = row.nextCursor as string | null;
    if (row.hasMore) {
      if (
        nextCursor === null ||
        items.length === 0 ||
        decodeContactEnrichmentResultCursor(nextCursor).createdAt !==
          items[items.length - 1]!.createdAt
      )
        throw new InternalServerErrorException(
          "contact enrichment quality metadata unavailable",
        );
    } else if (nextCursor !== null)
      throw new InternalServerErrorException(
        "contact enrichment quality metadata unavailable",
      );
    return pageEnvelope(items, { nextCursor, hasMore: row.hasMore });
  }
  @Get(":operationRef")
  @Header("Cache-Control", "no-store")
  @RequireScopes("acquisition:read", "contact-discovery:read")
  @ApiOperation({
    operationId: "readContactEnrichmentQualityFacts_v2",
    summary: "读取原联系人补强操作的完整质量事实",
    description:
      "跨 workspace/company 与不存在统一 404；无 Grant、预留、恢复、结算或外联。",
  })
  @ApiParam({ name: "id", type: "string", format: "uuid" })
  @ApiParam({
    name: "operationRef",
    schema: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
      minLength: 64,
      maxLength: 64,
    },
  })
  @ApiEnvelope(CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA)
  async read(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("operationRef") ref: string,
  ) {
    this.address(ctx, id, ref);
    const value = await this._port.readEnrichmentQualityFacts(ctx, id, ref);
    if (value === null) return this.notFound();
    return envelope(this.publicResult(value, id, ref));
  }
  private address(
    ctx: RequestContext,
    companyId: string,
    operationRef?: string,
  ): void {
    if (
      !isCanonicalArtifactUuid(ctx.workspaceId) ||
      !isCanonicalArtifactUuid(companyId) ||
      (operationRef !== undefined && !/^[a-f0-9]{64}$/.test(operationRef))
    )
      throw new BadRequestException("invalid contact enrichment quality address");
  }
  private notFound(): never {
    throw new NotFoundException("contact enrichment quality not found");
  }
  private publicResult(value: unknown, companyId: string, operationRef?: string) {
    let result;
    try {
      result = parseContactEnrichmentQualityFacts(value);
    } catch {
      throw new InternalServerErrorException(
        "contact enrichment quality metadata unavailable",
      );
    }
    if (
      result.companyId !== companyId ||
      (operationRef !== undefined && result.operationRef !== operationRef)
    )
      return this.notFound();
    return result;
  }
}
