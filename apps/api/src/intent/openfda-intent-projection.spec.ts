import { describe, expect, it } from 'vitest';
import { isLikelyIndividualApplicant, FDA_CLEARANCE, FDA_CLEARANCE_STRENGTH } from './openfda-intent-projection.service';

// isLikelyIndividualApplicant = §6 GDPR 边界的**高精度**闸门：只在明确人名格式（头衔 / "Surname, Given"）上触发，
// 绝不按「几个大写词」形状误伤真公司（会丢线索、损核心功能）。裸「John Smith」式不自动判个体（风险有界——从不落
// contact/邮箱等具名个人字段）。DB 端到端投影/幂等/§8.8 门走真实 verify 脚本（verify-openfda-510k-intent.mts）。
describe('§6 个体户自然人边界（isLikelyIndividualApplicant）—— 高精度、不误伤真公司', () => {
  it('公司名（含 3 词公司名、CJK 公司）一律保留，绝不按形状误判', () => {
    for (const n of [
      'Shenzhen Beauty Every Moment Intelligent Electric Co., Ltd.',
      'Guangdong Jinme Medical Technology Co., Ltd.',
      'Philips Ultrasound LLC',
      'Siemens Healthineers GmbH',
      'Boston Scientific Corporation',
      'Karl Storz Endoscopy', // 3 词公司名（形状似人名，绝不误伤）
      'GE Precision Healthcare', // 3 词公司名
      'Ischemaview', // 单词品牌
      'Medtronic',
      '3M',
      'Johnson & Johnson',
      '深圳市某某医疗器械有限公司',
      'John Smith', // 裸人名式：不自动判个体（避免误伤真公司），风险有界
    ]) {
      expect(isLikelyIndividualApplicant(n)).toBe(false);
    }
  });

  it('明确人名格式 → 跳过（人称头衔 / "Surname, Given"）', () => {
    for (const n of ['Dr. Jane Smith', 'Mr. Robert Miller', 'Prof. Alan Turing', 'Smith, John', 'Miller, Robert J.']) {
      expect(isLikelyIndividualApplicant(n)).toBe(true);
    }
  });

  it('逗号但带组织标记（"Ever Fortune.Ai, Co., Ltd."）→ 保留（非人名）', () => {
    expect(isLikelyIndividualApplicant('Ever Fortune.Ai, Co., Ltd.')).toBe(false);
  });

  it('头衔起头但带法人后缀（"Dr. Mach GmbH & Co. KG"）→ 保留（组织标记先判，Codex 复审回归）', () => {
    expect(isLikelyIndividualApplicant('Dr. Mach GmbH & Co. KG')).toBe(false);
    expect(isLikelyIndividualApplicant('Prof. Zimmer Medical Ltd')).toBe(false);
  });

  it('空名 → 跳过（不可入库）', () => {
    expect(isLikelyIndividualApplicant('')).toBe(true);
    expect(isLikelyIndividualApplicant('   ')).toBe(true);
  });
});

describe('FDA_CLEARANCE 常量', () => {
  it('type 与强度（新品/上市时机，略弱于 TED 开放招标 0.9）', () => {
    expect(FDA_CLEARANCE).toBe('FDA_CLEARANCE');
    expect(FDA_CLEARANCE_STRENGTH).toBeGreaterThan(0);
    expect(FDA_CLEARANCE_STRENGTH).toBeLessThan(0.9);
  });
});
