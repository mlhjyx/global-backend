import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestContext } from './request-context';

/** Injects the RequestContext attached by AuthGuard. */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext =>
    context.switchToHttp().getRequest().requestContext,
);
