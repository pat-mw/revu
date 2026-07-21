/**
 * Arrange open pull requests by what they are stacked on.
 *
 * A flat list hides the shape of concurrent work. Two pull requests both
 * "open against something" look identical in a list even when one targets the
 * default branch and the other sits three deep on a release train — and the
 * only way to tell today is to hover each row and read its base. That is the
 * question this answers at a glance.
 *
 * The graph is already in the data: a pull request whose BASE ref equals
 * another's HEAD ref is stacked on it. Anything else is stacked on a plain
 * branch, and those branches are the roots — typically the default branch plus
 * whatever release branches are in flight.
 *
 * Nothing here fetches: it is a rearrangement of the list the inbox already has.
 */
import type { PullListItem } from '@revu/shared'

export interface PullTreeNode {
  item: PullListItem
  /** Pull requests whose base is this one's head branch. */
  children: PullTreeNode[]
  /** How deep this sits in its stack; a pull request on a plain branch is 0. */
  depth: number
}

export interface PullTreeRoot {
  /** The branch everything beneath it targets, e.g. `main`. */
  branch: string
  children: PullTreeNode[]
  /** Every pull request under this root, at any depth. */
  total: number
}

/**
 * Group pull requests into one tree per base branch.
 *
 * Roots come out ordered by size — the branch carrying the most work first,
 * which is nearly always the default branch — then alphabetically so the order
 * is stable across polls rather than reshuffling under the reader. Siblings are
 * ordered by pull number, oldest first, so a stack reads bottom-up in the order
 * it was built.
 */
export function buildPullTree(items: readonly PullListItem[]): PullTreeRoot[] {
  const open = items.filter((it) => it.pull.state === 'open')

  // head branch -> the pull request that produced it. A branch with two open
  // pull requests is not something to reconcile here: the first by number wins
  // and the other is treated as targeting a plain branch, which keeps it
  // visible rather than silently dropping it from the tree.
  const byHead = new Map<string, PullListItem>()
  for (const it of [...open].sort((a, b) => a.pull.number - b.pull.number)) {
    const head = it.pull.head.ref
    if (!byHead.has(head)) byHead.set(head, it)
  }

  const nodes = new Map<number, PullTreeNode>()
  for (const it of open) nodes.set(it.pull.number, { item: it, children: [], depth: 0 })

  const roots = new Map<string, PullTreeNode[]>()

  for (const it of open) {
    const node = nodes.get(it.pull.number)
    if (node === undefined) continue
    const parentItem = byHead.get(it.pull.base.ref)
    // `parentItem !== it` guards a pull request whose base and head are the same
    // branch, which GitHub will not create but a malformed payload could carry:
    // left unchecked it would become its own parent and vanish from every root.
    if (parentItem !== undefined && parentItem.pull.number !== it.pull.number) {
      const parent = nodes.get(parentItem.pull.number)
      if (parent !== undefined) {
        parent.children.push(node)
        continue
      }
    }
    const group = roots.get(it.pull.base.ref)
    if (group) group.push(node)
    else roots.set(it.pull.base.ref, [node])
  }

  // A cycle cannot come from GitHub, but a stale or hand-edited payload could
  // describe one, and it would otherwise recurse forever while rendering. Any
  // node not reachable from a root is re-attached to its own base branch.
  const reachable = new Set<number>()
  const assignDepth = (node: PullTreeNode, depth: number): void => {
    if (reachable.has(node.item.pull.number)) return
    reachable.add(node.item.pull.number)
    node.depth = depth
    node.children.sort((a, b) => a.item.pull.number - b.item.pull.number)
    for (const child of node.children) assignDepth(child, depth + 1)
  }
  for (const group of roots.values()) for (const node of group) assignDepth(node, 0)
  for (const node of nodes.values()) {
    if (reachable.has(node.item.pull.number)) continue
    node.children = []
    node.depth = 0
    reachable.add(node.item.pull.number)
    const branch = node.item.pull.base.ref
    const group = roots.get(branch)
    if (group) group.push(node)
    else roots.set(branch, [node])
  }

  const count = (node: PullTreeNode): number =>
    1 + node.children.reduce((n, c) => n + count(c), 0)

  return [...roots.entries()]
    .map(([branch, children]) => ({
      branch,
      children: [...children].sort((a, b) => a.item.pull.number - b.item.pull.number),
      total: children.reduce((n, c) => n + count(c), 0),
    }))
    .sort((a, b) => b.total - a.total || a.branch.localeCompare(b.branch))
}

/** Flatten a tree to rows in display order, so one keyboard column still works. */
export function flattenPullTree(roots: readonly PullTreeRoot[]): PullTreeNode[] {
  const out: PullTreeNode[] = []
  const walk = (node: PullTreeNode): void => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  for (const root of roots) for (const child of root.children) walk(child)
  return out
}
