/**
 * FIFO-fair per-tenant (+ optional global) concurrency semaphore used to prevent
 * noisy-neighbor exhaustion on shared internal services (`crawl4ai`, `docling`,
 * `embeddings`, `searxng`) and Temporal worker activities.
 */

export class TenantConcurrencyTimeoutError extends Error {
  readonly code = 'TENANT_CONCURRENCY_TIMEOUT' as const;

  constructor(
    public readonly resource: string,
    public readonly workspaceId: string,
  ) {
    super(`concurrency slot timed out on ${resource} for workspace ${workspaceId}`);
    this.name = 'TenantConcurrencyTimeoutError';
  }
}

interface Waiter {
  readonly workspaceId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (err: Error) => void;
  readonly cleanup: () => void;
  settled: boolean;
}

export interface TenantConcurrencySemaphoreOptions {
  readonly name: string;
  readonly perTenantLimit: number;
  readonly globalLimit?: number;
  readonly acquireTimeoutMs?: number;
}

export class TenantConcurrencySemaphore {
  private readonly name: string;
  private readonly perTenantLimit: number;
  private readonly globalLimit: number;
  private readonly acquireTimeoutMs: number;
  private readonly activeByTenant = new Map<string, number>();
  private activeGlobal = 0;
  private readonly waiters: Waiter[] = [];

  constructor(options: TenantConcurrencySemaphoreOptions) {
    if (!Number.isSafeInteger(options.perTenantLimit) || options.perTenantLimit < 1) {
      throw new TypeError(`invalid perTenantLimit for ${options.name}`);
    }
    this.name = options.name;
    this.perTenantLimit = options.perTenantLimit;
    this.globalLimit =
      options.globalLimit !== undefined &&
      Number.isSafeInteger(options.globalLimit) &&
      options.globalLimit >= 1
        ? options.globalLimit
        : Number.MAX_SAFE_INTEGER;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 60_000;
  }

  private normalizeTenant(workspaceId: string | undefined): string {
    const trimmed = workspaceId?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : '__default__';
  }

  private canGrant(tenant: string): boolean {
    const active = this.activeByTenant.get(tenant) ?? 0;
    return active < this.perTenantLimit && this.activeGlobal < this.globalLimit;
  }

  private grant(tenant: string): () => void {
    this.activeGlobal += 1;
    this.activeByTenant.set(tenant, (this.activeByTenant.get(tenant) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const next = (this.activeByTenant.get(tenant) ?? 1) - 1;
      if (next <= 0) {
        this.activeByTenant.delete(tenant);
      } else {
        this.activeByTenant.set(tenant, next);
      }
      this.drainWaiters();
    };
  }

  private drainWaiters(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const waiter = this.waiters[i]!;
      if (waiter.settled) {
        this.waiters.splice(i, 1);
        continue;
      }
      if (this.canGrant(waiter.workspaceId)) {
        this.waiters.splice(i, 1);
        waiter.settled = true;
        waiter.cleanup();
        waiter.resolve(this.grant(waiter.workspaceId));
        continue;
      }
      i += 1;
    }
  }

  acquire(workspaceId?: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Aborted'));
    }
    const tenant = this.normalizeTenant(workspaceId);
    if (this.canGrant(tenant)) {
      return Promise.resolve(this.grant(tenant));
    }
    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cleanup();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('TENANT_CONCURRENCY_ABORTED'),
        );
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        workspaceId: tenant,
        resolve,
        reject,
        cleanup,
        settled: false,
      };
      if (this.acquireTimeoutMs > 0 && Number.isFinite(this.acquireTimeoutMs)) {
        timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new TenantConcurrencyTimeoutError(this.name, tenant));
        }, this.acquireTimeoutMs);
        timer.unref?.();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async withTenantSlot<T>(
    workspaceId: string | undefined,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(workspaceId, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  activeCount(workspaceId?: string): number {
    if (workspaceId === undefined) return this.activeGlobal;
    return this.activeByTenant.get(this.normalizeTenant(workspaceId)) ?? 0;
  }
}

export function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = 64,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(max, parsed);
}
