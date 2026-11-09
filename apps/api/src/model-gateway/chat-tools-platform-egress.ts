import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { AiContext } from "./types";

/**
 * WEB-1：R4 平台出网围栏只承认封闭的 modelOp 集合（platform-egress-operation），
 * 工具环传输不在其中；扩列属于平台执行合同变更。在该上下文下调用必须 fail closed，
 * 不能退化成无围栏出网。
 *
 * 单独成文件是为了让路由器（vision-review 输入错误的终端消费者）不直接 import
 * 共享分类器——execution-control-error.static.spec 要求该边界文件保持分类器无关。
 */
export function assertChatWithToolsPlatformEgressAllowed(ctx: AiContext): void {
  if (ctx.platformEgress) {
    throw new ExecutionControlError(
      "CHAT_WITH_TOOLS_PLATFORM_EGRESS_UNSUPPORTED",
    );
  }
}
