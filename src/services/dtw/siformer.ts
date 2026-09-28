/**
 * @file siformer.ts
 * @description 112-dimensional Siformer landmark extraction, anatomical torso normalization,
 * local aspect-ratio preserving hand normalization, spatial neck anchors, and 1st temporal velocity computation.
 *
 * Designed for zero heap allocation during real-time video evaluation loops.
 */

export const SIFORMER_DIM = 112;
export const TORSO_DIM = 24;
export const HAND_DIM = 42;
export const ANCHOR_DIM = 4;
export const TARGET_SEQUENCE_LENGTH = 30;

export interface NormalizedPoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface HolisticResults {
  poseLandmarks?: NormalizedPoint[] | null;
  leftHandLandmarks?: NormalizedPoint[] | null;
  rightHandLandmarks?: NormalizedPoint[] | null;
}

/**
 * Key MediaPipe Pose landmark indices for Upper-Body Torso (12 points = 24 floats):
 * 0: Nose (pose[0])
 * 1: Left Eye Inner/Center (pose[1] or pose[2])
 * 2: Right Eye Inner/Center (pose[4] or pose[5])
 * 3: Left Ear (pose[7])
 * 4: Right Ear (pose[8])
 * 5: Left Shoulder (pose[11])
 * 6: Right Shoulder (pose[12])
 * 7: Left Elbow (pose[13])
 * 8: Right Elbow (pose[14])
 * 9: Left Wrist (pose[15])
 * 10: Right Wrist (pose[16])
 * 11: Neck Midpoint ((pose[11] + pose[12]) / 2)
 */
const POSE_KEY_INDICES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16] as const;

/**
 * Normalizes upper-body torso, isolated hands, and spatial neck anchors into a 112-dim vector.
 *
 * Feature Layout:
 * - Indices 0..23: Upper body & torso (12 points, centered at neck midpoint, normalized by shoulder distance H).
 * - Indices 24..65: Left hand shape (21 points, aspect-ratio preserved with 10% padding; 0.0 if untracked).
 * - Indices 66..107: Right hand shape (21 points, aspect-ratio preserved with 10% padding; 0.0 if untracked).
 * - Indices 108..111: Spatial neck anchors (LH_x, LH_y, RH_x, RH_y relative to Neck / H).
 *
 * @param results MediaPipe holistic frame detection results.
 * @param outTarget Pre-allocated Float32Array(112) target buffer.
 * @param prevFeature Optional previous frame Float32Array(112).
 * @param outVelocity Optional pre-allocated Float32Array(112) for velocity derivative u'(t) = u(t) - u(t-1).
 */
export function extractSiformer112(
  results: HolisticResults | null | undefined,
  outTarget: Float32Array,
  prevFeature?: Float32Array | null,
  outVelocity?: Float32Array | null
): Float32Array {
  outTarget.fill(0);

  const pose = results?.poseLandmarks;
  const leftHand = results?.leftHandLandmarks;
  const rightHand = results?.rightHandLandmarks;

  // 1. Compute Neck and Shoulder Scale Factor H
  let neckX = 0.5;
  let neckY = 0.5;
  let eyeY = 0.35;
  let H = 0.25;

  if (pose && pose.length > 16) {
    const lSh = pose[11];
    const rSh = pose[12];
    if (lSh && rSh) {
      neckX = (lSh.x + rSh.x) * 0.5;
      neckY = (lSh.y + rSh.y) * 0.5;
      const dx = lSh.x - rSh.x;
      const dy = lSh.y - rSh.y;
      H = Math.max(0.04, Math.sqrt(dx * dx + dy * dy));
    }
    const nose = pose[0];
    if (nose) eyeY = nose.y;
  }

  // Torso bounding box constraint: X in [Neck_x - 3H, Neck_x + 3H], Y in [Eye_y + H, Eye_y - 5H]
  const minTorsoX = -3.0;
  const maxTorsoX = 3.0;
  const minTorsoY = (eyeY - 5.0 * H - neckY) / H;
  const maxTorsoY = (eyeY + H - neckY) / H;

  // 2. Populate Upper Body Torso (Indices 0..23: 12 key points)
  if (pose && pose.length > 16) {
    for (let i = 0; i < POSE_KEY_INDICES.length; i++) {
      const idx = POSE_KEY_INDICES[i];
      const pt = pose[idx];
      const outIdx = i * 2;
      if (pt) {
        const nx = (pt.x - neckX) / H;
        const ny = (pt.y - neckY) / H;
        outTarget[outIdx] = Math.max(minTorsoX, Math.min(maxTorsoX, nx));
        outTarget[outIdx + 1] = Math.max(minTorsoY, Math.min(maxTorsoY, ny));
      } else {
        outTarget[outIdx] = 0.0;
        outTarget[outIdx + 1] = 0.0;
      }
    }
    // 12th point is Neck midpoint (relative to neck = 0.0, 0.0)
    outTarget[22] = 0.0;
    outTarget[23] = 0.0;
  }

  // 3. Populate Left Hand (Indices 24..65, 21 points = 42 floats)
  let lhCenterX = 0;
  let lhCenterY = 0;
  let lhActive = false;

  if (leftHand && leftHand.length === 21) {
    lhActive = true;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < 21; i++) {
      const pt = leftHand[i];
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
      sumX += pt.x;
      sumY += pt.y;
    }

    lhCenterX = sumX / 21;
    lhCenterY = sumY / 21;

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    // Normalized within aspect-ratio bounding box with 10% padding
    const S = Math.max(0.005, Math.max(spanX, spanY) * 1.1);
    const boxMidX = (minX + maxX) * 0.5;
    const boxMidY = (minY + maxY) * 0.5;

    for (let i = 0; i < 21; i++) {
      const pt = leftHand[i];
      const targetOffset = 24 + i * 2;
      outTarget[targetOffset] = (pt.x - boxMidX) / S;
      outTarget[targetOffset + 1] = (pt.y - boxMidY) / S;
    }
  }

  // 4. Populate Right Hand (Indices 66..107, 21 points = 42 floats)
  let rhCenterX = 0;
  let rhCenterY = 0;
  let rhActive = false;

  if (rightHand && rightHand.length === 21) {
    rhActive = true;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < 21; i++) {
      const pt = rightHand[i];
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
      sumX += pt.x;
      sumY += pt.y;
    }

    rhCenterX = sumX / 21;
    rhCenterY = sumY / 21;

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const S = Math.max(0.005, Math.max(spanX, spanY) * 1.1);
    const boxMidX = (minX + maxX) * 0.5;
    const boxMidY = (minY + maxY) * 0.5;

    for (let i = 0; i < 21; i++) {
      const pt = rightHand[i];
      const targetOffset = 66 + i * 2;
      outTarget[targetOffset] = (pt.x - boxMidX) / S;
      outTarget[targetOffset + 1] = (pt.y - boxMidY) / S;
    }
  }

  // 5. Populate Spatial Neck Anchors (Indices 108..111)
  outTarget[108] = lhActive ? (lhCenterX - neckX) / H : 0.0;
  outTarget[109] = lhActive ? (lhCenterY - neckY) / H : 0.0;
  outTarget[110] = rhActive ? (rhCenterX - neckX) / H : 0.0;
  outTarget[111] = rhActive ? (rhCenterY - neckY) / H : 0.0;

  // 6. Compute 1st Temporal Velocity Vector: u'(t) = u(t) - u(t - 1)
  if (outVelocity) {
    if (prevFeature) {
      for (let k = 0; k < SIFORMER_DIM; k++) {
        outVelocity[k] = outTarget[k] - prevFeature[k];
      }
    } else {
      outVelocity.fill(0);
    }
  }

  return outTarget;
}

/**
 * Checks if a frame has any tracked hands (LH active or RH active).
 */
export function isHandActive(feature: Float32Array): boolean {
  return (
    feature[24] !== 0.0 ||
    feature[25] !== 0.0 ||
    feature[66] !== 0.0 ||
    feature[67] !== 0.0
  );
}

/**
 * Trims lead-in and lead-out resting frames where hand coordinates are inactive.
 */
export function trimRestingFrames(frames: Float32Array[]): Float32Array[] {
  if (frames.length === 0) return [];
  let firstActive = 0;
  while (firstActive < frames.length && !isHandActive(frames[firstActive])) {
    firstActive++;
  }
  let lastActive = frames.length - 1;
  while (lastActive >= firstActive && !isHandActive(frames[lastActive])) {
    lastActive--;
  }
  if (firstActive > lastActive) {
    return [];
  }
  return frames.slice(firstActive, lastActive + 1);
}

/**
 * Linearly resamples an active motion sequence of arbitrary frame count to exactly N target frames (default 30).
 * Populates targetBuffer without heap allocations.
 *
 * @param source Source frames.
 * @param targetBuffer Pre-allocated array of Float32Array(112) of length targetCount.
 * @param targetCount Number of frames to resample to (default 30).
 */
export function resampleSequence(
  source: Float32Array[],
  targetBuffer: Float32Array[],
  targetCount: number = TARGET_SEQUENCE_LENGTH
): number {
  const n = source.length;
  if (n === 0) return 0;
  if (n === 1) {
    for (let i = 0; i < targetCount; i++) {
      targetBuffer[i].set(source[0]);
    }
    return targetCount;
  }

  for (let i = 0; i < targetCount; i++) {
    const norm = (i / (targetCount - 1)) * (n - 1);
    const low = Math.floor(norm);
    const high = Math.min(n - 1, low + 1);
    const alpha = norm - low;
    const dest = targetBuffer[i];
    const fLow = source[low];
    const fHigh = source[high];

    for (let k = 0; k < SIFORMER_DIM; k++) {
      dest[k] = fLow[k] + alpha * (fHigh[k] - fLow[k]);
    }
  }

  return targetCount;
}
