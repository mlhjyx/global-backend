import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import {
  createRuntimeMachineTokenClient,
  temporalTlsConfiguration,
} from "../platform-authority/machine-token-runtime";
import type { MachineTokenClient } from "../platform-authority/machine-token-client";
import { currentRuntimeReleaseIdentity } from "../runtime/runtime-release-identity";

export const PLATFORM_TEMPORAL_NAMESPACE = "platform-automation";
export const PLATFORM_TEMPORAL_TASK_QUEUE = "understanding";

const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const WORKFLOW_TYPE = /^[A-Za-z0-9][A-Za-z0-9._]{0,127}$/u;

export interface PlatformWorkflowStartOptions {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly args: readonly unknown[];
}

/**
 * P4-P4b：API 进程到 platform-automation 命名空间的写客户端。
 *
 * 身份是 temporal-platform-client 机器档案（permissions 恰为
 * platform-automation:write，与平台授权器的 schedule-writer 身份一致），
 * 证书/主体由 TEMPORAL_PLATFORM_CLIENT_* 显式提供，绝不回退到 API 进程的
 * customer-client bootstrap 材料。只暴露受约束的 StartWorkflowExecution；
 * 工作流本身的执行在 platform worker 上，API 不直接出网。
 */
@Injectable()
export class PlatformTemporalClient implements OnModuleInit, OnModuleDestroy {
  private connection?: Connection;
  private client?: Client;
  private connecting?: Promise<boolean>;
  private destroyed = false;
  private machineToken?: MachineTokenClient;

  private readonly connect = async (): Promise<Connection> => {
    this.machineToken?.close();
    const release = await currentRuntimeReleaseIdentity();
    if (!release.attested) {
      throw new Error("RUNTIME_RELEASE_IDENTITY_UNAVAILABLE");
    }
    const runtimeIdentity = release.artifact_digest.replace(/^sha256:/, "");
    const { client } = await createRuntimeMachineTokenClient(
      "temporal-platform-client",
      runtimeIdentity,
    );
    this.machineToken = client;
    try {
      // 必须用 lazy 而不是 connect：connect 会先调用 GetSystemInfo 做连通性预检，
      // 而 schedule-writer 身份在平台授权器里只被允许 StartWorkflowExecution，
      // 预检被拒（PLATFORM_TEMPORAL_READER_AUTH_DENIED）会让整条启动链不可用
      //（2026-11-05 真机验收暴露；单测用私有 connect 覆盖不到真实 SDK 路径）。
      // lazy 不做预检，失败由既有收敛与下次重连逻辑处理。
      return Connection.lazy({
        ...(await temporalTlsConfiguration()),
        apiKey: () => client.currentToken(),
      });
    } catch (error) {
      client.close();
      throw error;
    }
  };

  async onModuleInit(): Promise<void> {
    await this.reconnect();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.machineToken?.close();
    await this.connection?.close();
    this.connection = undefined;
    this.client = undefined;
  }

  async reconnect(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.connection) return true;
    this.connecting ??= this.reconnectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async reconnectOnce(): Promise<boolean> {
    try {
      const connection = await this.connect();
      if (this.destroyed) {
        this.machineToken?.close();
        await connection.close();
        return false;
      }
      this.connection = connection;
      this.client = new Client({
        connection,
        namespace: PLATFORM_TEMPORAL_NAMESPACE,
      });
      return true;
    } catch {
      this.connection = undefined;
      this.client = undefined;
      return false;
    }
  }

  /** Starts one platform workflow by type; the worker owns execution. */
  async startWorkflow(
    options: PlatformWorkflowStartOptions,
  ): Promise<{ workflowId: string; runId: string }> {
    if (
      !WORKFLOW_ID.test(options.workflowId) ||
      !WORKFLOW_TYPE.test(options.workflowType)
    ) {
      throw new Error("PLATFORM_WORKFLOW_START_INVALID");
    }
    if (!this.client || !this.connection) {
      if (!(await this.reconnect())) {
        throw new Error("PLATFORM_TEMPORAL_UNAVAILABLE");
      }
    }
    try {
      const handle = await this.client!.workflow.start(options.workflowType, {
        taskQueue: PLATFORM_TEMPORAL_TASK_QUEUE,
        workflowId: options.workflowId,
        args: [...options.args],
      });
      return {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
      };
    } catch {
      // A dropped credential or connection surfaces as a bounded code; the next
      // call reconnects through reconnect().
      if (this.connection) {
        await this.connection.close().catch(() => undefined);
        this.connection = undefined;
        this.client = undefined;
      }
      throw new Error("PLATFORM_TEMPORAL_UNAVAILABLE");
    }
  }
}
