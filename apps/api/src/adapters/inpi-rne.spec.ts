import { describe, it, expect, vi } from 'vitest';
import {
  mapDirigeant,
  mapCompanyHit,
  searchCompaniesWithDirigeants,
  INPI_RNE_LICENSE,
} from './inpi-rne';

/** 合成一条 physique dirigeant 原始记录（含 API 主动吐出的 DOB/国籍——断言我们剥离）。 */
const physiqueRaw = {
  nom: 'ANDRIÈS',
  prenoms: 'OLIVIER',
  qualite: 'Directeur Général',
  annee_de_naissance: '1962',
  date_de_naissance: '1962-04',
  nationalite: 'Française',
  type_dirigeant: 'personne physique',
};

describe('mapDirigeant · 🔴 数据最小化 + 类型过滤', () => {
  it('personne physique → 只取 nom/prenoms/qualite', () => {
    expect(mapDirigeant(physiqueRaw)).toEqual({ nom: 'ANDRIÈS', prenoms: 'OLIVIER', qualite: 'Directeur Général' });
  });

  it('🔴 绝不摄入 DOB / annee_de_naissance / nationalite（源头剥离）', () => {
    const out = mapDirigeant(physiqueRaw);
    const keys = Object.keys(out ?? {});
    expect(keys).not.toContain('date_de_naissance');
    expect(keys).not.toContain('annee_de_naissance');
    expect(keys).not.toContain('nationalite');
    // 整体序列化也不得含这些字段（防嵌套泄漏）
    expect(JSON.stringify(out)).not.toMatch(/naissance|nationalite|1962/i);
  });

  it('personne morale（法人负责人）→ null（非自然人买家）', () => {
    expect(
      mapDirigeant({ siren: '403021686', denomination: 'CABINET FOUCAULT', qualite: 'Gérant', type_dirigeant: 'personne morale' }),
    ).toBeNull();
  });

  it('commissaire aux comptes（审计师）→ null（即便 personne physique）', () => {
    expect(
      mapDirigeant({ nom: 'DUPONT', prenoms: 'JEAN', qualite: 'Commissaire aux comptes titulaire', type_dirigeant: 'personne physique' }),
    ).toBeNull();
  });

  it('缺 nom 或 qualite → null（不臆造）', () => {
    expect(mapDirigeant({ prenoms: 'JEAN', qualite: 'Gérant', type_dirigeant: 'personne physique' })).toBeNull();
    expect(mapDirigeant({ nom: 'DUPONT', type_dirigeant: 'personne physique' })).toBeNull();
  });

  it('prenoms 缺失 → 保留（部分记录仅姓）', () => {
    expect(mapDirigeant({ nom: 'DUPONT', qualite: 'Gérant', type_dirigeant: 'personne physique' })).toEqual({
      nom: 'DUPONT',
      prenoms: undefined,
      qualite: 'Gérant',
    });
  });
});

describe('mapCompanyHit · 公司事实 + dirigeants 内联过滤', () => {
  it('抽 siren/name + 只留 physique dirigeant（morale/审计师被剥）', () => {
    const hit = mapCompanyHit({
      siren: '562082909',
      nom_raison_sociale: 'SAFRAN',
      etat_administratif: 'A',
      dirigeants: [
        physiqueRaw,
        { siren: '1', denomination: 'X', qualite: 'Commissaire aux comptes titulaire', type_dirigeant: 'personne morale' },
        { nom: 'DUPONT', prenoms: 'JEAN', qualite: 'Commissaire aux comptes titulaire', type_dirigeant: 'personne physique' },
      ],
    });
    expect(hit?.siren).toBe('562082909');
    expect(hit?.name).toBe('SAFRAN');
    expect(hit?.etatAdministratif).toBe('A');
    expect(hit?.dirigeants).toEqual([{ nom: 'ANDRIÈS', prenoms: 'OLIVIER', qualite: 'Directeur Général' }]);
  });

  it('nom_raison_sociale 缺失 → 回退 nom_complet', () => {
    expect(mapCompanyHit({ siren: '1', nom_complet: 'ACME SARL', dirigeants: [] })?.name).toBe('ACME SARL');
  });

  it('缺 siren 或 name → null', () => {
    expect(mapCompanyHit({ nom_raison_sociale: 'X', dirigeants: [] })).toBeNull();
    expect(mapCompanyHit({ siren: '1', dirigeants: [] })).toBeNull();
  });

  it('dirigeants 缺失/非数组 → 空数组（fail-safe）', () => {
    expect(mapCompanyHit({ siren: '1', nom_raison_sociale: 'X' })?.dirigeants).toEqual([]);
  });
});

describe('searchCompaniesWithDirigeants · 注入 fetch', () => {
  const fakeFetch = (payload: unknown, status = 200): typeof fetch =>
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      headers: new Map(),
    }) as unknown as typeof fetch;

  it('解析 results → FrCompanyHit[]', async () => {
    const fetchImpl = fakeFetch({
      results: [{ siren: '562082909', nom_raison_sociale: 'SAFRAN', etat_administratif: 'A', dirigeants: [physiqueRaw] }],
      total_results: 1,
    });
    const out = await searchCompaniesWithDirigeants('safran', 5, { fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].siren).toBe('562082909');
    expect(out[0].dirigeants[0].qualite).toBe('Directeur Général');
    // 断言请求带上 q/per_page
    const url = (fetchImpl as unknown as { mock: { calls: [URL][] } }).mock.calls[0][0];
    expect(url.toString()).toContain('q=safran');
    expect(url.toString()).toContain('per_page=5');
  });

  it('空 query → 不出网、返空', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    expect(await searchCompaniesWithDirigeants('  ', 5, { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404 → 空数组（不抛）', async () => {
    const out = await searchCompaniesWithDirigeants('x', 5, { fetchImpl: fakeFetch({}, 404) });
    expect(out).toEqual([]);
  });

  it('license 常量 = Licence-Ouverte-2.0', () => {
    expect(INPI_RNE_LICENSE).toBe('Licence-Ouverte-2.0');
  });
});
