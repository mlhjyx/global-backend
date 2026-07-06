import { Injectable } from '@nestjs/common';
import { ModelProvider } from './model-provider';

/** Holds every registered model provider. Add providers here to grow the fleet. */
@Injectable()
export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  all(): ModelProvider[] {
    return [...this.providers.values()];
  }
}
