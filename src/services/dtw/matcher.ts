/**
 * @file matcher.ts
 * @description Zero-allocation Sakoe-Chiba Derivative Dynamic Time Warping (DDTW) engine.
 * Features:
 * - Pre-allocated static buffers (cost matrix 32x32 = 1024 floats, stride 32; 30-frame Float32Array(112) buffers).
 * - Weighted distance metric (torso, hands with asymmetric mismatch penalty, spatial anchors, velocity derivatives).
 * - Sakoe-Chiba constraint band with slope adjustment (w = 8).
 * - UCR-DTW row-based early abandoning (prunes if row min > 3.2).
 * - Subsequence open-ended termination over search row N.
 * - O(1) bilateral invariance swap (handedness symmetry).
 * - Traceback submetric separation for handshape vs. spatial trajectory without heap allocation.
 */

import { SIFORMER_DIM, TARGET_SEQUENCE_LENGTH, resampleSequence } from './siformer.js';
import { evaluateScoring, calculateKineticEnergy, ScoringResult, CompetitorEvaluation } from './scoring.js';

export const MATRIX_STRIDE = 32;
export const MATRIX_SIZE = MATRIX_STRIDE * MATRIX_STRIDE; // 1024 floats
export const SAKOE_CHIBA_WINDOW = 8;
export const EARLY_ABANDON_ROW_THRESHOLD = 3.2;

export interface PreprocessedTemplate {
  signName: string;
  frames: Float32Array[];
  velocities: Float32Array[];
  frameCount: number;
}

export interface MatcherEvaluation {
  standardAvgCost: number;
  swappedAvgCost: number;
  bestAvgCost: number;
  isBilateralMatch: boolean;
  handshapeCost: number;
  spatialPathCost: number;
  scoring: ScoringResult;
}

/**
 * Pre-allocated zero-allocation buffers for real-time video evaluation loop.
 */
class BufferPool {
  readonly costMatrix = new Float32Array(MATRIX_SIZE);
  readonly userDecimated: Float32Array[] = Array.from(
    { length: TARGET_SEQUENCE_LENGTH },
    () => new Float32Array(SIFORMER_DIM)
  );
  readonly userSwapped: Float32Array[] = Array.from(
    { length: TARGET_SEQUENCE_LENGTH },
    () => new Float32Array(SIFORMER_DIM)
  );
  readonly userVelocity: Float32Array[] = Array.from(
    { length: TARGET_SEQUENCE_LENGTH },
    () => new Float32Array(SIFORMER_DIM)
  );
  readonly swappedVelocity: Float32Array[] = Array.from(
    { length: TARGET_SEQUENCE_LENGTH },
    () => new Float32Array(SIFORMER_DIM)
  );
  // Traceback steps: pathI and pathJ stored in Uint8Array(64)
  readonly tracebackI = new Uint8Array(64);
  readonly tracebackJ = new Uint8Array(64);
  readonly submetricComponents = new Float32Array(2);
}

const POOL = new BufferPool();

/**
 * Computes the frame distance components between user frame u and template frame v:
 * D = sqrt(D_torso + D_hands + D_anchor_spatial + D_anchor_velocity)
 *
 * @param u User feature frame (112 floats)
 * @param v Template feature frame (112 floats)
 * @param uVel User velocity frame (112 floats)
 * @param vVel Template velocity frame (112 floats)
 * @param outComponents Optional 2-element array [D_hands, D_path] for submetric analysis
 */
export function computeFrameDistance(
  u: Float32Array,
  v: Float32Array,
  uVel: Float32Array,
  vVel: Float32Array,
  outComponents?: Float32Array
): number {
  // 1. Torso distance (0.5 * sum_{k=0..23}((u_k - v_k)^2))
  let dTorso = 0;
  for (let k = 0; k < 24; k++) {
    const diff = u[k] - v[k];
    dTorso += diff * diff;
  }
  dTorso *= 0.5;

  // 2. Hand distance
  // Left Hand: indices 24..65. Right Hand: indices 66..107.
  const uLhActive = u[24] !== 0.0 || u[25] !== 0.0;
  const vLhActive = v[24] !== 0.0 || v[25] !== 0.0;
  const uRhActive = u[66] !== 0.0 || u[67] !== 0.0;
  const vRhActive = v[66] !== 0.0 || v[67] !== 0.0;

  let dHands = 0;

  // Left Hand component
  if (uLhActive && vLhActive) {
    let lhDiff = 0;
    for (let k = 24; k < 66; k++) {
      const diff = u[k] - v[k];
      lhDiff += diff * diff;
    }
    dHands += 1.3 * lhDiff;
  } else if (uLhActive !== vLhActive) {
    dHands += 0.75; // Asymmetric mismatch penalty
  }

  // Right Hand component
  if (uRhActive && vRhActive) {
    let rhDiff = 0;
    for (let k = 66; k < 108; k++) {
      const diff = u[k] - v[k];
      rhDiff += diff * diff;
    }
    dHands += 1.3 * rhDiff;
  } else if (uRhActive !== vRhActive) {
    dHands += 0.75; // Asymmetric mismatch penalty
  }

  // 3. Spatial Neck Anchors (1.4 * sum_{k=108..111}((u_k - v_k)^2))
  let dAnchorSpatial = 0;
  for (let k = 108; k < 112; k++) {
    const diff = u[k] - v[k];
    dAnchorSpatial += diff * diff;
  }
  dAnchorSpatial *= 1.4;

  // 4. Velocity Anchors (1.8 * sum_{k=108..111}((u'_k - v'_k)^2))
  let dAnchorVelocity = 0;
  for (let k = 108; k < 112; k++) {
    const diff = uVel[k] - vVel[k];
    dAnchorVelocity += diff * diff;
  }
  dAnchorVelocity *= 1.8;

  const dPath = dTorso + dAnchorSpatial + dAnchorVelocity;
  if (outComponents) {
    outComponents[0] = dHands;
    outComponents[1] = dPath;
  }

  return Math.sqrt(dTorso + dHands + dAnchorSpatial + dAnchorVelocity);
}

/**
 * Computes velocity stream across an array of frames:
 * v'(0) = 0
 * v'(t) = v(t) - v(t-1)
 */
export function computeVelocities(
  frames: Float32Array[],
  outVelocities: Float32Array[],
  count: number
): void {
  outVelocities[0].fill(0);
  for (let t = 1; t < count; t++) {
    const prev = frames[t - 1];
    const curr = frames[t];
    const vel = outVelocities[t];
    for (let k = 0; k < SIFORMER_DIM; k++) {
      vel[k] = curr[k] - prev[k];
    }
  }
}

/**
 * Prepares a template for matching by linearly resampling to 30 frames and precomputing velocity streams.
 */
export function preprocessTemplate(
  signName: string,
  rawFrames: Float32Array[]
): PreprocessedTemplate {
  const frames = Array.from(
    { length: TARGET_SEQUENCE_LENGTH },
    () => new Float32Array(SIFORMER_DIM)
  );
  const velocities = Array.from(
    { length: TARGET_SEQUENCE_LENGTH },
    () => new Float32Array(SIFORMER_DIM)
  );

  const frameCount = resampleSequence(rawFrames, frames, TARGET_SEQUENCE_LENGTH);
  computeVelocities(frames, velocities, frameCount);

  return {
    signName,
    frames,
    velocities,
    frameCount
  };
}

/**
 * Performs O(1) bilateral parity swap on user frames into the swapped buffer:
 * - Torso (0..23) is preserved unchanged.
 * - Left Hand (24..65) <-> Right Hand (66..107).
 * - X anchors inverted: swapped_lh_x = -user_rh_x, swapped_rh_x = -user_lh_x.
 * - Y anchors swapped directly.
 */
export function performBilateralSwap(
  sourceFrames: Float32Array[],
  swappedFrames: Float32Array[],
  count: number
): void {
  for (let t = 0; t < count; t++) {
    const src = sourceFrames[t];
    const dst = swappedFrames[t];

    // 1. Torso: indices 0..23 copied directly
    for (let k = 0; k < 24; k++) {
      dst[k] = src[k];
    }

    // 2. Hand Swap: Left Hand (24..65) <-> Right Hand (66..107)
    for (let k = 0; k < 42; k++) {
      dst[24 + k] = src[66 + k];
      dst[66 + k] = src[24 + k];
    }

    // 3. Anchor Swap & X Inversion:
    // 108: LH_x -> -RH_x (src[110])
    // 109: LH_y -> RH_y (src[111])
    // 110: RH_x -> -LH_x (src[108])
    // 111: RH_y -> LH_y (src[109])
    dst[108] = -src[110];
    dst[109] = src[111];
    dst[110] = -src[108];
    dst[111] = src[109];
  }
}

export interface AlignmentResult {
  avgCost: number;
  bestJ: number;
  earlyAbandoned: boolean;
}

/**
 * Runs zero-allocation Sakoe-Chiba dynamic programming with early abandoning and open-ended termination.
 */
export function alignDdtw(
  user: Float32Array[],
  userVel: Float32Array[],
  userLen: number,
  template: Float32Array[],
  templateVel: Float32Array[],
  templateLen: number,
  outMatrix: Float32Array
): AlignmentResult {
  const N = Math.min(30, userLen);
  const M = Math.min(30, templateLen);
  if (N === 0 || M === 0) {
    return { avgCost: Infinity, bestJ: M, earlyAbandoned: true };
  }

  // Initialize cost matrix
  outMatrix.fill(Infinity);
  outMatrix[0] = 0.0;

  const slope = M / N;
  const w = SAKOE_CHIBA_WINDOW;

  for (let i = 1; i <= N; i++) {
    const expectedJ = Math.round(i * slope);
    const jStart = Math.max(1, expectedJ - w);
    const jEnd = Math.min(M, expectedJ + w);

    let rowMin = Infinity;
    const uFrame = user[i - 1];
    const uV = userVel[i - 1];
    const rowOffset = i * MATRIX_STRIDE;
    const prevRowOffset = (i - 1) * MATRIX_STRIDE;

    for (let j = jStart; j <= jEnd; j++) {
      const vFrame = template[j - 1];
      const vV = templateVel[j - 1];
      const dist = computeFrameDistance(uFrame, vFrame, uV, vV);

      const diag = outMatrix[prevRowOffset + (j - 1)];
      const up = outMatrix[prevRowOffset + j] + 0.05;
      const left = outMatrix[rowOffset + (j - 1)] + 0.05;

      const cellCost = dist + Math.min(diag, up, left);
      outMatrix[rowOffset + j] = cellCost;

      if (cellCost < rowMin) {
        rowMin = cellCost;
      }
    }

    // UCR-DTW Early Abandoning (normalized step cost along row i)
    if (rowMin / i > EARLY_ABANDON_ROW_THRESHOLD) {
      return { avgCost: Infinity, bestJ: M, earlyAbandoned: true };
    }
  }

  // Subsequence Open-Ended Termination along row N
  // Column range: [max(1, min(M, max(floor(0.6 * M), M - 8))), M]
  const minSearchJ = Math.max(1, Math.min(M, Math.max(Math.floor(0.6 * M), M - SAKOE_CHIBA_WINDOW)));
  const rowOffsetN = N * MATRIX_STRIDE;

  let minCost = Infinity;
  let bestJ = M;

  for (let j = minSearchJ; j <= M; j++) {
    const cost = outMatrix[rowOffsetN + j];
    if (cost < minCost) {
      minCost = cost;
      bestJ = j;
    }
  }

  const avgCost = minCost / Math.max(1, bestJ);
  return { avgCost, bestJ, earlyAbandoned: false };
}

/**
 * Traces back the alignment path from (N, bestJ) down to (0, 0) in zero heap allocations,
 * and extracts the isolated handshape cost and spatial path cost.
 */
export function extractSubmetricCosts(
  user: Float32Array[],
  userVel: Float32Array[],
  N: number,
  template: Float32Array[],
  templateVel: Float32Array[],
  bestJ: number,
  matrix: Float32Array
): { handshapeCost: number; spatialPathCost: number } {
  let currI = N;
  let currJ = bestJ;
  let steps = 0;

  const tempComp = POOL.submetricComponents;
  let sumHand = 0;
  let sumPath = 0;

  while (currI > 0 && currJ > 0 && steps < 60) {
    computeFrameDistance(
      user[currI - 1],
      template[currJ - 1],
      userVel[currI - 1],
      templateVel[currJ - 1],
      tempComp
    );
    sumHand += tempComp[0];
    sumPath += tempComp[1];
    steps++;

    const diag = matrix[(currI - 1) * MATRIX_STRIDE + (currJ - 1)];
    const up = matrix[(currI - 1) * MATRIX_STRIDE + currJ];
    const left = matrix[currI * MATRIX_STRIDE + (currJ - 1)];

    if (diag <= up && diag <= left) {
      currI--;
      currJ--;
    } else if (up <= left) {
      currI--;
    } else {
      currJ--;
    }
  }

  const denom = Math.max(1, steps);
  return {
    handshapeCost: Math.sqrt(sumHand / denom),
    spatialPathCost: Math.sqrt(sumPath / denom)
  };
}

/**
 * Zero-allocation DDTW Matcher entry point.
 * Matches a user gesture sequence against a preprocessed template.
 *
 * @param userFrames Raw user gesture frames.
 * @param template Preprocessed template.
 * @param competitors Optional competitor evaluations for contrastive scoring & disambiguation.
 */
export function matchGesture(
  userFrames: Float32Array[],
  template: PreprocessedTemplate,
  competitors?: CompetitorEvaluation[]
): MatcherEvaluation {
  // 1. Resample user sequence to exactly 30 frames in userDecimated buffer
  const userCount = resampleSequence(userFrames, POOL.userDecimated, TARGET_SEQUENCE_LENGTH);
  computeVelocities(POOL.userDecimated, POOL.userVelocity, userCount);

  // 2. Standard alignment
  const stdAlignment = alignDdtw(
    POOL.userDecimated,
    POOL.userVelocity,
    userCount,
    template.frames,
    template.velocities,
    template.frameCount,
    POOL.costMatrix
  );

  let stdHandCost = Infinity;
  let stdPathCost = Infinity;

  if (!stdAlignment.earlyAbandoned && stdAlignment.avgCost < Infinity) {
    const submetrics = extractSubmetricCosts(
      POOL.userDecimated,
      POOL.userVelocity,
      userCount,
      template.frames,
      template.velocities,
      stdAlignment.bestJ,
      POOL.costMatrix
    );
    stdHandCost = submetrics.handshapeCost;
    stdPathCost = submetrics.spatialPathCost;
  }

  // 3. Bilateral (Left/Right swapped) alignment
  performBilateralSwap(POOL.userDecimated, POOL.userSwapped, userCount);
  computeVelocities(POOL.userSwapped, POOL.swappedVelocity, userCount);

  const swappedAlignment = alignDdtw(
    POOL.userSwapped,
    POOL.swappedVelocity,
    userCount,
    template.frames,
    template.velocities,
    template.frameCount,
    POOL.costMatrix
  );

  let swappedHandCost = Infinity;
  let swappedPathCost = Infinity;

  if (!swappedAlignment.earlyAbandoned && swappedAlignment.avgCost < Infinity) {
    const submetrics = extractSubmetricCosts(
      POOL.userSwapped,
      POOL.swappedVelocity,
      userCount,
      template.frames,
      template.velocities,
      swappedAlignment.bestJ,
      POOL.costMatrix
    );
    swappedHandCost = submetrics.handshapeCost;
    swappedPathCost = submetrics.spatialPathCost;
  }

  // 4. Select best bilateral alignment (evaluating hand parity and cost)
  let uLhActive = false;
  let uRhActive = false;
  let tLhActive = false;
  let tRhActive = false;

  for (let t = 0; t < userCount; t++) {
    const uf = POOL.userDecimated[t];
    if (uf[24] !== 0 || uf[25] !== 0) uLhActive = true;
    if (uf[66] !== 0 || uf[67] !== 0) uRhActive = true;
  }
  for (let t = 0; t < template.frameCount; t++) {
    const tf = template.frames[t];
    if (tf[24] !== 0 || tf[25] !== 0) tLhActive = true;
    if (tf[66] !== 0 || tf[67] !== 0) tRhActive = true;
  }

  let isBilateral = false;
  if (tRhActive && !tLhActive && uLhActive && !uRhActive) {
    isBilateral = true;
  } else if (tLhActive && !tRhActive && uRhActive && !uLhActive) {
    isBilateral = true;
  } else if (tRhActive && !tLhActive && uRhActive && !uLhActive) {
    isBilateral = false;
  } else if (tLhActive && !tRhActive && uLhActive && !uRhActive) {
    isBilateral = false;
  } else {
    isBilateral = swappedAlignment.avgCost < stdAlignment.avgCost;
  }

  const bestAvgCost = isBilateral ? swappedAlignment.avgCost : stdAlignment.avgCost;
  const bestHandCost = isBilateral ? swappedHandCost : stdHandCost;
  const bestPathCost = isBilateral ? swappedPathCost : stdPathCost;

  // 5. Kinetic energy & final scoring
  const kineticEnergy = calculateKineticEnergy(POOL.userDecimated);
  const scoring = evaluateScoring(
    bestAvgCost,
    bestHandCost,
    bestPathCost,
    kineticEnergy,
    true,
    competitors
  );

  return {
    standardAvgCost: stdAlignment.avgCost,
    swappedAvgCost: swappedAlignment.avgCost,
    bestAvgCost,
    isBilateralMatch: isBilateral,
    handshapeCost: bestHandCost,
    spatialPathCost: bestPathCost,
    scoring
  };
}
