/**
 * ATS 招聘板公开 JSON API 适配（Greenhouse / Lever / Ashby）。
 *
 * 把「招聘信号」从「靠站点自发 JobPosting JSON-LD」（真实站点多不发 → HIRING_UP 覆盖低）升级为
 * **结构化真值**：主流 ATS 以免鉴权公开 JSON 暴露在招岗位（标题/部门/地点/更新时间）。
 * 本模块只做**检测 + 解析（纯函数，不触网）**——实际 GET 由调用方经 ToolBroker(http.get) 出网
 *（SSRF/限流/预算护栏在工具内权威强制）。
 *
 * 🟢 合规：公开岗位 = 公司事实，零 GDPR（**只取岗位/部门/地点，绝不取招聘官姓名**）。官方公开端点，GET 只读。
 */

export type AtsVendor = 'greenhouse' | 'lever' | 'ashby';

/** ATS board 标识（公司 slug/token）+ 供应商。 */
export interface AtsBoard {
  vendor: AtsVendor;
  token: string;
}

/** 归一后的一条在招岗位（缺字段一律 null；绝不含个人数据）。 */
export interface AtsJob {
  title: string;
  department: string | null;
  location: string | null;
  updatedAt: string | null; // ISO；无/不可解析 → null
}

/**
 * ATS 招聘信号（对齐 page-signals/structured_harvest 的 hiring 形状 + 结构化增强）。
 * 不含 has_buying_role——由调用方按其 isBuyingRole 判定（避免本模块反向依赖 provider）。
 */
export interface AtsHiring {
  source: string; // 'ats:greenhouse' | 'ats:lever' | 'ats:ashby'
  open_roles: number;
  titles: string[];
  departments: string[];
  locations: string[];
  most_recent_at: string | null; // 最新岗位更新/发布时刻（真实 timing 信号）
}

const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{1,60}$/i;
// board 路径里常见的**非 token** 段（静态资源/通用路径），命中即跳过，避免误当公司 token。
const TOKEN_DENYLIST = new Set([
  'embed', 'js', 'assets', 'static', 'api', 'v0', 'v1', 'postings', 'boards',
  'job_board', 'jobs', 'widget', 'css', 'images', 'www', 'job-board', 'posting-api',
]);

function validToken(t: string | undefined | null): string | null {
  if (!t) return null;
  const tok = t.trim();
  if (!TOKEN_RE.test(tok) || TOKEN_DENYLIST.has(tok.toLowerCase())) return null;
  return tok;
}

/**
 * 从（渲染后）HTML 检测 ATS 供应商 + board token（第一个可信命中）。
 * 多签名兜底：embed 参数、boards[-api] 直链、data 属性、公开 board / API 直链。
 */
export function detectAtsBoard(html: string): AtsBoard | null {
  if (!html) return null;
  const patterns: Array<{ vendor: AtsVendor; re: RegExp }> = [
    // Greenhouse（更具体的先匹配）——embed 以 for= 为锚，兼容 iframe(job_board?for=) 与
    // 官方主推 JS 嵌入(embed/job_board/js?for=)，且 for= 可在任意查询参数位。
    { vendor: 'greenhouse', re: /boards\.greenhouse\.io\/embed\/job_board(?:\/js)?\?[^"'\s]*\bfor=([a-z0-9._-]+)/gi },
    { vendor: 'greenhouse', re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9._-]+)/gi },
    { vendor: 'greenhouse', re: /data-board-token=["']([a-z0-9._-]+)["']/gi },
    { vendor: 'greenhouse', re: /boards\.greenhouse\.io\/([a-z0-9._-]+)/gi },
    // Lever
    { vendor: 'lever', re: /api\.lever\.co\/v0\/postings\/([a-z0-9._-]+)/gi },
    { vendor: 'lever', re: /jobs\.lever\.co\/([a-z0-9._-]+)/gi },
    // Ashby
    { vendor: 'ashby', re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9._-]+)/gi },
    { vendor: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9._-]+)/gi },
  ];
  // 逐 pattern（保供应商优先级），扫**全部**命中取首个通过 validToken 的——
  // 避免 denylist 首命中（如 /embed 路径段）掩盖文档后段的有效 board 直链。
  for (const { vendor, re } of patterns) {
    for (const m of html.matchAll(re)) {
      const token = validToken(m[1]);
      if (token) return { vendor, token };
    }
  }
  return null;
}

/** 该 board 的公开 JSON API URL（调用方经 ToolBroker http.get 拉）。 */
export function atsApiUrl(board: AtsBoard): string {
  const token = encodeURIComponent(board.token);
  switch (board.vendor) {
    case 'greenhouse':
      // 不加 ?content=true：它会为每岗返回整段职位描述 HTML（gitlab 实测 105KB→2.38MB，23×，
      // 且富文本可能含招聘官姓名等个人数据）。核心信号（标题/地点/更新时间/买家岗）无需 content；
      // departments 需 content 故 Greenhouse 侧留空（数据最小化取舍）——Ashby/Lever 基础响应仍带部门。
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${token}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  }
}

/** 解析各 ATS 的 JSON（unknown 安全）→ 归一 AtsJob[]。结构不符 → 空数组（fail-safe）。 */
export function parseAtsJobs(vendor: AtsVendor, json: unknown): AtsJob[] {
  switch (vendor) {
    case 'greenhouse':
      return parseGreenhouse(json);
    case 'lever':
      return parseLever(json);
    case 'ashby':
      return parseAshby(json);
  }
}

/**
 * ATS 岗位 → 招聘信号。空 → null。
 * most_recent_at = 最新岗位时刻（真实 timing）；titles/departments/locations 去重限量。
 */
export function buildHiringFromAtsJobs(vendor: AtsVendor, jobs: AtsJob[]): AtsHiring | null {
  if (!jobs.length) return null;
  const titles = uniq(jobs.map((j) => j.title)).slice(0, 20);
  const departments = uniq(jobs.map((j) => j.department)).slice(0, 12);
  const locations = uniq(jobs.map((j) => j.location)).slice(0, 12);
  // reduce（非 Math.max(...spread)）：对超大响应也不展开数组、无栈风险。
  const latestMs = jobs.reduce((max, j) => {
    const ms = j.updatedAt ? Date.parse(j.updatedAt) : NaN;
    return Number.isFinite(ms) && ms > max ? ms : max;
  }, -Infinity);
  return {
    source: `ats:${vendor}`,
    open_roles: jobs.length,
    titles,
    departments,
    locations,
    most_recent_at: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
  };
}

// ─────────────────────── 各 ATS 解析器（纯，unknown 安全） ───────────────────────

/** Greenhouse `/boards/{t}/jobs`: { jobs: [{ title, location:{name}, departments:[{name}], updated_at }] } */
function parseGreenhouse(json: unknown): AtsJob[] {
  return asArray(rec(json)?.jobs)
    .map((j) => {
      const o = rec(j);
      return {
        title: str(o?.title) ?? '',
        department: str(rec(asArray(o?.departments)[0])?.name),
        location: str(rec(o?.location)?.name),
        updatedAt: toIso(o?.updated_at),
      };
    })
    .filter((j) => j.title);
}

/** Lever `/postings/{t}?mode=json`: [{ text, categories:{team,location,department}, createdAt(ms) }] */
function parseLever(json: unknown): AtsJob[] {
  return asArray(json)
    .map((j) => {
      const o = rec(j);
      const cat = rec(o?.categories);
      return {
        title: str(o?.text) ?? '',
        department: str(cat?.department) ?? str(cat?.team),
        location: str(cat?.location) ?? firstStr(cat?.allLocations), // allLocations 是字符串数组
        updatedAt: toIso(o?.createdAt),
      };
    })
    .filter((j) => j.title);
}

/** Ashby `/posting-api/job-board/{t}`: { jobs: [{ title, department, location, publishedAt/updatedAt }] } */
function parseAshby(json: unknown): AtsJob[] {
  return asArray(rec(json)?.jobs)
    .map((j) => {
      const o = rec(j);
      return {
        title: str(o?.title) ?? '',
        department: str(o?.department) ?? str(o?.team),
        location: str(o?.location) ?? str(o?.locationName),
        updatedAt: toIso(o?.updatedAt) ?? toIso(o?.publishedAt) ?? toIso(o?.publishedDate),
      };
    })
    .filter((j) => j.title);
}

// ─────────────────────── helpers ───────────────────────

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
/** 数组取第一个字符串元素（Lever categories.allLocations 等）。 */
function firstStr(v: unknown): string | null {
  return Array.isArray(v) ? str(v[0]) : null;
}
function uniq(arr: Array<string | null>): string[] {
  return [...new Set(arr.filter((x): x is string => !!x))];
}
/** 数值(秒/毫秒 epoch)或 ISO 串 → ISO；不可解析 → null。 */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v; // <1e12 视作秒级 epoch
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}
