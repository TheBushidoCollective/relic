import { describe, expect, test } from 'bun:test';
import { CLASS_BEHAVIOUR, RENDERER_CLASSES } from '@relic/format';
import {
  BEHAVIOUR_TAILS,
  CARD_DESCRIPTION,
  CLASS_PHRASES,
  CLASS_TITLES,
  cardCopy,
  FALLBACK_TITLE,
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

      const expectedTail = BEHAVIOUR_TAILS[CLASS_BEHAVIOUR[cls]];
      expect(copy.description).toBe(`${phrase} ${expectedTail}`);
    });
  }

  test('each renderer class gets the tail matching its class behaviour and none of the other tails', () => {
    for (const cls of RENDERER_CLASSES) {
      const copy = cardCopy(cls);
      const behaviour = CLASS_BEHAVIOUR[cls];
      const expectedTail = BEHAVIOUR_TAILS[behaviour];

      expect(copy.description).toContain(expectedTail);
      for (const [otherBehaviour, otherTail] of Object.entries(
        BEHAVIOUR_TAILS
      )) {
        if (otherBehaviour !== behaviour) {
          expect(copy.description).not.toContain(otherTail);
        }
      }
    }
  });

  test('media relic description plays in browser and does not download to device', () => {
    const copy = cardCopy('media');
    expect(copy.description).toContain('It plays in your browser');
    expect(copy.description).not.toContain('downloads to your device');
  });

  test('pdf relic description opens in browser and does not download to device', () => {
    const copy = cardCopy('pdf');
    expect(copy.title).toBe('A PDF relic');
    expect(copy.description).toContain('It opens in your browser');
    expect(copy.description).not.toContain('downloads to your device');
  });
});
