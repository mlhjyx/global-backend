import type { TaskModelContract } from './types';
import { immutableClone } from './immutable';

function key(taskId: string, version: string): string {
  return `${taskId}\u0000${version}`;
}

export class TaskContractRegistry {
  private readonly contracts = new Map<string, TaskModelContract<unknown, unknown>>();

  constructor(contracts: readonly TaskModelContract<unknown, unknown>[] = []) {
    for (const contract of contracts) this.register(contract);
  }

  register<Input, Output>(contract: TaskModelContract<Input, Output>): void {
    if (!contract.taskId || !contract.version) throw new Error('task contract id and version are required');
    const contractKey = key(contract.taskId, contract.version);
    if (this.contracts.has(contractKey)) {
      throw new Error(`task contract already registered: ${contract.taskId}@${contract.version}`);
    }
    const stored = Object.freeze({
      ...contract,
      inputSchema: immutableClone(contract.inputSchema),
      outputSchema: immutableClone(contract.outputSchema),
      contextPolicy: immutableClone(contract.contextPolicy),
      capabilityRequirements: immutableClone(contract.capabilityRequirements),
      reasoningPolicy: immutableClone(contract.reasoningPolicy),
      cachePolicy: immutableClone(contract.cachePolicy),
      retryPolicy: immutableClone(contract.retryPolicy),
    });
    this.contracts.set(contractKey, stored as TaskModelContract<unknown, unknown>);
  }

  get<Input = unknown, Output = unknown>(taskId: string, version: string): TaskModelContract<Input, Output> {
    const contract = this.contracts.get(key(taskId, version));
    if (!contract) throw new Error(`task contract not registered: ${taskId}@${version}`);
    return contract as TaskModelContract<Input, Output>;
  }
}
