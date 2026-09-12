/**
 * The relic's plaintext title (`spec/viewer.md` 6.2).
 *
 * Every other field this package defines lives inside the ciphertext. This
 * one does not. The title is the one thing about a relic that the service
 * stores in the clear, so that a pasted link previews as something legible
 * rather than as a blank card on an unfamiliar domain, which is the visual
 * shape of a phishing link. The cost is stated where it is paid: the title is
 * readable by the operator, by every chat client that generates a preview,
 * and by anyone who fetches the URL without holding the key.
 *
 * It lives in this package rather than at either end because both ends have
 * to agree on it and neither owns it. The client normalizes what a publisher
 * hands it; the server refuses anything outside the bounds below. A server
 * that silently normalized instead of refusing would store something other
 * than what the publisher was told had gone public, and that is the one
 * property this field cannot lose.
 */

/**
 * The ceiling, in code points.
 *
 * 128 is the cap the grant already applies to the publishing client name
 * (`spec/publish.md` 3.2), so the wire carries one bound rather than two.
 * A title is display text on a preview card and every unfurler truncates
 * well before this, so the cap is a storage bound, not a design width.
 */
export const MAX_TITLE_CHARS = 128;

/**
 * Whether one code point is barred from a title.
 *
 * C0 and C1 controls, because a newline in a `<title>` or an `og:title` is
 * not display text and a NUL is not text at all. The bidi marks, overrides,
 * and isolates, because the card is a trust surface a recipient reads before
 * they click: a right-to-left override reorders what they see without
 * changing what was published, which is the one thing a title must not do.
 *
 * Written as an arithmetic test rather than a character class, because a
 * regex holding these literals is indistinguishable from one that holds them
 * by accident, which is what the lint rule against them is for.
 */
function isForbidden(code: number): boolean {
  if (code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  // LRM and RLM.
  if (code === 0x200e || code === 0x200f) return true;
  // The embedding, override, and pop-directional-formatting controls.
  if (code >= 0x202a && code <= 0x202e) return true;
  // The directional isolates.
  return code >= 0x2066 && code <= 0x2069;
}

/**
 * What a client sends, from whatever a publisher or a filename gave it.
 *
 * Whitespace runs collapse to one space before the forbidden class is
 * stripped, so a newline separates words instead of joining them. Truncation
 * counts code points rather than UTF-16 units, so the cap cannot cut a
 * surrogate pair in half; it can still cut a multi-code-point grapheme, and
 * a truncated flag is a cosmetic loss on a card rather than a correctness
 * one, so no segmenter is carried for it.
 *
 * The result is reported back to the publisher, because a client that
 * rewrites a title without saying so has published a name nobody chose.
 */
export function normalizeTitle(raw: string): string {
  const collapsed = [...raw.replace(/\s+/gu, ' ')]
    .filter((ch) => !isForbidden(ch.codePointAt(0) as number))
    .join('')
    .trim();
  return [...collapsed].slice(0, MAX_TITLE_CHARS).join('');
}

/**
 * Whether the server may store this value as a title.
 *
 * Deliberately not "equals its own normalization": whitespace cosmetics are
 * not worth refusing a publish over, and a third-party client with a double
 * space in a filename is not an attack. What is refused is what cannot be
 * displayed safely or stored honestly: the forbidden class, the cap, and
 * untrimmed or empty text.
 */
export function isStorableTitle(value: string): boolean {
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  if ([...value].length > MAX_TITLE_CHARS) return false;
  return ![...value].some((ch) => isForbidden(ch.codePointAt(0) as number));
}
