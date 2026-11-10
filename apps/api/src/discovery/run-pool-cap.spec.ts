import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunPoolGate,
  DEFAULT_RUN_POOL_CAP,
  defaultRunPoolCap,
  parseRunPoolCap,
  poolCapBlocks,
  RUN_POOL_CAP_MAX,
  RUN_POOL_CAP_REACHED_REASON,
  UNCAPPED_RUN_POOL_CAP,
} from './run-pool-cap';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseRunPoolCap —— DISCOVERY_RUN_POOL_CAP 解析', () => {
  it('未设置时默认 500（enforce）', () => {
    expect(parseRunPoolCap(undefined)).toEqual({ mode: 'enforce', cap: 500 });
    expect(DEFAULT_RUN_POOL_CAP).toBe(500);
  });

  it('空白同样回退默认', () => {
    expect(parseRunPoolCap('   ')).toEqual({ mode: 'enforce', cap: 500 });
  });

  it('off（大小写/空白不敏感）关闭闸门', () => {
    expect(parseRunPoolCap('off')).toEqual({ mode: 'off' });
    expect(parseRunPoolCap(' OFF ')).toEqual({ mode: 'off' });
  });

  it('纯十进制正整数按原值启用', () => {
    expect(parseRunPoolCap('500')).toEqual({ mode: 'enforce', cap: 500 });
    expect(parseRunPoolCap('1')).toEqual({ mode: 'enforce', cap: 1 });
    expect(parseRunPoolCap('1000')).toEqual({ mode: 'enforce', cap: 1000 });
  });

  it.each(['0', '-1', '1e3', '100abc', '10.5', '0x10', '9007199254740993', `${RUN_POOL_CAP_MAX + 1}`])(
    '非法值 %s 回退默认 500（失败方向 = 仍设闸）',
    (raw) => {
      expect(parseRunPoolCap(raw)).toEqual({ mode: 'enforce', cap: DEFAULT_RUN_POOL_CAP });
    },
  );

  it('上限本身合法', () => {
    expect(parseRunPoolCap(`${RUN_POOL_CAP_MAX}`)).toEqual({ mode: 'enforce', cap: RUN_POOL_CAP_MAX });
  });
});

describe('DISCOVERY_UNCAPPED=on —— 池帽退为防爆安全界', () => {
  const on = { DISCOVERY_UNCAPPED: 'on' } as NodeJS.ProcessEnv;

  it('未配置时默认取解析上界（10 万），不再是产品帽 500', () => {
    expect(defaultRunPoolCap(on)).toBe(UNCAPPED_RUN_POOL_CAP);
    expect(UNCAPPED_RUN_POOL_CAP).toBe(RUN_POOL_CAP_MAX);
    expect(parseRunPoolCap(undefined, on)).toEqual({
      mode: 'enforce',
      cap: UNCAPPED_RUN_POOL_CAP,
    });
  });

  it('显式 env 与 off 语义不变；畸形值回退防爆界（失败方向仍取「设闸」）', () => {
    expect(parseRunPoolCap('300', on)).toEqual({ mode: 'enforce', cap: 300 });
    expect(parseRunPoolCap('off', on)).toEqual({ mode: 'off' });
    expect(parseRunPoolCap('banana', on)).toEqual({
      mode: 'enforce',
      cap: UNCAPPED_RUN_POOL_CAP,
    });
    expect(parseRunPoolCap(undefined, { DISCOVERY_UNCAPPED: 'off' } as NodeJS.ProcessEnv)).toEqual({
      mode: 'enforce',
      cap: DEFAULT_RUN_POOL_CAP,
    });
  });

  it('开关默认 off 时行为与旧口径逐字节一致', () => {
    expect(defaultRunPoolCap({} as NodeJS.ProcessEnv)).toBe(DEFAULT_RUN_POOL_CAP);
    expect(parseRunPoolCap(undefined, {} as NodeJS.ProcessEnv)).toEqual({
      mode: 'enforce',
      cap: DEFAULT_RUN_POOL_CAP,
    });
  });
});

describe('createRunPoolGate —— 批内闸门', () => {
  it('把 seed 的公司计入池且有界', () => {
    const gate = createRunPoolGate(3, ['a', 'b', 'c']);
    expect(gate.has('a')).toBe(true);
    expect(gate.has('d')).toBe(false);
    expect(gate.full()).toBe(true);
  });

  it('未达 cap 时 full() 为假，note 后到界', () => {
    const gate = createRunPoolGate(2, ['a']);
    expect(gate.full()).toBe(false);
    gate.note('b');
    expect(gate.full()).toBe(true);
  });

  it('重复 seed / note 同一公司不重复计数', () => {
    const gate = createRunPoolGate(2, ['a', 'a']);
    gate.note('a');
    expect(gate.full()).toBe(false);
    gate.note('b');
    expect(gate.full()).toBe(true);
  });

  it('忽略空值 seed', () => {
    const gate = createRunPoolGate(1, ['', 'a']);
    expect(gate.full()).toBe(true);
  });

  it('cap 为 1 时，空池未满、记入一家即满', () => {
    const gate = createRunPoolGate(1, []);
    expect(gate.full()).toBe(false);
    gate.note('x');
    expect(gate.full()).toBe(true);
  });
});

describe('poolCapBlocks —— 写前判定', () => {
  it('已在池的公司永不阻塞（即使池已满）', () => {
    const gate = createRunPoolGate(1, ['a']);
    expect(poolCapBlocks(gate, 'a')).toBe(false);
  });

  it('新公司（id 未知）在池满时阻塞', () => {
    const gate = createRunPoolGate(1, ['a']);
    expect(poolCapBlocks(gate, null)).toBe(true);
  });

  it('未入池的既有公司在池满时阻塞', () => {
    const gate = createRunPoolGate(1, ['a']);
    expect(poolCapBlocks(gate, 'b')).toBe(true);
  });

  it('池未满时一律放行', () => {
    const gate = createRunPoolGate(2, ['a']);
    expect(poolCapBlocks(gate, null)).toBe(false);
    expect(poolCapBlocks(gate, 'b')).toBe(false);
  });

  it('恰好 cap 边界：第 cap 家放行，第 cap+1 家阻塞', () => {
    const gate = createRunPoolGate(2, ['a']);
    expect(poolCapBlocks(gate, 'b')).toBe(false);
    gate.note('b');
    expect(poolCapBlocks(gate, 'c')).toBe(true);
    expect(poolCapBlocks(gate, null)).toBe(true);
  });
});

describe('RUN_POOL_CAP_REACHED_REASON', () => {
  it('满足物化 outcome 的原因码形状（^[A-Z][A-Z0-9_]{0,63}$）', () => {
    expect(RUN_POOL_CAP_REACHED_REASON).toBe('RUN_POOL_CAP_REACHED');
    expect(RUN_POOL_CAP_REACHED_REASON).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/u);
  });
});
