// Agglomerative clustering of speaker embeddings. The nearest-neighbour chain algorithm keeps it
// O(n²), so a few thousand embeddings cluster quickly. Two linkages:
//   - "complete" on cosine distance (as sherpa-onnx does): two clusters merge only if their
//     farthest pair is within the threshold. Used for short recordings, where it can also keep
//     the speakers of one analysis window apart (cannot-link).
//   - "ward" on unit-length embeddings: the merge height grows with the clusters' sizes, so the
//     threshold behaves like a significance test. Two halves of one voice stay close however much
//     audio there is, while two different voices separate more clearly the more each speaks.
//     Single embeddings of one voice vary a lot on real recordings (more than between some
//     voices), which made complete linkage split one person into several speakers.

export type Linkage = 'complete' | 'ward';

function unit(e: Float32Array): Float64Array {
  let norm = 0;
  for (const v of e) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Float64Array.from(e, (v) => v / norm);
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k]! * b[k]!;
  return s;
}

/**
 * Pairwise dissimilarities as a full n × n matrix: cosine distance (1 − cos) for complete linkage,
 * squared Euclidean distance between unit vectors (2 − 2 cos) for Ward.
 */
function dissimilarities(normalized: Float64Array[], linkage: Linkage): Float64Array {
  const n = normalized.length;
  const scale = linkage === 'ward' ? 2 : 1;
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = Math.max(0, scale * (1 - dot(normalized[i]!, normalized[j]!)));
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

/** Merges via the nearest-neighbour chain (valid for reducible linkages such as these two). */
function nnChain(dist: Float64Array, n: number, linkage: Linkage): Merge[] {
  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
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
    const dab = dist[a * n + b]!;
    // Ward works on squared distances; its merge height is their square root.
    merges.push({ a, b, height: linkage === 'ward' ? Math.sqrt(dab) : dab });
    // The merged cluster takes slot `a`; Lance–Williams update.
    active[b] = 0;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      const dak = dist[a * n + k]!;
      const dbk = dist[b * n + k]!;
      const v =
        linkage === 'complete'
          ? Math.max(dak, dbk)
          : ((size[a]! + size[k]!) * dak + (size[b]! + size[k]!) * dbk - size[k]! * dab) /
            (size[a]! + size[b]! + size[k]!);
      dist[a * n + k] = v;
      dist[k * n + a] = v;
    }
    size[a]! += size[b]!;
    remaining--;
  }
  return merges;
}

/** Labels numbered 0.. by first appearance. */
function renumber(labels: readonly number[]): number[] {
  const ids = new Map<number, number>();
  return labels.map((l) => {
    if (!ids.has(l)) ids.set(l, ids.size);
    return ids.get(l)!;
  });
}

/**
 * Cluster labels (0-based, numbered by first appearance) for `embeddings`.
 * With `numClusters` > 0 the tree is cut into that many clusters; otherwise clusters are
 * merged while their linkage distance is at most `threshold`.
 */
export function clusterEmbeddings(
  embeddings: Float32Array[],
  opts: {
    numClusters?: number | null;
    threshold?: number;
    /** Default "complete" (cosine distance, threshold 0.5). */
    linkage?: Linkage;
    /**
     * Optional group per embedding (e.g. its analysis window): embeddings of one group are known
     * to be different speakers, so their clusters are never merged by threshold. Both linkages
     * carry the constraint along (an infinite distance stays infinite after every merge).
     */
    cannotLink?: readonly number[];
  } = {},
): number[] {
  const n = embeddings.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const linkage = opts.linkage ?? 'complete';
  const dist = dissimilarities(embeddings.map(unit), linkage);
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
  const merges = nnChain(dist, n, linkage).sort((x, y) => x.height - y.height);

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
  return renumber(Array.from({ length: n }, (_, i) => find(i)));
}

/**
 * Cleans up clusters found by threshold, then gives every embedding the speaker whose average
 * voice (centroid) it is most similar to:
 *   - a cluster with less than `minSeconds` of speech (blips, laughter, a cough, a stretch of
 *     crosstalk) is folded into the most similar remaining cluster,
 *   - two clusters whose centroids are at least `mergeSimilarity` alike (cosine) are merged: one
 *     voice that the threshold split, e.g. after the speaker moved relative to the microphone.
 * `seconds[i]` is how much speech embedding i was computed from.
 */
export function refineClusters(
  embeddings: Float32Array[],
  labels: readonly number[],
  seconds: readonly number[],
  opts: { minSeconds?: number; mergeSimilarity?: number } = {},
): number[] {
  const n = embeddings.length;
  if (n === 0) return [];
  const normalized = embeddings.map(unit);
  const dim = normalized[0]!.length;
  let current = [...labels];
  const centroidsOf = (ids: number[]) =>
    ids.map((id) => {
      const c = new Float64Array(dim);
      current.forEach((l, i) => {
        if (l !== id) return;
        const u = normalized[i]!;
        for (let k = 0; k < dim; k++) c[k]! += u[k]!;
      });
      return unit(Float32Array.from(c));
    });
  const nearest = (u: Float64Array, centroids: Float64Array[]) => {
    let best = 0;
    for (let c = 1; c < centroids.length; c++) if (dot(u, centroids[c]!) > dot(u, centroids[best]!)) best = c;
    return best;
  };

  const speech = new Map<number, number>();
  current.forEach((l, i) => speech.set(l, (speech.get(l) ?? 0) + seconds[i]!));
  const bySpeech = [...speech.keys()].sort((a, b) => speech.get(b)! - speech.get(a)!);
  let keep = bySpeech.filter((id) => speech.get(id)! >= (opts.minSeconds ?? 0));
  if (keep.length === 0) keep = [bySpeech[0]!];
  const small = bySpeech.filter((id) => !keep.includes(id));
  if (small.length > 0) {
    const kept = centroidsOf(keep);
    const target = new Map(centroidsOf(small).map((c, s) => [small[s]!, keep[nearest(c, kept)]!]));
    current = current.map((l) => target.get(l) ?? l);
  }

  const mergeSimilarity = opts.mergeSimilarity ?? Number.POSITIVE_INFINITY;
  while (keep.length > 1) {
    const centroids = centroidsOf(keep);
    let best = { sim: -Infinity, a: 0, b: 0 };
    for (let a = 0; a < keep.length; a++) {
      for (let b = a + 1; b < keep.length; b++) {
        const sim = dot(centroids[a]!, centroids[b]!);
        if (sim > best.sim) best = { sim, a, b };
      }
    }
    if (best.sim < mergeSimilarity) break;
    const from = keep[best.b]!;
    const to = keep[best.a]!;
    current = current.map((l) => (l === from ? to : l));
    keep = keep.filter((id) => id !== from);
  }

  const centroids = centroidsOf(keep);
  return renumber(normalized.map((u) => keep[nearest(u, centroids)]!));
}
