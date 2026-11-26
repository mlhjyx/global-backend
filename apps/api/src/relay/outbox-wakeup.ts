import { Logger } from '@nestjs/common';
import {
  OUTBOX_WAKEUP_CHANNEL,
  PgNotifyListener,
  type PgNotifyMessage,
} from './pg-notify-listener';

export interface OutboxWakeupControllerOptions {
  readonly connectionString: string;
  readonly onWakeup: (workspaceId: string) => void;
  readonly debounceMs?: number;
  readonly channel?: string;
}

/**
 * Wraps `PgNotifyListener` with short coalescing debounce (default 25ms) so
 * bursts of `outbox_event` inserts trigger sub-second relay ticks without
 * hammering the database. Errors are logged and never break the polling fallback.
 */
export class OutboxWakeupController {
  private readonly logger = new Logger('OutboxWakeup');
  private readonly listener: PgNotifyListener;
  private readonly debounceMs: number;
  private pendingTimer?: NodeJS.Timeout;
  private lastWorkspaceId = '';

  constructor(private readonly options: OutboxWakeupControllerOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 25);
    this.listener = new PgNotifyListener({
      connectionString: options.connectionString,
      channel: options.channel ?? OUTBOX_WAKEUP_CHANNEL,
      onNotification: (msg) => this.handleNotification(msg),
      onError: (err) => {
        this.logger.warn(
          `PG NOTIFY wakeup listener error (polling fallback active): ${err.message.slice(0, 160)}`,
        );
      },
    });
  }

  private handleNotification(msg: PgNotifyMessage): void {
    this.lastWorkspaceId = msg.payload;
    if (this.pendingTimer) return;
    if (this.debounceMs === 0) {
      this.options.onWakeup(this.lastWorkspaceId);
      return;
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.options.onWakeup(this.lastWorkspaceId);
    }, this.debounceMs);
    this.pendingTimer.unref();
  }

  start(): void {
    this.listener.start();
  }

  async close(): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    await this.listener.close();
  }
}

export function createOptionalOutboxWakeup(
  ownsDb: boolean,
  onWakeup: (workspaceId: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): OutboxWakeupController | undefined {
  const connectionString = env.OUTBOX_RELAY_DATABASE_URL?.trim();
  if (!ownsDb || !connectionString) return undefined;
  if (/^(1|true|yes)$/i.test(env.OUTBOX_PG_NOTIFY_DISABLED ?? '')) return undefined;
  const controller = new OutboxWakeupController({ connectionString, onWakeup });
  controller.start();
  return controller;
}
