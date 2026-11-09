import { describe, expect, it } from 'vitest';
import { ActivityFailure, ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import { Prisma } from '@prisma/client';

import {
  FAILURE_CODES,
  type FailureCode,
  type FailureStage,
} from '../discovery/judgment/failure-codes';
import {
  ExecutionControlError,
  isExecutionControlError,
} from '../execution-budget/execution-control-error';
import {
  ProviderHttpError,
  ProviderIdentityError,
  ProviderOutputError,
  ProviderTransportError,
} from '../model-gateway/providers/provider-output-error';
import {
  BudgetExceededError,
  BudgetOperationReplayError,
  BudgetStoreUnavailableError,
} from '../tools/budget-store';
import { SkillUnavailableError } from '../skills/skill-runtime';
import { EgressBlockedError } from '../adapters/url-guard';
import { classifyPipelineFailure, controlPlaneToken } from './pipeline-failure-taxonomy';

function expectCode(error: unknown, code: FailureCode, failureStage?: FailureStage): void {
  expect(classifyPipelineFailure(error)).toEqual({
    code,
    failureStage: failureStage ?? FAILURE_CODES[code].stage,
  });
}

function activityFailure(cause: Error): ActivityFailure {
  return new ActivityFailure('Activity task failed', 'fitCompanyOnce', '1', undefined, 'worker-1', cause);
}

describe('classifyPipelineFailure（P3 J02 W1：失败码归因）', () => {
  it('映射表 100% 可达：ApplicationFailure(type=<每个码>) 原样透传', () => {
    for (const code of Object.keys(FAILURE_CODES) as FailureCode[]) {
      expectCode(
        ApplicationFailure.create({ message: 'Temporal execution failed', type: code }),
        code,
      );
    }
  });

  it('穿透 Temporal 的 ActivityFailure → ApplicationFailure cause 链（转换器只保留 type）', () => {
    expectCode(
      activityFailure(ApplicationFailure.create({ message: 'Temporal execution failed', type: 'PROVIDER_HTTP_429' })),
      'PROVIDER_HTTP_429',
    );
    // 多层包装：外层 ApplicationFailure 只有脱敏消息，真正的码在内层
    expectCode(
      activityFailure(
        ApplicationFailure.create({
          message: 'Temporal execution failed',
          type: '',
          cause: ApplicationFailure.create({ message: 'x', type: 'OUTPUT_TRUNCATED' }),
        }),
      ),
      'OUTPUT_TRUNCATED',
    );
  });

  it('ProviderHttpError 按 status（或类自带 message 的 HTTP 状态）映射', () => {
    expectCode(new ProviderHttpError({ status: 429, provider: 'p', model: 'm' }), 'PROVIDER_HTTP_429');
    expectCode(new ProviderHttpError({ status: 402, provider: 'p', model: 'm' }), 'PROVIDER_HTTP_402');
    expectCode(new ProviderHttpError({ status: 401, provider: 'p', model: 'm' }), 'PROVIDER_HTTP_401_403');
    expectCode(new ProviderHttpError({ status: 403, provider: 'p', model: 'm' }), 'PROVIDER_HTTP_401_403');
    expectCode(new ProviderHttpError({ status: 504, provider: 'p', model: 'm' }), 'PROVIDER_HTTP_5XX');
    // 越界后 status 字段丢了，只剩 `${provider} ${model}: HTTP 504`
    expectCode(
      Object.assign(new Error('acme gpt-5: HTTP 504'), { name: 'ProviderHttpError' }),
      'PROVIDER_HTTP_5XX',
    );
    // 非 429/402/401/403/5xx 的 HTTP 失败没有专属码 → 未知上游
    expectCode(new ProviderHttpError({ status: 400, provider: 'p', model: 'm' }), 'UNKNOWN_UPSTREAM');
  });

  it('ProviderOutputError 契约失败按 reasonCode / 前导 token 拆分', () => {
    expectCode(new ProviderOutputError('STRUCTURED_OUTPUT_NOT_JSON'), 'OUTPUT_NOT_JSON');
    expectCode(
      new ProviderOutputError('truncated', undefined, { reasonCode: 'STRUCTURED_OUTPUT_TRUNCATED' }),
      'OUTPUT_TRUNCATED',
    );
    expectCode(
      new ProviderOutputError('truncated', undefined, { reasonCode: 'STRUCTURED_OUTPUT_EMPTY_TRUNCATED' }),
      'OUTPUT_TRUNCATED',
    );
    expectCode(
      new ProviderOutputError('schema', undefined, {
        reasonCode: 'STRUCTURED_OUTPUT_SCHEMA_INVALID_AFTER_REPAIR',
      }),
      'OUTPUT_SCHEMA_INVALID',
    );
    expectCode(new ProviderOutputError('CHAT_COMPLETIONS_CONTENT_FILTERED'), 'MODEL_REFUSAL');
    expectCode(
      new ProviderOutputError('enum', undefined, { reasonCode: 'ENUM_DRIFT' }),
      'ENUM_DRIFT',
    );
  });

  it('身份/传输错误有专属码（v2 新增）', () => {
    expectCode(new ProviderIdentityError('model identity mismatch'), 'PROVIDER_IDENTITY_MISMATCH');
    expectCode(new ProviderTransportError('stream cut'), 'PROVIDER_TRANSPORT_FAILED');
  });

  it('超时：Temporal TimeoutFailure 与 DOM TimeoutError 都归 PROVIDER_TIMEOUT', () => {
    expectCode(new TimeoutFailure('activity timed out', undefined, 'START_TO_CLOSE'), 'PROVIDER_TIMEOUT');
    expectCode(Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'PROVIDER_TIMEOUT');
    expectCode({ name: 'GenericError', message: 'x', timeoutType: 'HEARTBEAT' }, 'PROVIDER_TIMEOUT');
  });

  it('技能不可用 → SKILL_UNAVAILABLE', () => {
    expectCode(
      new SkillUnavailableError('SKILL_PLATFORM_DISABLED', 'ops kill switch'),
      'SKILL_UNAVAILABLE',
    );
  });

  it('预算/控制面不被误分类成 provider（isExecutionControlError 语义一致）', () => {
    const exceeded = new BudgetExceededError('acct', 10n, 0n);
    const storeDown = new BudgetStoreUnavailableError();
    const replay = new BudgetOperationReplayError('op');
    const authority = new ExecutionControlError('EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED');
    const domainAck = new ExecutionControlError('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
    const lease = new ExecutionControlError('EXECUTION_BUDGET_ADMISSION_LEASE_EXPIRED');
    for (const error of [exceeded, storeDown, replay, authority, domainAck, lease]) {
      expect(isExecutionControlError(error), error.name).toBe(true);
    }

    expectCode(exceeded, 'BUDGET_EXCEEDED');
    expectCode(storeDown, 'BUDGET_AUTHORITY_NOT_READY');
    expectCode(replay, 'BUDGET_AUTHORITY_NOT_READY');
    expectCode(authority, 'BUDGET_AUTHORITY_NOT_READY');
    expectCode(domainAck, 'CONTROL_PLANE_REJECTED');
    expectCode(lease, 'LEASE_LOST');
    for (const code of [
      classifyPipelineFailure(exceeded).code,
      classifyPipelineFailure(storeDown).code,
      classifyPipelineFailure(authority).code,
      classifyPipelineFailure(domainAck).code,
      classifyPipelineFailure(lease).code,
    ]) {
      expect(FAILURE_CODES[code].stage, code).not.toBe('provider');
    }
  });

  it('DiagnosticFailureConverter 的控制面哨兵（EXECUTIONCONTROLERROR/预算 token）可归因', () => {
    expectCode(
      ApplicationFailure.create({ message: 'EXECUTIONCONTROLERROR', type: '' }),
      'CONTROL_PLANE_REJECTED',
    );
    expectCode(
      ApplicationFailure.create({ message: 'BUDGET_STORE_UNAVAILABLE', type: '' }),
      'BUDGET_AUTHORITY_NOT_READY',
    );
    expectCode(
      new Error('EXECUTION_BUDGET_LEGACY_HISTORY_PARKED'),
      'BUDGET_AUTHORITY_NOT_READY',
    );
  });

  it('DB 冲突 / 抓取失败映射既有码', () => {
    expectCode(
      new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
      'DB_TX_CONFLICT',
    );
    expectCode(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
      'UNKNOWN_UPSTREAM',
    );
    expectCode(new EgressBlockedError('invalid_url'), 'RETRIEVER_FETCH_FAILED');
    expectCode({ name: 'ProviderWireInFlightError', message: 'wire in flight' }, 'LEASE_LOST');
  });

  it('未知一律 UNKNOWN_UPSTREAM，不静默吞掉也不误挂 provider 之外的码', () => {
    expectCode(new Error('adapter exploded'), 'UNKNOWN_UPSTREAM');
    expectCode(new TypeError('x is not a function'), 'UNKNOWN_UPSTREAM');
    expectCode('boom', 'UNKNOWN_UPSTREAM');
    expectCode(null, 'UNKNOWN_UPSTREAM');
    expectCode({}, 'UNKNOWN_UPSTREAM');
    // ProviderSettlementError（结算/账本故障）显性上报为未知
    expectCode(
      Object.assign(new Error('paid model settlement failed: MODEL_SETTLEMENT_LOG_INVALID'), {
        name: 'ProviderSettlementError',
      }),
      'UNKNOWN_UPSTREAM',
    );
  });

  it('cause 链环不会死循环', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expectCode(a, 'UNKNOWN_UPSTREAM');
  });

  it('controlPlaneToken 与共享分类器的 token 语义一致（code/type 位置；消息哨兵是转换器产物）', () => {
    for (const token of [
      'EXECUTIONCONTROLERROR',
      'EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED',
      'BUDGET_STORE_UNAVAILABLE',
      'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
      'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
      'DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED',
      'PLATFORM_EGRESS_PHYSICAL_WIRE_FAILED',
    ]) {
      expect(controlPlaneToken(token), token).toBe(token);
      // 共享分类器只把 code/type/name 位置的 token 当控制面（普通 Error 的 message 不参与），
      // 本分类器的 message 检查只服务于 DiagnosticFailureConverter 的脱敏哨兵（上一条用例）。
      expect(
        isExecutionControlError(Object.assign(new Error('x'), { code: token })),
        token,
      ).toBe(true);
      expect(
        isExecutionControlError(Object.assign(new Error('x'), { type: token })),
        token,
      ).toBe(true);
    }
    for (const token of ['PROVIDER_HTTP_429', 'Temporal execution failed', '', undefined]) {
      expect(controlPlaneToken(token), String(token)).toBeUndefined();
    }
  });
});
