// Reference labels come from sherpa-onnx's FastClustering on the same embeddings.
import cases from './__fixtures__/clusters.json';
import { clusterEmbeddings } from './cluster';

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
});
