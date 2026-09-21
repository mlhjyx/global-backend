import {
  Controller,
  Get,
  HttpException,
  Inject,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import {
  ApiExtension,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { PlatformRevocationTrustRuntime } from "./platform-revocation-trust.runtime";
import { revocationErrorBody } from "./platform-revocation-http.contract";
import { PlatformRevocationHttpFilter } from "./platform-revocation-http.filter";

@ApiTags("PlatformAuthority")
@Controller("platform-authority")
@UseFilters(PlatformRevocationHttpFilter)
export class PlatformFenceAckJwksController {
  constructor(
    @Inject(PlatformRevocationTrustRuntime)
    private readonly trust: PlatformRevocationTrustRuntime,
    @Inject(RuntimeAdmissionService)
    private readonly admission: RuntimeAdmissionService,
  ) {}
  @Get("fence-ack-jwks")
  @ApiOperation({
    operationId: "getPlatformFenceAckJwks_v1",
    summary: "Read only the independently admitted public fence-ACK key family",
  })
  @ApiExtension("x-public-key-family", "platform-authority-fence-ack+jwt")
  @ApiResponse({
    status: 200,
    description:
      "Public RSA ACK keys only; no signing action or private material",
  })
  @ApiResponse({
    status: 503,
    description:
      "Own admission, key provenance or cross-family independence unavailable",
  })
  async keys(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    const abort = new AbortController();
    const stop = () => abort.abort();
    request.once("aborted", stop);
    response.once("close", stop);
    try {
      if (!this.admission.current().admitted) throw new Error();
      const opened = await this.trust.open(abort.signal);
      if (abort.signal.aborted || !this.admission.current().admitted)
        throw new Error();
      this.trust.assertCurrent();
      response.type("application/jwk-set+json").json(opened.material.jwks);
    } catch {
      throw new HttpException(revocationErrorBody("unavailable"), 503);
    } finally {
      abort.abort();
      request.removeListener("aborted", stop);
      response.removeListener("close", stop);
    }
  }
}
