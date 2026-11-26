import {
  boundedArray,
  boundedNumber,
  boundedString,
  closedObject,
  type OutputSchema,
} from './task-schema-bounds';

const ATTRIBUTE_SCALAR: OutputSchema = {
  oneOf: [
    boundedString(1000),
    boundedNumber(-1_000_000_000_000_000, 1_000_000_000_000_000),
    { type: 'boolean' },
    { type: 'null' },
  ],
};

const ATTRIBUTE_VALUE: OutputSchema = {
  oneOf: [
    ...(ATTRIBUTE_SCALAR.oneOf as OutputSchema[]),
    boundedArray(32, ATTRIBUTE_SCALAR),
  ],
};

export const SELLER_DOCUMENT_ANALYZE_DESCRIPTION =
  '从卖家上传的产品画册/规格书/资料文本或页面图像中抽取结构化产品目录（含型号、简述、MOQ/交期/参数/认证等明确属性）、可核验企业事实要点（必须附带原文连续原句 quote 与对应 chunkSeq），并在资料有明确说明时提炼行业与简介。严禁编造资料中不存在的型号、认证、参数或数字。';

export const SELLER_DOCUMENT_ANALYZE_OUTPUT_SCHEMA: OutputSchema = closedObject(
  {
    industry: boundedString(200, { description: '主行业（仅在画册明确体现时填写）' }),
    summary: boundedString(2000, { description: '80-150 字企业与主营产品简介（可选）' }),
    transcribedMarkdown: boundedString(20000, {
      description: '仅视觉模式：将图片页面中的产品型号、参数表、资质认证与交期整理为忠实原文的 Markdown',
    }),
    products: boundedArray(
      40,
      closedObject(
        {
          name: boundedString(500, { description: '产品/型号名称（保留原文语言）' }),
          description: boundedString(4000, { description: '一句话产品简述' }),
          attributes: closedObject(
            {
              moq: ATTRIBUTE_VALUE,
              lead_time: ATTRIBUTE_VALUE,
              materials: ATTRIBUTE_VALUE,
              params: ATTRIBUTE_VALUE,
              certifications: ATTRIBUTE_VALUE,
            },
            [],
          ),
          evidence: boundedString(2000, { description: '支持该产品的原文片段' }),
          confidence: boundedNumber(0, 1),
        },
        ['name', 'confidence'],
      ),
    ),
    claims: boundedArray(
      40,
      closedObject(
        {
          chunkSeq: boundedNumber(0, 10000),
          type: boundedString(80, {
            description:
              'capability | certification | case | param | moq | lead_time | market | company_fact | value_prop',
          }),
          statement: boundedString(4000, { description: '凝练事实陈述' }),
          quote: boundedString(2000, {
            description: '必须逐字摘自对应分块原文的连续片段（用于服务端字节锚点核验）',
          }),
          confidence: boundedNumber(0, 1),
        },
        ['chunkSeq', 'type', 'statement', 'quote', 'confidence'],
      ),
    ),
  },
  ['products', 'claims'],
);
