/**
 * verify-ats-hiring：ATS 招聘信号真实数据验证（§5 硬规矩，无 sandbox）。
 *
 * 直连 Greenhouse(gitlab) + Ashby(ramp) 公开 JSON API，用本仓 `ats-boards` 纯解析器解**真实响应**，
 * 断言 detect / parseAtsJobs / buildHiringFromAtsJobs 对真实形状成立（防 API 形状漂移静默解析空）。
 * 零 DB、零鉴权（官方公开端点，GET 只读）。
 *
 * 跑：node --import tsx apps/api/scripts/verify-ats-hiring.mts
 */
import {
  detectAtsBoard,
  atsApiUrl,
  parseAtsJobs,
  buildHiringFromAtsJobs,
  type AtsBoard,
} from '../src/adapters/ats-boards';

const BUYING_RE = /procure|purchas|sourcing|buyer|supply-?chain|einkauf|beschaffung/i;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function checkBoard(board: AtsBoard, careersSignatureHtml: string): Promise<void> {
  const detected = detectAtsBoard(careersSignatureHtml);
  const url = atsApiUrl(board);
  const json = await fetchJson(url);
  const jobs = parseAtsJobs(board.vendor, json);
  const hiring = buildHiringFromAtsJobs(board.vendor, jobs);

  console.log(`\n=== ${board.vendor}:${board.token} ===`);
  console.log('detect(signature) :', JSON.stringify(detected));
  console.log('api               :', url);
  console.log('jobs parsed       :', jobs.length);
  console.log('sample titles     :', hiring?.titles.slice(0, 5));
  console.log('departments       :', hiring?.departments.slice(0, 6));
  console.log('locations         :', hiring?.locations.slice(0, 6));
  console.log('most_recent_at    :', hiring?.most_recent_at);
  console.log('buying-role open? :', hiring?.titles.some((t) => BUYING_RE.test(t)));

  // 断言（真实响应必须真解析出结构）
  if (!detected || detected.vendor !== board.vendor || detected.token !== board.token) {
    throw new Error(`detect mismatch: ${JSON.stringify(detected)}`);
  }
  if (jobs.length === 0) throw new Error('no jobs parsed from real response (形状漂移?)');
  if (!hiring || hiring.titles.length === 0) throw new Error('no hiring signal built');
  if (jobs.some((j) => !j.title)) throw new Error('empty title leaked');
  if (!hiring.most_recent_at) throw new Error('no parseable job timestamp (timing 信号缺)');
  console.log('✓ OK');
}

async function main(): Promise<void> {
  await checkBoard(
    { vendor: 'greenhouse', token: 'gitlab' },
    '<iframe src="https://boards-api.greenhouse.io/v1/boards/gitlab/jobs"></iframe>',
  );
  await checkBoard(
    { vendor: 'ashby', token: 'ramp' },
    '<a href="https://jobs.ashbyhq.com/ramp">Careers</a>',
  );
  console.log('\n✅ verify-ats-hiring 全绿：真实 Greenhouse + Ashby 响应解析成立（detect/parse/build）');
}

main().catch((e) => {
  console.error('❌ verify-ats-hiring 失败:', e);
  process.exit(1);
});
