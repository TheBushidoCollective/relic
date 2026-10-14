import type {
  CoverRenderRequest,
  CoverRenderResult,
} from '@relic/format/cover';
import { renderKind } from './kinds.ts';

declare global {
  interface Window {
    __relicCover?: {
      readonly protocol: 1;
      readonly render: (
        request: CoverRenderRequest
      ) => Promise<CoverRenderResult>;
    };
  }
}

async function render(request: CoverRenderRequest): Promise<CoverRenderResult> {
  const root = document.getElementById('root');
  if (!root) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: 'Root element #root not found',
    };
  }

  try {
    const result = await renderKind(request, root);
    if (!result.ok) return result;

    await document.fonts.ready;

    const frame1 = Promise.withResolvers<void>();
    requestAnimationFrame(() => frame1.resolve());
    await frame1.promise;

    const frame2 = Promise.withResolvers<void>();
    requestAnimationFrame(() => frame2.resolve());
    await frame2.promise;

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

window.__relicCover = {
  protocol: 1,
  render,
};
