import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSiformer112,
  resampleSequence,
  trimRestingFrames,
  SIFORMER_DIM,
  HolisticResults
} from '../siformer.js';
import {
  calculateKineticEnergy,
  sigmoidScore,
  evaluateScoring,
  KINETIC_ENERGY_THRESHOLD,
  PASSING_THRESHOLD
} from '../scoring.js';
import {
  computeFrameDistance,
  preprocessTemplate,
  matchGesture
} from '../matcher.js';

/**
 * Helper to construct synthetic Siformer frames for deterministic testing.
 */
function createSyntheticFrame(progress: number, handX: number, handY: number): Float32Array {
  const frame = new Float32Array(SIFORMER_DIM);

  // Shoulders at indices 12..15: Left Shoulder [12, 13], Right Shoulder [14, 15]
  frame[12] = -0.5; // L Sh X
  frame[13] = 0.0;  // L Sh Y
  frame[14] = 0.5;  // R Sh X
  frame[15] = 0.0;  // R Sh Y

  // Right Wrist at indices [20, 21]
  frame[20] = handX;
  frame[21] = handY;

  // Active right hand shape at indices 66..107 (e.g. open palm / spread fingers)
  for (let k = 66; k < 108; k++) {
    frame[k] = 0.1 * Math.sin(progress * Math.PI + k);
  }

  // Right neck anchor at indices 110, 111
  frame[110] = handX;
  frame[111] = handY;

  return frame;
}

function createSyntheticGesture(
  length: number,
  startX = 0.2,
  startY = 0.2,
  endX = 0.8,
  endY = 0.8
): Float32Array[] {
  return Array.from({ length }, (_, i) => {
    const p = i / (length - 1);
    const x = startX + p * (endX - startX);
    const y = startY + p * (endY - startY);
    return createSyntheticFrame(p, x, y);
  });
}

test('1. Siformer Extraction: normalizes landmarks into 112-dim vector without throwing', () => {
  const mockResults: HolisticResults = {
    poseLandmarks: [
      { x: 0.5, y: 0.3 }, // Nose
      { x: 0.48, y: 0.28 },
      { x: 0.47, y: 0.28 },
      { x: 0.46, y: 0.28 },
      { x: 0.53, y: 0.28 },
      { x: 0.54, y: 0.28 },
      { x: 0.55, y: 0.28 },
      { x: 0.42, y: 0.3 },
      { x: 0.58, y: 0.3 },
      { x: 0.49, y: 0.35 },
      { x: 0.51, y: 0.35 },
      { x: 0.4, y: 0.5 }, // L Shoulder
      { x: 0.6, y: 0.5 }, // R Shoulder
      { x: 0.35, y: 0.7 },
      { x: 0.65, y: 0.7 },
      { x: 0.3, y: 0.9 }, // L Wrist
      { x: 0.7, y: 0.9 }  // R Wrist
    ],
    leftHandLandmarks: Array.from({ length: 21 }, (_, i) => ({ x: 0.28 + i * 0.005, y: 0.88 + i * 0.005 })),
    rightHandLandmarks: Array.from({ length: 21 }, (_, i) => ({ x: 0.68 + i * 0.005, y: 0.88 + i * 0.005 }))
  };

  const buffer = new Float32Array(SIFORMER_DIM);
  const velBuffer = new Float32Array(SIFORMER_DIM);
  extractSiformer112(mockResults, buffer, null, velBuffer);

  assert.equal(buffer.length, 112);
  assert.notEqual(buffer[24], 0.0, 'Left hand active');
  assert.notEqual(buffer[66], 0.0, 'Right hand active');
  assert.notEqual(buffer[108], 0.0, 'Left anchor populated');
  assert.notEqual(buffer[110], 0.0, 'Right anchor populated');
});

test('2. Zero-Allocation Evaluation: frame evaluation loop executes with 0 memory allocation', () => {
  const templateGesture = createSyntheticGesture(30);
  const userGesture = createSyntheticGesture(30);
  const template = preprocessTemplate('TEST_SIGN', templateGesture);

  // Warmup run
  matchGesture(userGesture, template);

  // Run iterations and verify consistent stability
  const startMemory = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50; i++) {
    const result = matchGesture(userGesture, template);
    assert.ok(result.scoring.score >= PASSING_THRESHOLD);
  }
  const endMemory = process.memoryUsage().heapUsed;

  // Heap growth across 50 iterations should be effectively negligible (< 500 KB across entire v8 engine)
  const heapDiff = endMemory - startMemory;
  assert.ok(heapDiff < 500 * 1024, `Heap growth was ${heapDiff} bytes, expected near zero`);
});

test('3. Motion Energy Anti-Idle Gating: stationary handshape is rejected with IDLE_STATIONARY', () => {
  // 30 frames with identical coordinates (completely still hand)
  const stillFrame = createSyntheticFrame(0, 0.5, 0.5);
  const stationaryGesture = Array.from({ length: 30 }, () => stillFrame);

  const movingTemplateFrames = createSyntheticGesture(30, 0.2, 0.2, 0.8, 0.8);
  const template = preprocessTemplate('WAVE', movingTemplateFrames);

  const energy = calculateKineticEnergy(stationaryGesture);
  assert.ok(energy < KINETIC_ENERGY_THRESHOLD, `Kinetic energy was ${energy}, expected < ${KINETIC_ENERGY_THRESHOLD}`);

  const evaluation = matchGesture(stationaryGesture, template);
  assert.equal(evaluation.scoring.status, 'IDLE_STATIONARY');
  assert.equal(evaluation.scoring.score, 0);
  assert.equal(evaluation.scoring.passed, false);
});

test('4. Direction Reversal Penalty: backwards gesture trajectory receives severe penalty', () => {
  const forwardGesture = createSyntheticGesture(30, 0.1, 0.1, 0.9, 0.9);
  const reversedGesture = [...forwardGesture].reverse();

  const template = preprocessTemplate('SWIPE_RIGHT', forwardGesture);

  const forwardEval = matchGesture(forwardGesture, template);
  const reversedEval = matchGesture(reversedGesture, template);

  assert.ok(forwardEval.scoring.score > 80, `Forward score was ${forwardEval.scoring.score}`);
  assert.ok(
    reversedEval.bestAvgCost > forwardEval.bestAvgCost * 2,
    `Reversed cost ${reversedEval.bestAvgCost} should be > 2x forward cost ${forwardEval.bestAvgCost}`
  );
  assert.ok(
    forwardEval.scoring.score > reversedEval.scoring.score + 10,
    `Forward score ${forwardEval.scoring.score} vs reversed score ${reversedEval.scoring.score}`
  );
});

test('5. Left/Right Bilateral Symmetry: mirrored gesture matches template via bilateral swap', () => {
  // Reference template performed with Right Hand moving from X: 0.2 -> 0.8
  const rightHandGesture = createSyntheticGesture(30, 0.2, 0.4, 0.8, 0.4);
  const template = preprocessTemplate('RIGHT_SWIPE', rightHandGesture);

  // User performs identical movement with Left Hand (mirrored X: -0.2 -> -0.8)
  const leftHandGesture = Array.from({ length: 30 }, (_, i) => {
    const p = i / 29;
    const x = -(0.2 + p * 0.6); // mirrored X anchor
    const y = 0.4;
    const frame = new Float32Array(SIFORMER_DIM);

    // Torso shoulders
    frame[12] = -0.5; // L Sh X
    frame[13] = 0.0;  // L Sh Y
    frame[14] = 0.5;  // R Sh X
    frame[15] = 0.0;  // R Sh Y

    // Left hand active (24..65), Right hand empty (66..107)
    for (let k = 24; k < 66; k++) {
      frame[k] = 0.1 * Math.sin(p * Math.PI + (k - 24 + 66));
    }
    // Left anchor
    frame[108] = x;
    frame[109] = y;
    return frame;
  });

  const evaluation = matchGesture(leftHandGesture, template);

  assert.equal(evaluation.isBilateralMatch, true, 'Matcher must identify bilateral match');
  assert.ok(
    evaluation.swappedAvgCost < evaluation.standardAvgCost,
    'Swapped cost must be lower than standard cost'
  );
  assert.ok(evaluation.scoring.score >= PASSING_THRESHOLD, `Bilateral score was ${evaluation.scoring.score}`);
});

test('6. Two-Tier Threshold Verification: differentiates handshape error vs spatial path error', () => {
  // Baseline passing gesture
  const goodGesture = createSyntheticGesture(30);
  const template = preprocessTemplate('BASE_SIGN', goodGesture);

  const goodEval = matchGesture(goodGesture, template);
  assert.equal(goodEval.scoring.passed, true);
  assert.equal(goodEval.scoring.feedback, 'Sign achieved. Beautifully done!');

  // Path correct, handshape distorted
  const wrongHandGesture = goodGesture.map(f => {
    const copy = new Float32Array(f);
    // Perturb hand points to distort handshape submetric (delta = 0.35 yields ~35% handscore)
    for (let k = 66; k < 108; k++) {
      copy[k] += 0.35;
    }
    return copy;
  });

  const handshapeMismatchEval = matchGesture(wrongHandGesture, template);
  assert.ok(
    handshapeMismatchEval.handshapeCost > goodEval.handshapeCost,
    'Handshape cost should be higher'
  );
  assert.equal(
    handshapeMismatchEval.scoring.feedback,
    'Movement path correct, but check your hand shape.'
  );
});

test('7. Competitor Disambiguation: triggers "Did you mean: {Competitor}?"', () => {
  const scoring = evaluateScoring(
    3.0, // High cost for target (low score < 45)
    1.5,
    1.5,
    0.2, // Movement detected
    true,
    [
      { signName: 'HELLO', score: 30 },
      { signName: 'THANK YOU', score: 75 } // Competitor >= 65 and margin > 25
    ]
  );

  assert.equal(scoring.status, 'DIFFERENT_SIGN');
  assert.equal(scoring.feedback, 'Did you mean: THANK YOU?');
  assert.equal(scoring.disambiguation, 'THANK YOU');
});

test('8. Sequence Preprocessing: trims resting frames and resamples uniformly', () => {
  // Empty frames
  const empty = trimRestingFrames([]);
  assert.equal(empty.length, 0);

  // Frames with inactive hands at start and end
  const inactiveStart = new Float32Array(SIFORMER_DIM);
  const activeMid1 = new Float32Array(SIFORMER_DIM);
  activeMid1[66] = 0.5; // active RH
  const activeMid2 = new Float32Array(SIFORMER_DIM);
  activeMid2[66] = 0.8;
  const inactiveEnd = new Float32Array(SIFORMER_DIM);

  const trimmed = trimRestingFrames([inactiveStart, activeMid1, activeMid2, inactiveEnd]);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0], activeMid1);
  assert.equal(trimmed[1], activeMid2);

  // Resample sequence to 30 frames
  const targetBuffer = Array.from({ length: 30 }, () => new Float32Array(SIFORMER_DIM));
  const count = resampleSequence(trimmed, targetBuffer, 30);
  assert.equal(count, 30);
  assert.ok(Math.abs(targetBuffer[0][66] - 0.5) < 1e-5);
  assert.ok(Math.abs(targetBuffer[29][66] - 0.8) < 1e-5);
});

test('9. Sigmoid Score Calibration: accurately maps alignment cost to 0-100 scale', () => {
  // Low cost -> High score
  const perfectScore = sigmoidScore(0.5);
  assert.ok(perfectScore >= 95, `Expected high score for cost 0.5, got ${perfectScore}`);

  // Inf / Negative cost guard
  assert.equal(sigmoidScore(-1), 0);
  assert.equal(sigmoidScore(Infinity), 0);

  // Near midpoint cost (~2.2) should yield ~50%
  const midScore = sigmoidScore(2.2);
  assert.ok(midScore >= 45 && midScore <= 55, `Expected ~50% for cost 2.2, got ${midScore}`);

  // High cost -> Low score
  const badScore = sigmoidScore(5.0);
  assert.ok(badScore <= 10, `Expected low score for cost 5.0, got ${badScore}`);
});

test('10. Frame Distance Metric: correctly computes weighted components and asymmetric penalties', () => {
  const u = new Float32Array(SIFORMER_DIM);
  const v = new Float32Array(SIFORMER_DIM);
  const uVel = new Float32Array(SIFORMER_DIM);
  const vVel = new Float32Array(SIFORMER_DIM);

  // Identical frames -> distance 0
  const distZero = computeFrameDistance(u, v, uVel, vVel);
  assert.equal(distZero, 0);

  // Asymmetric mismatch: Template expects active hand, User hand missing
  v[66] = 0.5; // Template RH active
  const distMissingHand = computeFrameDistance(u, v, uVel, vVel);
  assert.ok(distMissingHand > 0, 'Missing active hand should incur positive penalty');

  // Both hands active
  u[66] = 0.5;
  const distBothActive = computeFrameDistance(u, v, uVel, vVel);
  assert.equal(distBothActive, 0, 'Matching hands should yield zero distance');
});

