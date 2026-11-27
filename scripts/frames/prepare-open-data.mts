#!/usr/bin/env tsx
/**
 * 官方开放企业注册数据流式解压与清洗 CLI（UK Companies House / AU ABR ABN / BR RFB CNPJ）。
 *
 * 设计要点：
 *  - 全部通过 `unzip -p` 管道流式读取原始 ZIP，绝不整包解压到磁盘；
 *  - 清洗逻辑 100% 复用 `apps/api/src/registry/open-data-cleaners.ts` 纯函数（零漂移）；
 *  - 严格隐私护栏：只输出纯法人企业事实与城市/州/邮编级注册地，跳过自然人/个体户/MEI/Socios；
 *  - 支持 `--max-rows <N>` 先跑小样本验证并输出完整清洗过滤分布 JSON，再跑全量产出供 `import-frame.mts` 装载。
 *
 * 用法：
 *   pnpm exec tsx scripts/frames/prepare-open-data.mts \
 *     --source au|br|gb --input <zip-or-dir> --out <cleaned.csv> [--max-rows 10000]
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  BR_CORPORATE_NATUREZAS,
  cleanAuAbnRecord,
  cleanBrCnpjRecord,
  cleanUkCompaniesHouseRow,
  isValidBrCnpj,
} from '../../apps/api/src/registry/open-data-cleaners';
import { BR_SOLAR_ELECTRICAL_CNAE_CODES, normalizeBrCnae } from '../../apps/api/src/registry/industry-map';

const BR_CNAE_SET = new Set(BR_SOLAR_ELECTRICAL_CNAE_CODES);

function csvCell(value: string): string {
  if (/[",\r\n]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}

function csvRow(values: readonly string[]): string {
  return `${values.map(csvCell).join(',')}\n`;
}

function inc(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function extractXmlTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'u').exec(block);
  return match ? decodeXmlEntities(match[1]!).trim() : '';
}

function extractXmlAllTags(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gu');
  const out: string[] = [];
  for (const match of block.matchAll(re)) {
    const text = decodeXmlEntities(match[1]!).trim();
    if (text) out.push(text);
  }
  return out;
}

function listZipFiles(inputPath: string, prefix?: string): string[] {
  const resolved = resolve(inputPath);
  if (statSync(resolved).isFile()) return [resolved];
  return readdirSync(resolved)
    .filter((name) => name.endsWith('.zip') && (!prefix || name.startsWith(prefix)))
    .sort()
    .map((name) => join(resolved, name));
}

async function listZipMembers(zipPath: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('unzip', ['-Z1', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`unzip -Z1 ${zipPath} failed (${code}): ${stderr}`));
      else resolvePromise(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    });
  });
}

async function streamZipText(
  zipPath: string,
  member: string | null,
  encoding: BufferEncoding,
  onLine: (line: string) => boolean | void,
): Promise<void> {
  const args = member ? ['-p', zipPath, member] : ['-p', zipPath];
  const child = spawn('unzip', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding(encoding);
  let stderr = '';
  let stoppedEarly = false;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exitPromise = new Promise<number | null>((res, rej) => {
    child.on('error', rej);
    child.on('close', res);
  });
  for await (const line of rl) {
    if (onLine(line) === false) {
      stoppedEarly = true;
      rl.close();
      child.kill('SIGTERM');
      break;
    }
  }
  const code = await exitPromise;
  if (!stoppedEarly && code !== 0) {
    throw new Error(`unzip -p ${zipPath} ${member ?? ''} failed (${code}): ${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// 1. UK Companies House 流式清洗
// ---------------------------------------------------------------------------

async function prepareUk(inputPath: string, outPath: string, maxRows: number | null) {
  const zips = listZipFiles(inputPath);
  const stats: Record<string, number> = { scanned: 0, kept: 0, duplicates: 0 };
  const reasons: Record<string, number> = {};
  const naceDist: Record<string, number> = {};
  const seen = new Set<string>();
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  out.write(
    csvRow([
      'CompanyNumber',
      'CompanyName',
      'CompanyStatus',
      'CompanyCategory',
      'RegAddress.PostTown',
      'RegAddress.County',
      'RegAddress.PostCode',
      'SICCode.SicText_1',
    ]),
  );

  let stop = false;
  for (const zipPath of zips) {
    if (stop) break;
    let headerIdx: Map<string, number> | null = null;
    await streamZipText(zipPath, null, 'utf8', (rawLine) => {
      const line = rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
      if (!line.trim()) return true;
      const cols = parseCsvLine(line, ',');
      if (!headerIdx) {
        headerIdx = new Map(cols.map((h, idx) => [h.trim(), idx]));
        return true;
      }
      stats.scanned!++;
      const col = (name: string) => cols[headerIdx!.get(name) ?? -1] ?? '';
      const outcome = cleanUkCompaniesHouseRow({
        companyNumber: col('CompanyNumber'),
        companyName: col('CompanyName'),
        companyStatus: col('CompanyStatus'),
        companyCategory: col('CompanyCategory'),
        postTown: col('RegAddress.PostTown'),
        county: col('RegAddress.County'),
        postCode: col('RegAddress.PostCode'),
        sicTexts: [
          col('SICCode.SicText_1'),
          col('SICCode.SicText_2'),
          col('SICCode.SicText_3'),
          col('SICCode.SicText_4'),
        ],
      });
      if (!outcome.keep) {
        inc(reasons, outcome.reason);
      } else if (seen.has(outcome.row.CompanyNumber)) {
        stats.duplicates!++;
      } else {
        seen.add(outcome.row.CompanyNumber);
        stats.kept!++;
        inc(naceDist, outcome.row.NaceCode);
        out.write(
          csvRow([
            outcome.row.CompanyNumber,
            outcome.row.CompanyName,
            outcome.row.CompanyStatus,
            outcome.row.CompanyCategory,
            outcome.row.PostTown,
            outcome.row.County,
            outcome.row.PostCode,
            outcome.row.MatchedSic,
          ]),
        );
      }
      if (maxRows !== null && stats.scanned! >= maxRows) {
        stop = true;
        return false;
      }
      return true;
    });
  }
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
  return { source: 'gb', outPath, stats, reasons, naceDist };
}

// ---------------------------------------------------------------------------
// 2. 澳洲 ABN Bulk Extract 流式 XML 清洗（零磁盘解压）
// ---------------------------------------------------------------------------

async function prepareAu(inputPath: string, outPath: string, maxRows: number | null) {
  const zips = listZipFiles(inputPath);
  const stats: Record<string, number> = { scanned: 0, kept: 0, duplicates: 0, xmlFiles: 0 };
  const reasons: Record<string, number> = {};
  const naceDist: Record<string, number> = {};
  const ruleDist: Record<string, number> = {};
  const seen = new Set<string>();
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  out.write(
    csvRow([
      'Abn',
      'LegalName',
      'Status',
      'EntityType',
      'State',
      'Postcode',
      'NaceCode',
      'Acn',
      'GstStatus',
      'MatchRule',
      'MatchedTradingName',
    ]),
  );

  let stop = false;
  for (const zipPath of zips) {
    if (stop) break;
    const members = (await listZipMembers(zipPath)).filter((name) => name.endsWith('.xml'));
    for (const member of members) {
      if (stop) break;
      stats.xmlFiles!++;
      let pending = '';
      await streamZipText(zipPath, member, 'utf8', (line) => {
        pending += line;
        let endIdx = pending.indexOf('</ABR>');
        while (endIdx !== -1) {
          const startIdx = pending.indexOf('<ABR ');
          if (startIdx !== -1 && startIdx < endIdx) {
            const block = pending.slice(startIdx, endIdx + 6);
            stats.scanned!++;
            const abnMatch = /<ABN[^>]*status="([^"]+)"[^>]*>([^<]+)<\/ABN>/u.exec(block);
            const gstMatch = /<GST[^>]*status="([^"]+)"/u.exec(block);
            const isIndividual = block.includes('<LegalEntity>');
            const mainBlock = /<MainEntity>([\s\S]*?)<\/MainEntity>/u.exec(block)?.[1] ?? '';
            const otherNames = extractXmlAllTags(block, 'NonIndividualNameText');
            const legalName = extractXmlTag(mainBlock, 'NonIndividualNameText');
            const tradingNames = otherNames.filter((n) => n !== legalName);
            const outcome = cleanAuAbnRecord({
              abn: abnMatch?.[2] ?? '',
              status: abnMatch?.[1] ?? '',
              entityTypeInd: extractXmlTag(block, 'EntityTypeInd'),
              isIndividual,
              legalName,
              tradingNames,
              state: extractXmlTag(mainBlock, 'State'),
              postcode: extractXmlTag(mainBlock, 'Postcode'),
              asicNumber: extractXmlTag(block, 'ASICNumber'),
              gstStatus: gstMatch?.[1] ?? '',
            });
            if (!outcome.keep) {
              inc(reasons, outcome.reason);
            } else if (seen.has(outcome.row.Abn)) {
              stats.duplicates!++;
            } else {
              seen.add(outcome.row.Abn);
              stats.kept!++;
              inc(naceDist, outcome.row.NaceCode);
              inc(ruleDist, outcome.row.MatchRule);
              out.write(
                csvRow([
                  outcome.row.Abn,
                  outcome.row.LegalName,
                  outcome.row.Status,
                  outcome.row.EntityType,
                  outcome.row.State,
                  outcome.row.Postcode,
                  outcome.row.NaceCode,
                  outcome.row.Acn,
                  outcome.row.GstStatus,
                  outcome.row.MatchRule,
                  outcome.row.MatchedTradingName,
                ]),
              );
            }
          }
          pending = pending.slice(endIdx + 6);
          if (maxRows !== null && stats.scanned! >= maxRows) {
            stop = true;
            return false;
          }
          endIdx = pending.indexOf('</ABR>');
        }
        // 防止头部 TransferInfo 等未闭合标签累积占内存。
        if (pending.length > 262_144 && !pending.includes('<ABR ')) {
          pending = pending.slice(-4096);
        }
        return true;
      });
    }
  }
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
  return { source: 'au', outPath, stats, reasons, naceDist, ruleDist };
}

// ---------------------------------------------------------------------------
// 3. 巴西 RFB CNPJ 流式清洗（12.5 MB BitSet 过滤 MEI + 两阶段流式关联）
// ---------------------------------------------------------------------------

function setBit(bits: Uint8Array, index: number): void {
  if (index >= 0 && index < 100_000_000) bits[index >> 3]! |= 1 << (index & 7);
}

function hasBit(bits: Uint8Array, index: number): boolean {
  if (index < 0 || index >= 100_000_000) return false;
  return (bits[index >> 3]! & (1 << (index & 7))) !== 0;
}

interface PendingBrEst {
  cnpjBasico: string;
  cnpjOrdem: string;
  cnpjDv: string;
  nomeFantasia: string;
  cnaePrincipal: string;
  municipioCode: string;
  uf: string;
  cep: string;
}

async function loadBrMunicipios(dirPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const zipPath = join(resolve(dirPath), 'Municipios.zip');
  if (!existsSync(zipPath)) return map;
  await streamZipText(zipPath, null, 'latin1', (line) => {
    if (!line.trim()) return true;
    const cols = parseCsvLine(line, ';');
    if (cols[0] && cols[1]) map.set(cols[0].trim(), cols[1].trim());
    return true;
  });
  return map;
}

async function loadBrMeiBitset(dirPath: string): Promise<{ bits: Uint8Array; meiCount: number }> {
  const bits = new Uint8Array(12_500_000);
  let meiCount = 0;
  const zipPath = join(resolve(dirPath), 'Simples.zip');
  if (!existsSync(zipPath)) return { bits, meiCount };
  await streamZipText(zipPath, null, 'latin1', (line) => {
    if (!line || !line.includes(';"S";')) return true;
    // Simples 仅含固定编码与日期，不含字段内分号；第 4 列（0-based）为 opcao_mei。
    const cols = line.split(';');
    const mei = cols[4]?.replace(/"/gu, '').trim();
    if (mei === 'S') {
      const idx = Number(cols[0]?.replace(/"/gu, '').trim());
      if (Number.isInteger(idx)) {
        setBit(bits, idx);
        meiCount++;
      }
    }
    return true;
  });
  return { bits, meiCount };
}

async function prepareBr(dirPath: string, outPath: string, maxRows: number | null) {
  const municipios = await loadBrMunicipios(dirPath);
  const { bits: meiBits, meiCount } = await loadBrMeiBitset(dirPath);
  const wantedBits = new Uint8Array(12_500_000);
  const estByBasico = new Map<string, PendingBrEst>();

  const stats: Record<string, number> = {
    simplesMeiFlagged: meiCount,
    estScanned: 0,
    estCandidates: 0,
    empScanned: 0,
    kept: 0,
    duplicates: 0,
  };
  const reasons: Record<string, number> = {};
  const naceDist: Record<string, number> = {};

  // 阶段 1：流式扫描 Estabelecimentos*.zip，仅保留在营总部 + 目标 CNAE + 非 MEI。
  const estZips = listZipFiles(dirPath, 'Estabelecimentos');
  let stopEst = false;
  for (const zipPath of estZips) {
    if (stopEst) break;
    await streamZipText(zipPath, null, 'latin1', (line) => {
      if (!line.trim()) return true;
      stats.estScanned!++;
      // 快速路径：固定前缀 `"8位";"4位";"2位";"1位";` 直接判分店，并跳过无 `;"02";` 的非在营行。
      const fixedPrefix =
        line.charCodeAt(0) === 34 &&
        line.charCodeAt(10) === 59 &&
        line.charCodeAt(17) === 59 &&
        line.charCodeAt(22) === 59 &&
        line.charCodeAt(23) === 34 &&
        line.charCodeAt(25) === 34;
      if (fixedPrefix && line.charCodeAt(24) !== 49) {
        inc(reasons, 'skipped_branch');
        if (maxRows !== null && stats.estScanned! >= maxRows) {
          stopEst = true;
          return false;
        }
        return true;
      }
      if (fixedPrefix && !line.includes(';"02";')) {
        inc(reasons, 'inactive_status');
        if (maxRows !== null && stats.estScanned! >= maxRows) {
          stopEst = true;
          return false;
        }
        return true;
      }
      const cols = parseCsvLine(line, ';');
      const matriz = cols[3]?.trim() ?? '';
      const situacao = cols[5]?.trim() ?? '';
      const cnae = normalizeBrCnae(cols[11] ?? '');
      const basico = (cols[0]?.trim() ?? '').padStart(8, '0');
      const ordem = (cols[1]?.trim() ?? '').padStart(4, '0');
      const dv = (cols[2]?.trim() ?? '').padStart(2, '0');

      if (matriz !== '1') {
        inc(reasons, 'skipped_branch');
      } else if (situacao !== '02') {
        inc(reasons, 'inactive_status');
      } else if (!cnae || !BR_CNAE_SET.has(cnae)) {
        inc(reasons, 'industry_unmatched');
      } else if (hasBit(meiBits, Number(basico))) {
        inc(reasons, 'skipped_mei');
      } else if (!isValidBrCnpj(`${basico}${ordem}${dv}`)) {
        inc(reasons, 'invalid_cnpj');
      } else if (estByBasico.has(basico)) {
        stats.duplicates!++;
      } else {
        setBit(wantedBits, Number(basico));
        estByBasico.set(basico, {
          cnpjBasico: basico,
          cnpjOrdem: ordem,
          cnpjDv: dv,
          nomeFantasia: cols[4]?.trim() ?? '',
          cnaePrincipal: cnae,
          cep: cols[18]?.trim() ?? '',
          uf: cols[19]?.trim() ?? '',
          municipioCode: cols[20]?.trim() ?? '',
        });
        stats.estCandidates!++;
      }
      if (maxRows !== null && stats.estScanned! >= maxRows) {
        stopEst = true;
        return false;
      }
      return true;
    });
  }

  // 阶段 2：流式扫描 Empresas*.zip（绝不碰 Socios*.zip），按 wantedBits 关联企业名与法律形式。
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  out.write(
    csvRow([
      'Cnpj',
      'RazaoSocial',
      'SituacaoCadastral',
      'NaturezaJuridica',
      'CnaePrincipal',
      'Municipio',
      'Uf',
      'Cep',
      'Porte',
      'NomeFantasia',
    ]),
  );

  const empZips = listZipFiles(dirPath, 'Empresas');
  for (const zipPath of empZips) {
    await streamZipText(zipPath, null, 'latin1', (line) => {
      if (!line.trim()) return true;
      stats.empScanned!++;
      // 快速路径：首列为 8 位 cnpj_basico，仅对 wantedBits 命中的行做完整 CSV 解析。
      const rawPrefix = line.charCodeAt(0) === 34 ? line.slice(1, 9) : line.slice(0, 8);
      if (/^\d{8}$/u.test(rawPrefix) && !hasBit(wantedBits, Number(rawPrefix))) return true;
      const cols = parseCsvLine(line, ';');
      const basico = (cols[0]?.trim() ?? '').padStart(8, '0');
      if (!hasBit(wantedBits, Number(basico))) return true;
      const est = estByBasico.get(basico);
      if (!est) return true;
      estByBasico.delete(basico);

      const natureza = cols[2]?.trim() ?? '';
      if (!(natureza in BR_CORPORATE_NATUREZAS)) {
        inc(reasons, natureza === '2135' ? 'skipped_individual_entrepreneur' : 'skipped_non_corporate_natureza');
        return true;
      }

      const outcome = cleanBrCnpjRecord({
        cnpjBasico: est.cnpjBasico,
        cnpjOrdem: est.cnpjOrdem,
        cnpjDv: est.cnpjDv,
        matrizFilial: '1',
        situacaoCadastral: '02',
        cnaePrincipal: est.cnaePrincipal,
        razaoSocial: cols[1] ?? '',
        nomeFantasia: est.nomeFantasia,
        naturezaJuridica: natureza,
        porte: cols[5]?.trim() ?? '',
        isMei: false,
        municipio: municipios.get(est.municipioCode) ?? '',
        uf: est.uf,
        cep: est.cep,
      });
      if (!outcome.keep) {
        inc(reasons, outcome.reason);
      } else {
        stats.kept!++;
        inc(naceDist, outcome.row.CnaePrincipal);
        out.write(
          csvRow([
            outcome.row.Cnpj,
            outcome.row.RazaoSocial,
            outcome.row.SituacaoCadastral,
            outcome.row.NaturezaJuridica,
            outcome.row.CnaePrincipal,
            outcome.row.Municipio,
            outcome.row.Uf,
            outcome.row.Cep,
            outcome.row.Porte,
            outcome.row.NomeFantasia,
          ]),
        );
      }
      return true;
    });
  }
  stats.unmatchedEstWithoutEmpresa = estByBasico.size;
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
  return { source: 'br', outPath, stats, reasons, cnaeDist: naceDist };
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    input: { type: 'string' },
    out: { type: 'string' },
    'max-rows': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.source || !values.input || !values.out) {
  process.stdout.write(
    'usage: pnpm exec tsx scripts/frames/prepare-open-data.mts --source gb|au|br --input <zip-or-dir> --out <cleaned.csv> [--max-rows 10000]\n',
  );
  process.exit(values.help ? 0 : 1);
}

const maxRows = values['max-rows'] ? Number(values['max-rows']) : null;
if (maxRows !== null && (!Number.isInteger(maxRows) || maxRows <= 0)) {
  process.stderr.write('--max-rows 必须是正整数\n');
  process.exit(1);
}

let summary: unknown;
if (values.source === 'gb') {
  summary = await prepareUk(values.input, values.out, maxRows);
} else if (values.source === 'au') {
  summary = await prepareAu(values.input, values.out, maxRows);
} else if (values.source === 'br') {
  summary = await prepareBr(values.input, values.out, maxRows);
} else {
  process.stderr.write(`未知 --source: ${values.source}（允许 gb | au | br）\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
