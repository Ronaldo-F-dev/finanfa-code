// Hand-rolled personalized PageRank over a weighted directed graph — the
// same ranking algorithm aider's repomap.py uses (via networkx) to decide
// which files/symbols are most important to show for a given conversation,
// applied here to a graph where nodes are source files and an edge A->B
// weighted by N means "file A's source mentions N distinct symbol names
// that are defined in file B" (see build.ts). Implemented directly rather
// than pulling in a graph library — the algorithm itself is short, and a
// personalization vector (see `personalization` below, aider's own
// "chat files get boosted" feature) is easy to bolt on to a hand-rolled
// version.
export interface WeightedEdge {
  from: string;
  to: string;
  weight: number;
}

const DAMPING = 0.85;
const MAX_ITERATIONS = 100;
const CONVERGENCE_THRESHOLD = 1e-6;

/**
 * @param nodes every node that must appear in the result, even with no edges (a real "no incoming/outgoing references" file still needs a rank).
 * @param personalization optional bias: nodes present here get their teleport probability weighted by this map (normalized internally) instead of split uniformly — this is how aider's "the files already open in chat get boosted" behaves; omit for plain PageRank.
 */
export function personalizedPageRank(nodes: string[], edges: WeightedEdge[], personalization?: Map<string, number>): Map<string, number> {
  const n = nodes.length;
  if (n === 0) return new Map();

  const outWeightSum = new Map<string, number>();
  const incoming = new Map<string, { from: string; weight: number }[]>();
  for (const node of nodes) incoming.set(node, []);

  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to) || edge.from === edge.to) continue;
    outWeightSum.set(edge.from, (outWeightSum.get(edge.from) ?? 0) + edge.weight);
    incoming.get(edge.to)!.push({ from: edge.from, weight: edge.weight });
  }

  const teleport = new Map<string, number>();
  if (personalization && personalization.size > 0) {
    const total = [...personalization.values()].reduce((a, b) => a + b, 0) || 1;
    for (const node of nodes) teleport.set(node, (personalization.get(node) ?? 0) / total);
  } else {
    for (const node of nodes) teleport.set(node, 1 / n);
  }

  let rank = new Map(nodes.map((node) => [node, 1 / n]));

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Dangling nodes (no outgoing weight) redistribute their rank per the teleport distribution, same as networkx's default.
    let danglingMass = 0;
    for (const node of nodes) {
      if (!outWeightSum.get(node)) danglingMass += rank.get(node)!;
    }

    const next = new Map<string, number>();
    let delta = 0;
    for (const node of nodes) {
      let incomingSum = 0;
      for (const { from, weight } of incoming.get(node)!) {
        const fromOut = outWeightSum.get(from);
        if (fromOut) incomingSum += (rank.get(from)! * weight) / fromOut;
      }
      const value = (1 - DAMPING) * teleport.get(node)! + DAMPING * (incomingSum + danglingMass * teleport.get(node)!);
      next.set(node, value);
      delta += Math.abs(value - rank.get(node)!);
    }
    rank = next;
    if (delta < CONVERGENCE_THRESHOLD) break;
  }

  return rank;
}
