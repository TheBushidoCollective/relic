import { homeRelicRows } from './relic-rows.ts';
import { type KeyVault, localStorageKeyVault } from './vault.ts';

/**
 * Renders the list of relics stored in this browser's local key vault into the
 * `#home-relics` section of the landing page.
 *
 * If the section is absent or the vault contains zero relics, leaves the section
 * hidden and empty.
 */
export function renderHomeRelics(root: Document, vault: KeyVault): void {
  const section = root.getElementById('home-relics');
  if (!section) return;
  const rows = homeRelicRows(vault);
  if (rows.length === 0) return;
  const h2 = root.createElement('h2');
  h2.id = 'home-relics-title';
  h2.textContent = 'Your relics';

  const note = root.createElement('p');
  note.className = 'home-relics-note';
  note.textContent =
    'Relics this browser has opened. The list is read here and sent nowhere.';

  const ul = root.createElement('ul');
  ul.className = 'home-relic-list';

  for (const row of rows) {
    const li = root.createElement('li');
    li.className = 'home-relic';

    const span = root.createElement('span');
    span.className = 'home-relic-kind';
    span.textContent = row.previewLabel;

    const a = root.createElement('a');
    a.className = 'home-relic-link';
    a.href = `/${encodeURIComponent(row.relicId)}#${row.fragment ?? ''}`;
    a.textContent = row.title;

    li.append(span, a);
    ul.appendChild(li);
  }

  const more = root.createElement('p');
  more.className = 'home-relics-more';

  const moreLink = root.createElement('a');
  moreLink.href = '/dashboard';
  moreLink.textContent =
    'Back up keys, forget a relic, or find relics you commented on';
  more.appendChild(moreLink);

  section.replaceChildren(h2, note, ul, more);
  section.removeAttribute('hidden');
}

// A module script runs once the document is parsed, so the mount is already
// there. Guarded on the method rather than on `document` alone, because the
// viewer tests install a partial `document` stub that this import would
// otherwise run against.
if (
  typeof document !== 'undefined' &&
  typeof document.getElementById === 'function'
) {
  renderHomeRelics(document, localStorageKeyVault());
}
