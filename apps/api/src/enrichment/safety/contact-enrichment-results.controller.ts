import { envelope, pageEnvelope } from "../../common/envelope";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import {
  closedSafetyRecord,
  denseSafetyArray,
} from "./enrichment-safety.contract";
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
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
  CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA,
  parseContactEnrichmentResultsQuery,
  decodeContactEnrichmentResultCursor,
  parseContactEnrichmentQualityResult,
  type ContactEnrichmentResultsQuery,
} from "./contact-enrichment-results.dto";
export const CONTACT_ENRICHMENT_RESULTS_PORT = Symbol(
  "CONTACT_ENRICHMENT_RESULTS_PORT",
);
export interface ContactEnrichmentResultsPort {
  listEnrichmentExecutions(
    context: RequestContext,
    companyId: string,
    query: ContactEnrichmentResultsQuery,
  ): Promise<Readonly<{
    items: readonly unknown[];
    nextCursor: string | null;
    hasMore: boolean;
  }> | null>;
  readEnrichmentExecution(
    context: RequestContext,
    companyId: string,
    operationRef: string,
  ): Promise<unknown | null>;
  recoverEnrichmentExecution(
    context: RequestContext,
    companyId: string,
    operationRef: string,
  ): Promise<unknown | null>;
  listEnrichmentQualityFacts(
    context: RequestContext,
    companyId: string,
    query: ContactEnrichmentResultsQuery,
  ): Promise<Readonly<{
    items: readonly unknown[];
    nextCursor: string | null;
    hasMore: boolean;
  }> | null>;
  readEnrichmentQualityFacts(
    context: RequestContext,
    companyId: string,
    operationRef: string,
  ): Promise<unknown | null>;
}
@ApiTags("Contact enrichment results")
@ApiBearerAuth()
@Controller("canonical-companies/:id/contact-enrichment-results")
@UseGuards(AuthGuard, ScopesGuard)
export class ContactEnrichmentResultsController {
  constructor(
    @Inject(CONTACT_ENRICHMENT_RESULTS_PORT)
    private readonly _port: ContactEnrichmentResultsPort,
  ) {}
  @Get()
  @Header("Cache-Control", "no-store")
  @RequireScopes("acquisition:read", "contact-discovery:read")
  @ApiOperation({
    operationId: "listContactEnrichmentResults_v1",
    summary: "读取公司已准入的联系人补强结果",
    description:
      "固定 page10，createdAt/id keyset；仅原持久元数据，不消费 Grant、不恢复、不结算、不外联。",
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
  @ApiPageEnvelope(CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA)
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
      throw new BadRequestException("invalid contact enrichment result query");
    }
    const value = await this._port.listEnrichmentExecutions(ctx, id, parsed);
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
        "contact enrichment page metadata unavailable",
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
          "contact enrichment page metadata unavailable",
        );
    } else if (nextCursor !== null)
      throw new InternalServerErrorException(
        "contact enrichment page metadata unavailable",
      );
    return pageEnvelope(items, { nextCursor, hasMore: row.hasMore });
  }
  @Get(":operationRef")
  @Header("Cache-Control", "no-store")
  @RequireScopes("acquisition:read", "contact-discovery:read")
  @ApiOperation({
    operationId: "readContactEnrichmentResult_v1",
    summary: "读取原联系人补强操作结果",
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
  @ApiEnvelope(CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA)
  async read(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("operationRef") ref: string,
  ) {
    this.address(ctx, id, ref);
    const value = await this._port.readEnrichmentExecution(ctx, id, ref);
    if (value === null) return this.notFound();
    return envelope(this.publicResult(value, id, ref));
  }
  @Post(":operationRef/recover")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireScopes(
    "acquisition:write",
    "contact-discovery:read",
    "compliance:manage",
  )
  @ApiOperation({
    operationId: "recoverContactEnrichmentResult_v1",
    summary: "显式恢复原结果的核对与领域保存",
    description:
      "仍须当前公司/主体/抑制授权；仅原结果/原预留协议，不要求新 Grant，不新增预留或 wire。UNKNOWN 无原结果保持 HOLD。",
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
  @ApiEnvelope(CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA)
  async recover(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("operationRef") ref: string,
  ) {
    this.address(ctx, id, ref);
    const value = await this._port.recoverEnrichmentExecution(ctx, id, ref);
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
      throw new BadRequestException(
        "invalid contact enrichment result address",
      );
  }
  private notFound(): never {
    throw new NotFoundException("contact enrichment result not found");
  }
  private publicResult(
    value: unknown,
    companyId: string,
    operationRef?: string,
  ) {
    let result;
    try {
      result = parseContactEnrichmentQualityResult(value);
    } catch {
      throw new InternalServerErrorException(
        "contact enrichment result metadata unavailable",
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
