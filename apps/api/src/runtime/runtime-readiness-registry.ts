import { Injectable } from '@nestjs/common';

export type RuntimeComponentStatus =
  | Readonly<{ status: 'ok' }>
  | Readonly<{ status: 'failed'; code: string }>
  | Readonly<{ status: 'not_proven'; code: string }>;

export type RuntimeReadinessContributor = () =>
  | RuntimeComponentStatus
  | Promise<RuntimeComponentStatus>;

@Injectable()
export class RuntimeReadinessContributorRegistry {
  private readonly contributors = new Map<string, RuntimeReadinessContributor>();

  register(name: string, contributor: RuntimeReadinessContributor): () => void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new Error('readiness contributor name is invalid');
    }
    if (this.contributors.has(name)) {
      throw new Error(`readiness contributor ${name} is already registered`);
    }
    this.contributors.set(name, contributor);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.contributors.get(name) === contributor) {
        this.contributors.delete(name);
      }
    };
  }

  async check(name: string): Promise<RuntimeComponentStatus> {
    const contributor = this.contributors.get(name);
    if (!contributor) {
      return { status: 'failed', code: 'READINESS_CONTRIBUTOR_MISSING' };
    }
    try {
      const result = await contributor();
      if (result?.status === 'ok') return { status: 'ok' };
      if (
        (result?.status === 'failed' || result?.status === 'not_proven') &&
        typeof result.code === 'string' &&
        /^[A-Z][A-Z0-9_]{1,127}$/.test(result.code)
      ) {
        return Object.freeze({ status: result.status, code: result.code });
      }
    } catch {
      // The public readiness report carries bounded codes only.
    }
    return { status: 'failed', code: 'READINESS_CONTRIBUTOR_FAILED' };
  }
}
