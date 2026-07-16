import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../auth/request-context";
import { IntakeController } from "./intake.controller";
import type { IntakeDto } from "./dto/intake.dto";
import type { IntakeService } from "./intake.service";

const CTX: RequestContext = {
  userId: "user-1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  roles: [],
};
const DTO: IntakeDto = {
  company: { nameZh: "杭州爱克姆泵业有限公司", nameEn: "Acme Pump Co., Ltd." },
  industry: "isic-2813",
  products: ["pump"],
  targetMarkets: ["DE"],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: "sales@example.com",
};

describe("IntakeController R0 header bridge", () => {
  it("把可选 idempotency-key 原样传给 service，并返回目标响应信封", async () => {
    const create = vi.fn().mockResolvedValue({
      siteId: "site-1",
      buildId: "run-1",
      status: "generating_demo",
    });
    const controller = new IntakeController({
      create,
    } as unknown as IntakeService);
    const targetCreate = controller.create.bind(controller) as unknown as (
      ctx: RequestContext,
      dto: IntakeDto,
      idempotencyKey?: string,
    ) => Promise<unknown>;

    await expect(targetCreate(CTX, DTO, "request-key-1")).resolves.toEqual({
      data: { siteId: "site-1", buildId: "run-1", status: "generating_demo" },
    });
    expect(create).toHaveBeenCalledWith(CTX, DTO, "request-key-1");
  });
});
