// Agglomerative clustering with complete linkage on cosine distance — the same clustering
// sherpa-onnx (and therefore the reference diarization pipeline) uses. The nearest-neighbour
// chain algorithm keeps it O(n²) so a few thousand speaker embeddings cluster quickly.

/** Pairwise cosine distances (1 − cos) as a full n × n matrix. */
function cosineDistances(embeddings: Float32Array[]): Float64Array {
  const n = embeddings.length;
  const normalized = embeddings.map((e) => {
    let norm = 0;
    for (const v of e) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return Float64Array.from(e, (v) => v / norm);
  });
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k]! * b[k]!;
      const dist = 1 - dot;
      d[i * n + j] = dist;
      d[j * n + i] = dist;
    }
  }
  return d;
}

interface Merge {
  a: number;
  b: number;
  height: number;
}

/** Complete-linkage merges via the nearest-neighbour chain (valid for reducible linkages). */
function completeLinkage(dist: Float64Array, n: number): Merge[] {
  const active = new Uint8Array(n).fill(1);
  const merges: Merge[] = [];
  const chain: number[] = [];
  let remaining = n;
  while (remaining > 1) {
    if (chain.length === 0) {
      let start = 0;
      while (!active[start]) start++;
      chain.push(start);
    }
    for (;;) {
      const top = chain[chain.length - 1]!;
      const prev = chain.length > 1 ? chain[chain.length - 2]! : -1;
      let best = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let j = 0; j < n; j++) {
        if (!active[j] || j === top) continue;
        const dj = dist[top * n + j]!;
        // Prefer the previous chain element on ties so the chain terminates (distances can all be
        // infinite under cannot-link constraints, so the first candidate is always taken).
        if (best === -1 || dj < bestDist || (dj === bestDist && j === prev)) {
          best = j;
          bestDist = dj;
        }
      }
      if (best === prev) break;
      chain.push(best);
    }
    const b = chain.pop()!;
    const a = chain.pop()!;
    const height = dist[a * n + b]!;
    merges.push({ a, b, height });
    // The merged cluster takes slot `a`; Lance–Williams update for complete linkage.
    active[b] = 0;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      const v = Math.max(dist[a * n + k]!, dist[b * n + k]!);
      dist[a * n + k] = v;
      dist[k * n + a] = v;
    }
    remaining--;
  }
  return merges;
}

/**
 * Cluster labels (0-based, numbered by first appearance) for `embeddings`.
 * With `numClusters` > 0 the tree is cut into that many clusters; otherwise clusters are
 * merged while their complete-linkage cosine distance is at most `threshold`.
 */
export function clusterEmbeddings(
  embeddings: Float32Array[],
  opts: {
    numClusters?: number | null;
    threshold?: number;
    /**
     * Optional group per embedding (e.g. its analysis window): embeddings of one group are known
     * to be different speakers, so their clusters are never merged by threshold. Complete linkage
     * carries the constraint along, since a cluster's distance is that of its farthest pair.
     */
    cannotLink?: readonly number[];
  } = {},
): number[] {
  const n = embeddings.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const dist = cosineDistances(embeddings);
  const groups = opts.cannotLink;
  if (groups) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (groups[i] === groups[j]) {
          dist[i * n + j] = Number.POSITIVE_INFINITY;
          dist[j * n + i] = Number.POSITIVE_INFINITY;
        }
      }
    }
  }
  const merges = completeLinkage(dist, n).sort((x, y) => x.height - y.height);

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const k = opts.numClusters != null && opts.numClusters > 0 ? Math.min(opts.numClusters, n) : null;
  const threshold = opts.threshold ?? 0.5;
  let clusters = n;
  for (const m of merges) {
    if (k != null ? clusters <= k : m.height > threshold) break;
    const ra = find(m.a);
    const rb = find(m.b);
    if (ra !== rb) {
      parent[rb] = ra;
      clusters--;
    }
  }
  const ids = new Map<number, number>();
  return Array.from({ length: n }, (_, i) => {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    return ids.get(root)!;
  });
}
