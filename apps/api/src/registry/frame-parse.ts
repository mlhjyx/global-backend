/**
 * Frame 源文件解析（CSV / JSON），只做「字节 → 行记录」，不做字段归一。
 * CSV 解析器为 RFC 4180 风格的手写状态机（支持引号转义、引号内逗号/换行、CRLF、BOM），
 * 严格模式：格式错误的记录带行号报错（fail closed），不静默跳过。
 */

export interface CsvRecord {
  /** 记录起始行号（1-based，含表头行）。 */
  line: number;
  values: string[];
}

export interface JsonRecord {
  /** 记录在数组中的序号（1-based，用于错误定位）。 */
  rowNumber: number;
  value: unknown;
}

export interface ParseIssue {
  code: string;
  row: number;
  detail: string;
}

export class FrameParseError extends Error {
  readonly issues: ParseIssue[];
  constructor(message: string, issues: ParseIssue[]) {
    super(message);
    this.name = 'FrameParseError';
    this.issues = issues;
  }
}

/** 解析 CSV 文本为表头 + 记录。空行跳过；表头必须唯一。 */
export function parseCsv(text: string, options: { delimiter?: string } = {}): {
  header: string[];
  records: CsvRecord[];
} {
  const delimiter = options.delimiter ?? ',';
  const issues: ParseIssue[] = [];
  const records: CsvRecord[] = [];

  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let line = 1;
  let recordStartLine = 1;
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let afterCloseQuote = false;
  let fieldStarted = false;
  let sawAnyChar = false;

  const endField = () => {
    fields.push(field);
    field = '';
    fieldStarted = false;
    afterCloseQuote = false;
  };

  const endRecord = () => {
    endField();
    if (sawAnyChar) {
      records.push({ line: recordStartLine, values: fields });
    }
    fields = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterCloseQuote = true;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (afterCloseQuote) {
      if (ch === delimiter) {
        endField();
        continue;
      }
      if (ch === '\r' && input[i + 1] === '\n') {
        endRecord();
        i++;
        line++;
        recordStartLine = line;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        endRecord();
        line++;
        recordStartLine = line;
        continue;
      }
      issues.push({
        code: 'CSV_TRAILING_CHARS_AFTER_QUOTE',
        row: recordStartLine,
        detail: `引号闭合后出现非法字符 ${JSON.stringify(ch)}`,
      });
      // 记录问题后继续解析以便一次报全；函数结束前有 issue 一律抛错（fail closed）。
      field += ch;
      afterCloseQuote = false;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      sawAnyChar = true;
      continue;
    }
    if (ch === '\r' && input[i + 1] === '\n') {
      endRecord();
      i++;
      line++;
      recordStartLine = line;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endRecord();
      line++;
      recordStartLine = line;
      continue;
    }
    field += ch;
    fieldStarted = true;
    sawAnyChar = true;
  }
  if (inQuotes) {
    issues.push({
      code: 'CSV_UNTERMINATED_QUOTE',
      row: recordStartLine,
      detail: '文件结束时引号仍未闭合',
    });
  }
  if (sawAnyChar || field !== '' || fields.length > 0) {
    endRecord();
  }
  if (issues.length > 0) {
    throw new FrameParseError(`CSV 解析失败（${issues.length} 处）`, issues);
  }
  if (records.length === 0) {
    throw new FrameParseError('CSV 为空（缺少表头）', [
      { code: 'CSV_EMPTY', row: 1, detail: '没有可读记录' },
    ]);
  }
  const header = records[0].values.map((h) => h.trim());
  const seen = new Set<string>();
  for (const name of header) {
    if (!name) {
      throw new FrameParseError('CSV 表头含空列名', [
        { code: 'CSV_EMPTY_HEADER', row: records[0].line, detail: '空列名' },
      ]);
    }
    if (seen.has(name)) {
      throw new FrameParseError(`CSV 表头列名重复：${name}`, [
        { code: 'CSV_DUPLICATE_HEADER', row: records[0].line, detail: name },
      ]);
    }
    seen.add(name);
  }
  return { header, records: records.slice(1) };
}

/** 按点分路径读取嵌套值（数组下标用数字段，如 `data.0.name`）。 */
export function readDottedPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 解析 JSON 文本，按 recordsPath 取出记录数组（必须是数组）。 */
export function parseJsonRecords(text: string, recordsPath: string): JsonRecord[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new FrameParseError('JSON 解析失败', [
      { code: 'JSON_INVALID', row: 1, detail: (error as Error).message },
    ]);
  }
  const records = readDottedPath(root, recordsPath);
  if (!Array.isArray(records)) {
    throw new FrameParseError(`JSON recordsPath "${recordsPath}" 不是数组`, [
      { code: 'JSON_RECORDS_NOT_ARRAY', row: 1, detail: recordsPath },
    ]);
  }
  return records.map((value, index) => ({ rowNumber: index + 1, value }));
}
