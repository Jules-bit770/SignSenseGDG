import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const math = require('../SignSense/Main files/gesture_math.js');

test('Gesture Math Constants are properly defined', () => {
  assert.equal(math.FEATURE_DIM, 86);
  assert.equal(math.HAND_BLOCK, 43);
  assert.equal(math.MATCH_THRESHOLD, 60);
  assert.equal(math.GOOD_DTW_DISTANCE, 0.4);
  assert.equal(math.BAD_DTW_DISTANCE, 2.0);
});

test('extractFeature: extracts normalized landmarks for pose and hands', () => {
  const dummyResults = {
    poseLandmarks: [
      ...Array.from({ length: 11 }, () => ({ x: 0, y: 0 })),
      { x: 0.4, y: 0.5 }, // 11: left shoulder
      { x: 0.6, y: 0.5 }, // 12: right shoulder
    ],
    leftHandLandmarks: Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + i * 0.01, y: 0.4 + i * 0.01 })),
    rightHandLandmarks: Array.from({ length: 21 }, (_, i) => ({ x: 0.7 + i * 0.01, y: 0.4 + i * 0.01 }))
  };

  const feature = math.extractFeature(dummyResults);
  assert.equal(feature.length, 86);
  assert.equal(feature[0], 1, 'Left hand presence bit set');
  assert.equal(feature[math.HAND_BLOCK], 1, 'Right hand presence bit set');
});

test('extractFeature: handles missing pose gracefully', () => {
  const dummyResults = {
    poseLandmarks: null,
    leftHandLandmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })),
    rightHandLandmarks: null
  };

  const feature = math.extractFeature(dummyResults);
  assert.equal(feature.length, 86);
  assert.equal(feature[0], 1, 'Left hand present');
  assert.equal(feature[math.HAND_BLOCK], 0, 'Right hand absent');
});

test('handCount: accurately identifies number of visible hands', () => {
  const frame0 = new Float32Array(86);
  assert.equal(math.handCount(frame0), 0);

  const frame1 = new Float32Array(86);
  frame1[0] = 1.0;
  assert.equal(math.handCount(frame1), 1);

  const frame2 = new Float32Array(86);
  frame2[0] = 1.0;
  frame2[43] = 1.0;
  assert.equal(math.handCount(frame2), 2);
});

test('motionBetween: measures spatial delta between frames', () => {
  const f1 = new Float32Array(86);
  f1[0] = 1; f1[1] = 0.2; f1[2] = 0.3;
  const f2 = new Float32Array(86);
  f2[0] = 1; f2[1] = 0.2; f2[2] = 0.3;

  assert.equal(math.motionBetween(f1, f2), 0, 'No motion for identical positions');

  const f3 = new Float32Array(86);
  f3[0] = 1; f3[1] = 0.4; f3[2] = 0.5;
  const motion = math.motionBetween(f1, f3);
  assert.ok(motion > 0.1, `Motion detected: ${motion}`);
});

test('frameDistance: penalizes missing hands and computes accurate distance', () => {
  const f1 = new Float32Array(86);
  f1[0] = 1;
  const f2 = new Float32Array(86);
  f2[0] = 0; // Hand missing in f2

  const cost = math.frameDistance(f1, f2);
  assert.ok(cost >= 3.0, 'Missing hand penalty applied');

  const f3 = new Float32Array(86);
  f3[0] = 1;
  const exactCost = math.frameDistance(f1, f3);
  assert.equal(exactCost, 0, 'Zero cost for identical frames');
});

test('dtwDistance & confidence: identical gestures give 100% confidence', () => {
  const makeGesture = (len) => Array.from({ length: len }, (_, i) => {
    const f = new Float32Array(86);
    f[0] = 1;
    f[1] = i / len;
    f[2] = 0.5;
    return f;
  });

  const ref = makeGesture(20);
  const user = makeGesture(20);

  const distance = math.dtwDistance(user, ref);
  assert.equal(distance, 0);
  const conf = math.confidenceFromDistance(distance);
  assert.equal(conf, 100);
});

test('mirrorGesture: correctly flips coordinates for left-handed signers', () => {
  const frames = [new Float32Array(86)];
  frames[0][0] = 1; // Left hand present
  frames[0][1] = 0.5; // X
  frames[0][2] = 0.2; // Y

  const mirrored = math.mirrorGesture(frames);
  assert.equal(mirrored[0][0], 0, 'Left hand moved to right');
  assert.equal(mirrored[0][43], 1, 'Right hand present now');
  assert.ok(Math.abs(mirrored[0][44] - (-0.5)) < 1e-6, 'X inverted');
  assert.ok(Math.abs(mirrored[0][45] - 0.2) < 1e-6, 'Y preserved');
});

test('runDtwSelfCheck: executes internal validation suite and passes', () => {
  const passed = math.runDtwSelfCheck();
  assert.equal(passed, true, 'DTW self-check must pass');
});
