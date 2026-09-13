/**
 * Unfurl card copy for relics.
 *
 * What the card may and may not carry:
 * The card presents Open Graph and Twitter metadata to give recipients
 * enough context to decide whether to open an unfamiliar link. It reveals
 * a coarse renderer class and an optional publisher-declared title, but
 * never plaintext contents or private filenames.
 *
 * Why the renderer class is allowed where the filename is not:
 * The filename can leak sensitive details about content or context, which
 * format.md treats as a frame violation. By contrast, the renderer class
 * is one of eight coarse values already conceded to the operator on grant,
 * and knowing whether a link is a Markdown document, an HTML page, or an
 * archive is necessary information for the recipient before opening.
 */

import { isRenderable, type RendererClass } from '@relic/format';

export const CLASS_PHRASES: Record<RendererClass, string> = {
  markdown: 'A Markdown document.',
  code: 'A source code file.',
  html: 'An HTML page.',
  jsx: 'A JSX component.',
  image: 'An image.',
  media: 'An audio or video file.',
  archive: 'An archive.',
  binary: 'A binary file.',
};

export const CLASS_TITLES: Record<RendererClass, string> = {
  markdown: 'A Markdown relic',
  code: 'A code relic',
  html: 'An HTML relic',
  jsx: 'A JSX relic',
  image: 'An image relic',
  media: 'A media relic',
  archive: 'An archive relic',
  binary: 'A binary relic',
};

export const RENDERABLE_TAIL =
  'It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.';

export const DOWNLOAD_TAIL =
  'It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.';

export const FALLBACK_TITLE = 'A relic';

export const CARD_DESCRIPTION =
  'An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.';

export interface CardCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * Return the card title and description for a relic.
 *
 * When the renderer class is undefined (the relic is unknown, expired,
 * tombstoned, or failed to load), the copy falls back to the constant
 * encrypted-file card.
 */
export function cardCopy(rendererClass: RendererClass | undefined): CardCopy {
  if (rendererClass === undefined) {
    return {
      title: FALLBACK_TITLE,
      description: CARD_DESCRIPTION,
    };
  }

  const phrase = CLASS_PHRASES[rendererClass];
  const tail = isRenderable(rendererClass) ? RENDERABLE_TAIL : DOWNLOAD_TAIL;
  return {
    title: CLASS_TITLES[rendererClass],
    description: `${phrase} ${tail}`,
  };
}
