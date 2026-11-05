import { describe, expect, it } from 'vitest';

import { crawl4aiRenderTool } from './source-tools';
import { TRANSIENT_RESULT_SCOPES } from './transient-result-scope';

describe('transient result scope declarations (design 2026-11-06 §7)', () => {
  it('keeps crawl4ai.render declared for exactly the closed platform scope', () => {
    // The declaration is what admits platform channel-crawl fetches: deleting or
    // renaming it (an optional property, so typecheck cannot catch it) would
    // silently bring back the subject-binding hold that blocked every channel
    // crawl page before this design (defect A).
    expect(crawl4aiRenderTool.transientResultScopes).toEqual(['platform_channel_crawl']);
    for (const scope of crawl4aiRenderTool.transientResultScopes ?? []) {
      expect(TRANSIENT_RESULT_SCOPES).toContain(scope);
    }
  });
});
