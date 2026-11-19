import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable, type Subscription } from "rxjs";
import {
  runCandidateOperation,
  runtimeCandidateContext,
} from "./development-candidate";

/** Carries an already admitted HTTP operation through async result persistence.
 * New work is still checked at entry and every external reservation. Completion
 * permission closes on completion/unsubscribe and never leaks to descendants.
 */
@Injectable()
export class CandidateOperationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!runtimeCandidateContext()) return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<{ requestContext?: { workspaceId?: string } }>();
    return new Observable((subscriber) => {
      let inner: Subscription | undefined;
      let finish: (() => void) | undefined;
      void runCandidateOperation(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = resolve;
            inner = next.handle().subscribe({
              next: (value) => subscriber.next(value),
              error: (error) => {
                subscriber.error(error);
                reject(error);
              },
              complete: () => {
                subscriber.complete();
                resolve();
              },
            });
          }),
        request.requestContext?.workspaceId,
      ).catch((error) => subscriber.error(error));
      return () => {
        inner?.unsubscribe();
        finish?.();
      };
    });
  }
}
