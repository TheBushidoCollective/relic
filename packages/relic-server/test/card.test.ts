import { describe, expect, test } from 'bun:test';
import { isRenderable, RENDERER_CLASSES } from '@relic/format';
import {
  CARD_DESCRIPTION,
  CLASS_PHRASES,
  CLASS_TITLES,
  cardCopy,
  DOWNLOAD_TAIL,
  FALLBACK_TITLE,
  RENDERABLE_TAIL,
} from '../src/card.ts';

describe('cardCopy', () => {
  test('undefined renderer class returns the unknown-relic pair', () => {
    const copy = cardCopy(undefined);
    expect(copy.title).toBe(FALLBACK_TITLE);
    expect(copy.description).toBe(CARD_DESCRIPTION);
  });

  for (const cls of RENDERER_CLASSES) {
    test(`class ${cls} returns its phrase, matching tail, and fallback title`, () => {
      const copy = cardCopy(cls);
      expect(copy.title).toBe(CLASS_TITLES[cls]);
      expect(copy.title.length).toBeGreaterThan(0);

      const phrase = CLASS_PHRASES[cls];
      expect(phrase.length).toBeGreaterThan(0);
      expect(copy.description.startsWith(phrase)).toBe(true);

      const expectedTail = isRenderable(cls) ? RENDERABLE_TAIL : DOWNLOAD_TAIL;
      expect(copy.description).toBe(`${phrase} ${expectedTail}`);
    });
  }

  test('renderable classes get the browser tail and download-only classes get the download tail', () => {
    for (const cls of RENDERER_CLASSES) {
      const copy = cardCopy(cls);
      if (isRenderable(cls)) {
        expect(copy.description).toContain(RENDERABLE_TAIL);
        expect(copy.description).not.toContain(DOWNLOAD_TAIL);
      } else {
        expect(copy.description).toContain(DOWNLOAD_TAIL);
        expect(copy.description).not.toContain(RENDERABLE_TAIL);
      }
    }
  });
});
