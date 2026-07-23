import type { SiteSpecStylePreset } from '@global/contracts';

/**
 * 风格预设 = token 包（04 §6）。字体自托管（GDPR 判例 F1，02 §8）。
 * 切 preset=秒级重渲染。`local-trust` = 本地服务/电工类出海站的深海军蓝 + 电光黄 + 暖白语言。
 */

export interface ThemeTokens {
  colors: {
    primary: string;
    primaryDark: string;
    secondary: string;
    accent: string;
    accentStrong: string;
    surface: string;
    surfaceAlt: string;
    surfaceAlt2: string;
    border: string;
    onSurface: string;
    onSurfaceMuted: string;
    onSurfaceSubtle: string;
    onPrimary: string;
    onAccent: string;
    onDark: string;
    onDarkMuted: string;
  };
  typography: { fontBody: string; fontHeading: string; scale: number };
  radius: string;
  radiusLg: string;
  motionIntensity: 'none' | 'subtle' | 'normal';
}

const SANS =
  "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const THEME_PRESETS: Record<SiteSpecStylePreset, ThemeTokens> = {
  // 深钢蓝 + 高对比：机械/泵阀/金属加工类制造业
  'modern-industrial': {
    colors: {
      primary: '#0E5FA8',
      primaryDark: '#0A3D6B',
      secondary: '#123B5E',
      accent: '#F5B301',
      accentStrong: '#E0A800',
      surface: '#FFFFFF',
      surfaceAlt: '#F2F5F8',
      surfaceAlt2: '#E6ECF2',
      border: '#D8E1EA',
      onSurface: '#16212C',
      onSurfaceMuted: '#51606F',
      onSurfaceSubtle: '#6B7785',
      onPrimary: '#FFFFFF',
      onAccent: '#16212C',
      onDark: '#FFFFFF',
      onDarkMuted: '#C7D2DC',
    },
    typography: { fontBody: SANS, fontHeading: SANS, scale: 1.25 },
    radius: '6px',
    radiusLg: '12px',
    motionIntensity: 'subtle',
  },
  // 浅底暖橙点缀：精密仪器/电子/医疗器械类
  'precision-light': {
    colors: {
      primary: '#D9662B',
      primaryDark: '#A84A1C',
      secondary: '#2A2E33',
      accent: '#D9662B',
      accentStrong: '#C2561D',
      surface: '#FCFBF9',
      surfaceAlt: '#F1EEE9',
      surfaceAlt2: '#E6E0D6',
      border: '#DCD4C6',
      onSurface: '#20242A',
      onSurfaceMuted: '#5D6570',
      onSurfaceSubtle: '#7A818B',
      onPrimary: '#FFFFFF',
      onAccent: '#FFFFFF',
      onDark: '#FCFBF9',
      onDarkMuted: '#D8D2C6',
    },
    typography: { fontBody: SANS, fontHeading: SANS, scale: 1.2 },
    radius: '10px',
    radiusLg: '16px',
    motionIntensity: 'subtle',
  },
  // 深海军蓝 + 电光黄 + 暖白：本地服务/电工/家政类出海独立站
  // 排版与交互对标 Bricolage Grotesque 标题 + Inter 正文、eyebrow 胶囊、巨型标题、12 栏分栏。
  'local-trust': {
    colors: {
      primary: '#1B2D52',
      primaryDark: '#0E1A33',
      secondary: '#3A4A6B',
      accent: '#F5B301',
      accentStrong: '#E0A800',
      surface: '#FBF9F4',
      surfaceAlt: '#F5F1E8',
      surfaceAlt2: '#ECE5D6',
      border: '#E0D7C3',
      onSurface: '#16181D',
      onSurfaceMuted: '#565B66',
      onSurfaceSubtle: '#6B717C',
      onPrimary: '#FFFFFF',
      onAccent: '#0E1A33',
      onDark: '#FBF9F4',
      onDarkMuted: '#D8CFB8',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading:
        "'Bricolage Grotesque', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      scale: 1.22,
    },
    radius: '10px',
    radiusLg: '20px',
    motionIntensity: 'normal',
  },
  // 编辑印刷风：paper/bone/cream 中性 + ink 黑 + peach，Archivo 标题 + Inter 正文
  // 深色段落交替、巨型 display 标题、peach 斜体词、count-up、双行反向 marquee、纸张库 shine。
  'editorial-press': {
    colors: {
      primary: '#0E0E0E',
      primaryDark: '#000000',
      secondary: '#5C5C5C',
      accent: '#F5C98B',
      accentStrong: '#E5B570',
      surface: '#FFFFFF',
      surfaceAlt: '#F1ECE4',
      surfaceAlt2: '#E9E3D7',
      border: '#E3DDD0',
      onSurface: '#0E0E0E',
      onSurfaceMuted: '#5C5C5C',
      onSurfaceSubtle: '#8A8A8A',
      onPrimary: '#FFFFFF',
      onAccent: '#0E0E0E',
      onDark: '#FFFFFF',
      onDarkMuted: '#C9C2B5',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Archivo Variable', 'Archivo', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      scale: 1.2,
    },
    radius: '4px',
    radiusLg: '8px',
    motionIntensity: 'normal',
  },
  // 暖厨房风：陶土红 + 鼠尾草绿 + 蜂蜜金 + 暖奶油，Fraunces 衬线标题（italic light 强调词）
  // ken-burns hero、2 栏图文服务卡、菜品展示、深色证言卡。家厨/餐饮/私厨类出海站。
  'warm-kitchen': {
    colors: {
      primary: '#B04A2E',
      primaryDark: '#7C2E1A',
      secondary: '#D9A441',
      accent: '#5F7A48',
      accentStrong: '#4B6238',
      surface: '#FBF5EC',
      surfaceAlt: '#F4EBDB',
      surfaceAlt2: '#E9D9C0',
      border: '#E0CDB0',
      onSurface: '#2A221A',
      onSurfaceMuted: '#6A5A48',
      onSurfaceSubtle: '#8A7864',
      onPrimary: '#FFFFFF',
      onAccent: '#FFFFFF',
      onDark: '#FBF5EC',
      onDarkMuted: '#E0CDB0',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Fraunces', ui-serif, Georgia, serif",
      scale: 1.18,
    },
    radius: '12px',
    radiusLg: '28px',
    motionIntensity: 'normal',
  },
  // 农舍风：陶土红 + 暖棕 + 金黄 + 冷调深前景 + 暖奶油底，Urbanist 标题
  // 全屏视频/图 hero、价值条、产品聚光、交替故事章、收藏卡。手作家居/电商出海站。
  'farmhouse': {
    colors: {
      primary: '#C25533',
      primaryDark: '#8C3D24',
      secondary: '#C4923F',
      accent: '#9A8B6E',
      accentStrong: '#80715A',
      surface: '#FEFCF7',
      surfaceAlt: '#F4F1E8',
      surfaceAlt2: '#E6E1D4',
      border: '#D2CBB8',
      onSurface: '#243040',
      onSurfaceMuted: '#4F5A6C',
      onSurfaceSubtle: '#67707F',
      onPrimary: '#FFFFFF',
      onAccent: '#FFFFFF',
      onDark: '#FEFCF7',
      onDarkMuted: '#D2CBB8',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Urbanist', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      scale: 1.18,
    },
    radius: '8px',
    radiusLg: '12px',
    motionIntensity: 'normal',
  },
  // 派工/工业编辑风：ink/bone/paper 中性 + signal 安全橙，Inter Tight + Archivo(125%) + JetBrains Mono
  // 章节编号 01-09、mono 眉标、scramble 标题、时间线、覆盖地图 pin、grain。派工/维修/技师类出海站。
  'dispatch': {
    colors: {
      primary: '#0B0B0B',
      primaryDark: '#000000',
      secondary: '#1A1A1A',
      accent: '#FF5A1F',
      accentStrong: '#E04E15',
      surface: '#F4F1EA',
      surfaceAlt: '#EDE7D9',
      surfaceAlt2: '#E3DCC9',
      border: '#D9D2C2',
      onSurface: '#0B0B0B',
      onSurfaceMuted: '#6B6B66',
      onSurfaceSubtle: '#8A8A84',
      onPrimary: '#F4F1EA',
      onAccent: '#0B0B0B',
      onDark: '#F4F1EA',
      onDarkMuted: '#B8B2A4',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Archivo', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      scale: 1.16,
    },
    radius: '0px',
    radiusLg: '0px',
    motionIntensity: 'normal',
  },
  // 精密仪器风：深海军蓝 + 柔蓝 accent + Inter 巨型标题，章节编号、发丝线、fade-up
  // 高端产品/音频/硬件品牌展示。原站含 Three.js 滚动 3D，此处提炼设计语言为静态。
  'precision-instrument': {
    colors: {
      primary: '#7AA8EE',
      primaryDark: '#5A8AD9',
      secondary: '#5A8A78',
      accent: '#7AA8EE',
      accentStrong: '#5A8AD9',
      surface: '#141B2A',
      surfaceAlt: '#1B2435',
      surfaceAlt2: '#243049',
      border: '#2A3548',
      onSurface: '#FFFFFF',
      onSurfaceMuted: '#9AA0AC',
      onSurfaceSubtle: '#6E7480',
      onPrimary: '#0C1017',
      onAccent: '#0C1017',
      onDark: '#FFFFFF',
      onDarkMuted: '#9AA0AC',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      scale: 1.14,
    },
    radius: '2px',
    radiusLg: '4px',
    motionIntensity: 'normal',
  },
  // SaaS 奶油风：cream 暖白 + ink 深蓝黑 + blush/sky 粉蓝 pastel，Inter 粗体
  // rounded-2xl 卡片、eyebrow 圆点、hover 升起。SaaS/建站/工具类出海站。
  'saas-cream': {
    colors: {
      primary: '#0B0B2A',
      primaryDark: '#000000',
      secondary: '#B8D8F0',
      accent: '#F5B8C0',
      accentStrong: '#E89DA8',
      surface: '#FBFAF7',
      surfaceAlt: '#F5F2EB',
      surfaceAlt2: '#EDE8DC',
      border: '#E3DDCE',
      onSurface: '#0B0B2A',
      onSurfaceMuted: '#4A4A6A',
      onSurfaceSubtle: '#7A7A9A',
      onPrimary: '#FBFAF7',
      onAccent: '#0B0B2A',
      onDark: '#FBFAF7',
      onDarkMuted: '#B8B8D0',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      scale: 1.16,
    },
    radius: '16px',
    radiusLg: '24px',
    motionIntensity: 'normal',
  },
  // 工业动力风：白/neutral-900 + red-600 accent + Inter 粗体 + mono 章节标
  // 网格纹理、转角括号、章节编号。工业电池/硬件/B2B 出海站。
  'industrial-power': {
    colors: {
      primary: '#171717',
      primaryDark: '#000000',
      secondary: '#525252',
      accent: '#DC2626',
      accentStrong: '#B91C1C',
      surface: '#FFFFFF',
      surfaceAlt: '#FAFAFA',
      surfaceAlt2: '#F5F5F5',
      border: '#E5E5E5',
      onSurface: '#171717',
      onSurfaceMuted: '#404040',
      onSurfaceSubtle: '#737373',
      onPrimary: '#FFFFFF',
      onAccent: '#FFFFFF',
      onDark: '#FFFFFF',
      onDarkMuted: '#D4D4D4',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      scale: 1.14,
    },
    radius: '8px',
    radiusLg: '16px',
    motionIntensity: 'normal',
  },
  // 生物科技极简风：白 + neutral + Instrument Serif 衬线大标题 + Inter
  // 极简、留白、单色调。生物科技/科研/AI 平台出海站。
  'biotech-minimal': {
    colors: {
      primary: '#0A0A0A',
      primaryDark: '#000000',
      secondary: '#525252',
      accent: '#0A0A0A',
      accentStrong: '#000000',
      surface: '#FFFFFF',
      surfaceAlt: '#FAFAFA',
      surfaceAlt2: '#F5F5F5',
      border: '#E5E5E5',
      onSurface: '#0A0A0A',
      onSurfaceMuted: '#525252',
      onSurfaceSubtle: '#737373',
      onPrimary: '#FFFFFF',
      onAccent: '#FFFFFF',
      onDark: '#FFFFFF',
      onDarkMuted: '#D4D4D4',
    },
    typography: {
      fontBody: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      fontHeading: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
      scale: 1.16,
    },
    radius: '16px',
    radiusLg: '24px',
    motionIntensity: 'normal',
  },
};

/** preset + tokenOverrides（如 colors.primary）-> CSS 自定义属性表。 */
export function themeToCssVars(
  preset: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  if (!Object.prototype.hasOwnProperty.call(THEME_PRESETS, preset)) {
    throw new Error(
      `UNKNOWN_STYLE_PRESET: ${preset} -- 不在封闭 11 个 theme preset（SITE_SPEC_STYLE_PRESETS）`,
    );
  }
  const selected = preset as SiteSpecStylePreset;
  const tokens = THEME_PRESETS[selected];
  const c = tokens.colors;
  const vars: Record<string, string> = {
    '--c-primary': c.primary,
    '--c-primary-dark': c.primaryDark,
    '--c-secondary': c.secondary,
    '--c-accent': c.accent,
    '--c-accent-strong': c.accentStrong,
    '--c-surface': c.surface,
    '--c-surface-alt': c.surfaceAlt,
    '--c-surface-alt2': c.surfaceAlt2,
    '--c-border': c.border,
    '--c-on-surface': c.onSurface,
    '--c-on-surface-muted': c.onSurfaceMuted,
    '--c-on-surface-subtle': c.onSurfaceSubtle,
    '--c-on-primary': c.onPrimary,
    '--c-on-accent': c.onAccent,
    '--c-on-dark': c.onDark,
    '--c-on-dark-muted': c.onDarkMuted,
    '--font-body': tokens.typography.fontBody,
    '--font-heading': tokens.typography.fontHeading,
    '--font-sans': tokens.typography.fontBody,
    '--font-display': tokens.typography.fontHeading,
    '--font-mono':
      "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    '--radius': tokens.radius,
    '--radius-lg': tokens.radiusLg,
  };
  const map: Record<string, string> = {
    'colors.primary': '--c-primary',
    'colors.primaryDark': '--c-primary-dark',
    'colors.secondary': '--c-secondary',
    'colors.accent': '--c-accent',
    'colors.accentStrong': '--c-accent-strong',
    'colors.surface': '--c-surface',
  };
  // 颜色值严格校验（复审 LOW/M1 隐患）：token 将来用户可编辑，未校验的值会流入内联 style
  const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  for (const [key, value] of Object.entries(overrides)) {
    const cssVar = map[key];
    if (cssVar && COLOR_RE.test(value)) vars[cssVar] = value;
  }
  return vars;
}
