import { describe, expect, it } from "vitest";
import { candidateKey, coverageIdentityKey } from "./keys";

describe("评估集候选身份键", () => {
  it("canonical id 优先，统一小写", () => {
    expect(
      candidateKey({
        canonicalCompanyId: "0F0E7A4C-1111-4A2B-9C3D-1234567890AB",
        domain: "example.com",
      }),
    ).toBe("canonical:0f0e7a4c-1111-4a2b-9c3d-1234567890ab");
  });

  it("无 canonical id 时用域名（去空白小写）", () => {
    expect(candidateKey({ domain: "  Example.COM " })).toBe("domain:example.com");
  });

  it("最后回退到名称+国家：名称压缩空白小写，国家大写", () => {
    expect(candidateKey({ name: "  Acme   Pumps GmbH ", country: "de" })).toBe(
      "name:acme pumps gmbh|DE",
    );
  });

  it("名称无国家时国家段为空串", () => {
    expect(candidateKey({ name: "Acme" })).toBe("name:acme|");
  });

  it("三种引用全缺 → 拒绝", () => {
    expect(() => candidateKey({ domain: "   ", name: "  " })).toThrow(
      /EVALUATION_LABEL_CANDIDATE_MISSING/,
    );
  });
});

describe("覆盖估计身份键", () => {
  it("口径与计数决定身份：计数变化产生新键，口径大小写归一", () => {
    const base = {
      region: "DE",
      category: "pumps",
      sourceA: "public_web",
      sourceB: "registry_frame",
      countA: 10,
      countB: 8,
      overlap: 3,
    };
    const key = coverageIdentityKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // 地区/品类大小写不敏感 → 同键
    expect(
      coverageIdentityKey({ ...base, region: "de", category: "PUMPS" }),
    ).toBe(key);
    // 计数变化 → 不同键（append-only 追新行）
    expect(coverageIdentityKey({ ...base, overlap: 4 })).not.toBe(key);
    expect(coverageIdentityKey({ ...base, sourceB: "directory" })).not.toBe(key);
  });
});
