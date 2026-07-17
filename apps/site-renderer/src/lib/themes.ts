import type { SiteSpecStylePreset } from '@global/contracts';

/**
 * 风格预设 = token 包（04 §6）。M0 两个行业预设；字体用系统栈，
 * 自托管字体对（GDPR 判例，02 §8）随 M1 落。切 preset=秒级重渲染。
 */

export interface ThemeTokens {
  colors: {
    primary: string;
    secondary: string;
    surface: string;
    surfaceAlt: string;
    onSurface: string;
    onSurfaceMuted: string;
    onPrimary: string;
  };
  typography: { fontBody: string; fontHeading: string; scale: number };
  radius: string;
  motionIntensity: 'none' | 'subtle' | 'normal';
}

const SANS =
  "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const THEME_PRESETS: Record<SiteSpecStylePreset, ThemeTokens> = {
  // 深钢蓝 + 高对比：机械/泵阀/金属加工类制造业
  'modern-industrial': {
    colors: {
      primary: '#0E5FA8',
      secondary: '#123B5E',
      surface: '#FFFFFF',
      surfaceAlt: '#F2F5F8',
      onSurface: '#16212C',
      onSurfaceMuted: '#51606F',
      onPrimary: '#FFFFFF',
    },
    typography: { fontBody: SANS, fontHeading: SANS, scale: 1.25 },
    radius: '6px',
    motionIntensity: 'subtle',
  },
  // 浅底暖橙点缀：精密仪器/电子/医疗器械类
  'precision-light': {
    colors: {
      primary: '#D9662B',
      secondary: '#2A2E33',
      surface: '#FCFBF9',
      surfaceAlt: '#F1EEE9',
      onSurface: '#20242A',
      onSurfaceMuted: '#5D6570',
      onPrimary: '#FFFFFF',
    },
    typography: { fontBody: SANS, fontHeading: SANS, scale: 1.2 },
    radius: '10px',
    motionIntensity: 'subtle',
  },
};

/** preset + tokenOverrides（如 colors.primary）→ CSS 自定义属性表。 */
export function themeToCssVars(
  preset: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const selected = Object.prototype.hasOwnProperty.call(THEME_PRESETS, preset)
    ? (preset as SiteSpecStylePreset)
    : 'modern-industrial';
  const tokens = THEME_PRESETS[selected];
  const vars: Record<string, string> = {
    '--c-primary': tokens.colors.primary,
    '--c-secondary': tokens.colors.secondary,
    '--c-surface': tokens.colors.surface,
    '--c-surface-alt': tokens.colors.surfaceAlt,
    '--c-on-surface': tokens.colors.onSurface,
    '--c-on-surface-muted': tokens.colors.onSurfaceMuted,
    '--c-on-primary': tokens.colors.onPrimary,
    '--font-body': tokens.typography.fontBody,
    '--font-heading': tokens.typography.fontHeading,
    '--radius': tokens.radius,
  };
  const map: Record<string, string> = {
    'colors.primary': '--c-primary',
    'colors.secondary': '--c-secondary',
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
