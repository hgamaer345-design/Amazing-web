// Reference labels come from sherpa-onnx's FastClustering (complete linkage) and SciPy's
// linkage(method="ward") on unit-length vectors, on the same embeddings.
import cases from './__fixtures__/clusters.json';
import wardCases from './__fixtures__/ward.json';
import { clusterEmbeddings, refineClusters } from './cluster';

describe('clusterEmbeddings', () => {
  it.each(cases.map((c, i) => [i, c] as const))('matches sherpa-onnx FastClustering (case %i)', (_i, c) => {
    const embeddings = c.embeddings.map((e) => Float32Array.from(e));
    expect(clusterEmbeddings(embeddings, { threshold: c.threshold })).toEqual(c.byThreshold);
    expect(clusterEmbeddings(embeddings, { numClusters: c.k })).toEqual(c.byK);
  });

  it('handles trivial inputs and caps the requested cluster count', () => {
    expect(clusterEmbeddings([])).toEqual([]);
    expect(clusterEmbeddings([Float32Array.of(1, 0)])).toEqual([0]);
    const two = [Float32Array.of(1, 0), Float32Array.of(0, 1)];
    expect(clusterEmbeddings(two, { numClusters: 5 })).toEqual([0, 1]);
    expect(clusterEmbeddings(two, { threshold: 1.5 })).toEqual([0, 0]);
  });

  it('separates clearly different voices and groups similar ones', () => {
    const a = [Float32Array.of(1, 0.05, 0), Float32Array.of(0.95, 0, 0.05), Float32Array.of(1, 0.02, 0.01)];
    const b = [Float32Array.of(0, 1, 0.05), Float32Array.of(0.05, 0.97, 0)];
    expect(clusterEmbeddings([a[0]!, b[0]!, a[1]!, b[1]!, a[2]!])).toEqual([0, 1, 0, 1, 0]);
  });

  it('clusters thousands of embeddings quickly', () => {
    const embeddings = Array.from({ length: 1500 }, (_, i) => {
      const v = new Float32Array(32);
      v[i % 3] = 1;
      for (let k = 0; k < 32; k++) v[k]! += Math.sin(i * 7.1 + k) * 0.05;
      return v;
    });
    const started = Date.now();
    const labels = clusterEmbeddings(embeddings);
    expect(new Set(labels).size).toBe(3);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('never merges embeddings from the same group (cannot-link) unless a count forces it', () => {
    const near = [
      Float32Array.of(1, 0.05),
      Float32Array.of(1, 0),
      Float32Array.of(1, 0.02),
      Float32Array.of(0.98, 0.01),
    ];
    expect(clusterEmbeddings(near, { threshold: 0.5 })).toEqual([0, 0, 0, 0]);
    // 0 and 1 share a window, as do 2 and 3: two speakers, matched across the windows.
    expect(clusterEmbeddings(near, { threshold: 0.5, cannotLink: [0, 0, 1, 1] })).toEqual([0, 1, 0, 1]);
    expect(clusterEmbeddings(near, { numClusters: 1, cannotLink: [0, 0, 1, 1] })).toEqual([0, 0, 0, 0]);
  });
});

describe('clusterEmbeddings with Ward linkage', () => {
  it.each(wardCases.map((c, i) => [i, c] as const))('matches SciPy (case %i)', (_i, c) => {
    const embeddings = c.embeddings.map((e) => Float32Array.from(e));
    c.thresholds.forEach((threshold, t) => {
      expect(clusterEmbeddings(embeddings, { linkage: 'ward', threshold })).toEqual(c.labels[t]);
    });
    expect(clusterEmbeddings(embeddings, { linkage: 'ward', numClusters: c.k })).toEqual(c.byK);
  });

  it('needs more evidence to separate few embeddings than many', () => {
    const voice = (axis: number, i: number) => {
      const v = new Float32Array(4);
      v[axis] = 1;
      v[3] = 0.3 * Math.sin(i);
      return v;
    };
    // Two different voices, heard once each, are not enough to tell apart at this threshold...
    expect(clusterEmbeddings([voice(0, 0), voice(1, 1)], { linkage: 'ward', threshold: 2 })).toEqual([0, 0]);
    // ...but heard a few times each, they are.
    const many = Array.from({ length: 8 }, (_, i) => voice(i % 2, i));
    expect(clusterEmbeddings(many, { linkage: 'ward', threshold: 2 })).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('carries cannot-link constraints through merges', () => {
    const near = [
      Float32Array.of(1, 0.05),
      Float32Array.of(1, 0),
      Float32Array.of(1, 0.02),
      Float32Array.of(0.98, 0.01),
    ];
    expect(clusterEmbeddings(near, { linkage: 'ward', threshold: 2, cannotLink: [0, 0, 1, 1] })).toEqual([
      0, 1, 0, 1,
    ]);
  });
});

describe('refineClusters', () => {
  const v = (...xs: number[]) => Float32Array.from(xs);

  it('folds clusters with too little speech into the most similar one', () => {
    const embeddings = [v(1, 0, 0), v(0.9, 0.1, 0), v(0, 1, 0), v(0, 0.9, 0.1), v(0.6, 0.1, 0.5)];
    const labels = [0, 0, 1, 1, 2];
    expect(refineClusters(embeddings, labels, [5, 5, 5, 5, 2], { minSeconds: 3 })).toEqual([0, 0, 1, 1, 0]);
    // With enough speech, the third voice stays.
    expect(refineClusters(embeddings, labels, [5, 5, 5, 5, 4], { minSeconds: 3 })).toEqual([0, 0, 1, 1, 2]);
  });

  it('merges clusters whose average voices are nearly the same', () => {
    const embeddings = [v(1, 0.1, 0), v(1, 0, 0.1), v(1, 0.12, 0.05), v(0, 1, 0)];
    const labels = [0, 0, 1, 2];
    expect(refineClusters(embeddings, labels, [3, 3, 3, 3], { mergeSimilarity: 0.95 })).toEqual([0, 0, 0, 1]);
    const unmerged = refineClusters(embeddings, labels, [3, 3, 3, 3], { mergeSimilarity: 0.999 });
    expect(new Set(unmerged).size).toBe(3);
  });

  it('gives each embedding the speaker whose average voice is closest', () => {
    // Embedding 2 was clustered with speaker 0 but sounds like speaker 1.
    const embeddings = [v(1, 0), v(0.95, 0.05), v(0.2, 1), v(0, 1), v(0.1, 0.9)];
    expect(refineClusters(embeddings, [0, 0, 0, 1, 1], [3, 3, 3, 3, 3])).toEqual([0, 0, 1, 1, 1]);
  });

  it('keeps the biggest cluster when every cluster is too small', () => {
    expect(refineClusters([v(1, 0), v(0, 1), v(0.1, 1)], [0, 1, 1], [1, 1, 1], { minSeconds: 10 })).toEqual([
      0, 0, 0,
    ]);
    expect(refineClusters([], [], [])).toEqual([]);
  });
});
