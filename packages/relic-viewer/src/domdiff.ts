import { diffArrays } from 'diff';
import {
  labelForTag,
  type Mark,
  type MarkKind,
  type NodePath,
  type TreeNode,
} from './rendered-tree.ts';

/**
 * Comparing two rendered documents.
 *
 * This runs on the service origin only, over trees each render frame reported
 * about itself, and it never sees markup. What it produces is two sets of
 * marks, one addressed at each side, plus a list of changes in the terms a
 * reader would use rather than the terms the source used.
 *
 * It is deliberately separate from `rendered-tree.ts`: that module ships into
 * the frame's inlined bundle, this one must not, and keeping the dependency on
 * the diff library here is what makes that true by construction.
 */

export interface RenderedChange {
  readonly kind: MarkKind;
  /** What a reader would call it: 'heading', 'paragraph', 'image'. */
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface TreeDiff {
  readonly changed: boolean;
  /** Element paths into the historical tree. */
  readonly removedMarks: readonly Mark[];
  /** Element paths into the current tree. */
  readonly addedMarks: readonly Mark[];
  readonly additions: number;
  readonly removals: number;
  readonly changes: readonly RenderedChange[];
  readonly summary: string;
}

/**
 * How many changes are listed.
 *
 * A rewritten document changes every node, and a list of every one of them is
 * a wall rather than a summary. The count in the heading stays exact; the list
 * stops.
 */
export const MAX_LISTED_CHANGES = 40;

/** How much of a changed string is quoted before it is cut. */
const MAX_QUOTED = 160;

function quote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_QUOTED
    ? `${trimmed.slice(0, MAX_QUOTED)}\u2026`
    : trimmed;
}

function serialiseAttrs(node: TreeNode): string {
  return node.attrs.map(([name, value]) => `${name}=${value}`).join(' ');
}

/**
 * What makes two children the same child.
 *
 * Content, not shape. A key of tag and attributes alone would match any two
 * paragraphs at the same index, so inserting one near the top would report
 * every paragraph after it as changed. Including what the node renders means
 * the matcher finds the paragraphs that genuinely did not move, and the
 * leftovers are handled by pairing below.
 */
function contentKey(node: TreeNode): string {
  return node.tag === '#text'
    ? `#text:${node.text}`
    : `${node.tag}[${serialiseAttrs(node)}]${textOf(node).slice(0, 200)}`;
}

/** Elements accept an attribute; text nodes do not, so marks stop at one. */
function nearestElement(node: TreeNode, path: NodePath): NodePath {
  return node.tag === '#text' ? path.slice(0, -1) : path;
}

interface Collector {
  readonly removed: Mark[];
  readonly added: Mark[];
  readonly changes: RenderedChange[];
  additions: number;
  removals: number;
  /** Counted separately from `changes`, which stops at the list cap. */
  changedCount: number;
  /** Sequence shared by the two mark arrays, unique inside one diff. */
  nextSyncId: number;
}

function mark(
  into: Mark[],
  path: NodePath,
  kind: MarkKind,
  syncId?: string
): void {
  const key = path.join('.');
  // One element, one mark. A changed heading whose text also moved would
  // otherwise be marked twice and outlined twice. If that earlier mark had no
  // counterpart and this pass finds one, enrich rather than duplicate it.
  const at = into.findIndex((existing) => existing.path.join('.') === key);
  if (at !== -1) {
    const existing = into[at];
    if (
      existing !== undefined &&
      existing.syncId === undefined &&
      syncId !== undefined
    ) {
      into[at] = { ...existing, syncId };
    }
    return;
  }
  into.push({ path, kind, ...(syncId === undefined ? {} : { syncId }) });
}

/** Give the two nodes one identity only when the diff actually paired them. */
function markPair(
  into: Collector,
  beforePath: NodePath,
  afterPath: NodePath,
  beforeKind: MarkKind = 'changed',
  afterKind: MarkKind = 'changed'
): void {
  const syncId = `d${into.nextSyncId}`;
  into.nextSyncId += 1;
  mark(into.removed, beforePath, beforeKind, syncId);
  mark(into.added, afterPath, afterKind, syncId);
}

function countNodes(node: TreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function collectRemoved(
  node: TreeNode,
  path: NodePath,
  into: Collector,
  syncId?: string
): void {
  mark(into.removed, nearestElement(node, path), 'removed', syncId);
  into.removals += countNodes(node);
}

function collectAdded(
  node: TreeNode,
  path: NodePath,
  into: Collector,
  syncId?: string
): void {
  mark(into.added, nearestElement(node, path), 'added', syncId);
  into.additions += countNodes(node);
}

function compare(
  before: TreeNode,
  after: TreeNode,
  beforePath: NodePath,
  afterPath: NodePath,
  parentTag: string,
  into: Collector
): void {
  if (before.tag === '#text' && after.tag === '#text') {
    if (before.text === after.text) return;
    markPair(into, beforePath.slice(0, -1), afterPath.slice(0, -1));
    into.changedCount += 1;
    if (into.changes.length < MAX_LISTED_CHANGES) {
      into.changes.push({
        kind: 'changed',
        label: labelForTag(parentTag),
        before: quote(before.text),
        after: quote(after.text),
      });
    }
    return;
  }

  if (before.tag !== after.tag) {
    const syncId = `d${into.nextSyncId}`;
    into.nextSyncId += 1;
    collectRemoved(before, beforePath, into, syncId);
    collectAdded(after, afterPath, into, syncId);
    return;
  }

  const beforeAttrs = serialiseAttrs(before);
  const afterAttrs = serialiseAttrs(after);
  if (beforeAttrs !== afterAttrs) {
    markPair(into, beforePath, afterPath);
    into.changedCount += 1;
    if (into.changes.length < MAX_LISTED_CHANGES) {
      into.changes.push({
        kind: 'changed',
        label: labelForTag(before.tag),
        before: quote(beforeAttrs),
        after: quote(afterAttrs),
      });
    }
  }

  const changes = diffArrays(
    before.children.map(contentKey),
    after.children.map(contentKey)
  );
  let beforeIndex = 0;
  let afterIndex = 0;

  for (let at = 0; at < changes.length; at++) {
    const change = changes[at];
    if (change === undefined) continue;
    const count = change.count ?? change.value.length;

    if (change.added !== true && change.removed !== true) {
      for (let step = 0; step < count; step++) {
        const beforeChild = before.children[beforeIndex + step];
        const afterChild = after.children[afterIndex + step];
        if (beforeChild !== undefined && afterChild !== undefined) {
          compare(
            beforeChild,
            afterChild,
            [...beforePath, beforeIndex + step],
            [...afterPath, afterIndex + step],
            before.tag,
            into
          );
        }
      }
      beforeIndex += count;
      afterIndex += count;
      continue;
    }

    // A removed run immediately followed by an added run is a modification,
    // not a deletion and an insertion. Without this pairing, editing a word
    // in a heading would report the whole heading gone and a new one arrived,
    // and a page whose every paragraph was edited would report nothing
    // changed and everything replaced.
    const next = changes[at + 1];
    if (
      change.removed === true &&
      next?.added === true &&
      change.value.length > 0
    ) {
      const nextCount = next.count ?? next.value.length;
      const paired = Math.min(count, nextCount);
      for (let step = 0; step < paired; step++) {
        const beforeChild = before.children[beforeIndex + step];
        const afterChild = after.children[afterIndex + step];
        if (beforeChild === undefined || afterChild === undefined) continue;
        compare(
          beforeChild,
          afterChild,
          [...beforePath, beforeIndex + step],
          [...afterPath, afterIndex + step],
          before.tag,
          into
        );
      }
      for (let step = paired; step < count; step++) {
        removeChild(before, beforePath, beforeIndex + step, into);
      }
      for (let step = paired; step < nextCount; step++) {
        addChild(after, afterPath, afterIndex + step, into);
      }
      beforeIndex += count;
      afterIndex += nextCount;
      at += 1;
      continue;
    }

    if (change.removed === true) {
      for (let step = 0; step < count; step++) {
        removeChild(before, beforePath, beforeIndex + step, into);
      }
      beforeIndex += count;
      continue;
    }

    for (let step = 0; step < count; step++) {
      addChild(after, afterPath, afterIndex + step, into);
    }
    afterIndex += count;
  }
}

function removeChild(
  parent: TreeNode,
  path: NodePath,
  index: number,
  into: Collector
): void {
  const child = parent.children[index];
  if (child === undefined) return;
  collectRemoved(child, [...path, index], into);
  if (into.changes.length < MAX_LISTED_CHANGES) {
    into.changes.push({
      kind: 'removed',
      label: labelForTag(child.tag),
      before: quote(textOf(child)),
      after: '',
    });
  }
}

function addChild(
  parent: TreeNode,
  path: NodePath,
  index: number,
  into: Collector
): void {
  const child = parent.children[index];
  if (child === undefined) return;
  collectAdded(child, [...path, index], into);
  if (into.changes.length < MAX_LISTED_CHANGES) {
    into.changes.push({
      kind: 'added',
      label: labelForTag(child.tag),
      before: '',
      after: quote(textOf(child)),
    });
  }
}

/** Everything a node renders as text, for naming it in the change list. */
function textOf(node: TreeNode): string {
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join(' ');
}

function plural(count: number, word: string): string {
  return `${count} ${word}`;
}

export function diffTrees(before: TreeNode, after: TreeNode): TreeDiff {
  const into: Collector = {
    removed: [],
    added: [],
    changes: [],
    additions: 0,
    removals: 0,
    changedCount: 0,
    nextSyncId: 0,
  };
  compare(before, after, [], [], '#root', into);

  const changed =
    into.additions > 0 || into.removals > 0 || into.changedCount > 0;

  if (!changed) {
    return {
      changed: false,
      removedMarks: [],
      addedMarks: [],
      additions: 0,
      removals: 0,
      changes: [],
      // Deliberately not the byte-identical wording `diff.ts` uses. Two
      // different sources can render the same page, and calling their content
      // identical would be a lie about bytes nobody compared.
      summary: 'No changes. These versions render identically.',
    };
  }

  // Added, removed, changed, in that order, because that is how the spec
  // states the copy and how a reader scans it.
  const terms: string[] = [];
  if (into.additions > 0) terms.push(plural(into.additions, 'added'));
  if (into.removals > 0) terms.push(plural(into.removals, 'removed'));
  if (into.changedCount > 0) terms.push(plural(into.changedCount, 'changed'));

  return {
    changed: true,
    removedMarks: into.removed,
    addedMarks: into.added,
    additions: into.additions,
    removals: into.removals,
    changes: into.changes,
    summary: `${terms.join(', ')}.`,
  };
}
