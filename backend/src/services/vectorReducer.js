/**
 * Pure-JS PCA dimensionality reduction (1536D → 2D).
 * Uses the dual PCA trick: compute n×n gram matrix (since n << 1536),
 * extract top 2 eigenvectors via power iteration, project points.
 * Output normalized to [-1, 1].
 */

/**
 * @param {number[][]} vectors  Array of high-dimensional vectors (all same length)
 * @returns {{ x: number, y: number }[]}  2D coordinates normalized to [-1, 1]
 */
export function reduceToPCA2D(vectors) {
  if (!vectors || vectors.length === 0) return [];
  if (vectors.length === 1) return [{ x: 0, y: 0 }];

  const n = vectors.length;
  const dim = vectors[0].length;

  // Center the data
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dim; d++) mean[d] += vectors[i][d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= n;

  const centered = vectors.map((v) => v.map((val, d) => val - mean[d]));

  // Build n×n gram matrix G = X * X^T  (dual PCA, since n << dim)
  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += centered[i][d] * centered[j][d];
      G[i][j] = dot;
      G[j][i] = dot;
    }
  }

  // Power iteration to extract top eigenvector
  function powerIteration(matrix, numIter = 200) {
    const size = matrix.length;
    let v = new Float64Array(size);
    for (let i = 0; i < size; i++) v[i] = Math.random() - 0.5;

    for (let iter = 0; iter < numIter; iter++) {
      const next = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        let s = 0;
        for (let j = 0; j < size; j++) s += matrix[i][j] * v[j];
        next[i] = s;
      }
      let norm = 0;
      for (let i = 0; i < size; i++) norm += next[i] * next[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < size; i++) next[i] /= norm;
      v = next;
    }
    return v;
  }

  // Deflate matrix by removing component along eigenvector
  function deflate(matrix, eigenvector) {
    const size = matrix.length;
    let eigenvalue = 0;
    const Mv = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      let s = 0;
      for (let j = 0; j < size; j++) s += matrix[i][j] * eigenvector[j];
      Mv[i] = s;
      eigenvalue += eigenvector[i] * s;
    }
    const deflated = Array.from({ length: size }, () => new Float64Array(size));
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        deflated[i][j] = matrix[i][j] - eigenvalue * eigenvector[i] * eigenvector[j];
      }
    }
    return deflated;
  }

  const ev1 = powerIteration(G);
  const G2 = deflate(G, ev1);
  const ev2 = powerIteration(G2);

  // Project: component_k[i] = ev_k[i] (the gram-space eigenvectors ARE the projections)
  const coords = [];
  for (let i = 0; i < n; i++) {
    coords.push({ x: ev1[i], y: ev2[i] });
  }

  // Normalize to [-1, 1]
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of coords) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return coords.map((c) => ({
    x: Math.round(((c.x - minX) / rangeX * 2 - 1) * 10000) / 10000,
    y: Math.round(((c.y - minY) / rangeY * 2 - 1) * 10000) / 10000,
  }));
}
