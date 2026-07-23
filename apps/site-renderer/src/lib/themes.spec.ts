import { describe, expect, it } from 'vitest';
import { SITE_SPEC_STYLE_PRESETS } from '@global/contracts';
import { themeToCssVars } from './themes';

describe('themeToCssVars', () => {
  it('11 个 preset 各返回非空 CSS vars 且 primary 有值', () => {
    expect(SITE_SPEC_STYLE_PRESETS).toHaveLength(11);
    for (const p of SITE_SPEC_STYLE_PRESETS) {
      const vars = themeToCssVars(p);
      expect(Object.keys(vars).length).toBeGreaterThan(0);
      expect(vars['--c-primary']).toBeTruthy();
      expect(vars['--c-accent']).toBeTruthy();
      expect(vars['--font-sans']).toBe(vars['--font-body']);
      expect(vars['--font-display']).toBe(vars['--font-heading']);
      expect(vars['--font-mono']).toContain('JetBrains Mono');
    }
  });

  it('未知 preset throw（fail-closed 负例）', () => {
    expect(() => themeToCssVars('unknown-preset')).toThrow(
      /UNKNOWN_STYLE_PRESET/,
    );
  });

  it('tokenOverrides 合法颜色覆盖生效', () => {
    const vars = themeToCssVars('modern-industrial', {
      'colors.primary': '#000000',
    });
    expect(vars['--c-primary']).toBe('#000000');
  });
});
