'use strict';

((root) => {
  const FEATURE_DIM = 86;
  const HAND_BLOCK = 43;
  const START_MOTION = 0.018;
  const CONTINUE_MOTION = 0.006;
  const QUIET_FRAMES_TO_FINISH = 10;
  const MAX_GESTURE_FRAMES = 150;
  const MATCH_THRESHOLD = 60;
  const GOOD_DTW_DISTANCE = 0.4;
  const BAD_DTW_DISTANCE = 2.0;

  function extractFeature(results) {
    const feature = new Float32Array(FEATURE_DIM);
    const pose = (results && results.poseLandmarks) || [];
    const shouldersVisible = pose[11] && pose[12];
    const neck = shouldersVisible
      ? { x: (pose[11].x + pose[12].x) / 2, y: (pose[11].y + pose[12].y) / 2 }
      : { x: 0.5, y: 0.5 };
    const shoulderWidth = shouldersVisible
      ? Math.max(0.08, Math.hypot(pose[11].x - pose[12].x, pose[11].y - pose[12].y))
      : 0.25;

    writeHandFeature(feature, 0, results && results.leftHandLandmarks, neck, shoulderWidth);
    writeHandFeature(feature, HAND_BLOCK, results && results.rightHandLandmarks, neck, shoulderWidth);
    return feature;
  }

  function writeHandFeature(target, offset, hand, neck, shoulderWidth) {
    if (!hand || hand.length !== 21) return;
    target[offset] = 1;
    for (let point = 0; point < 21; point++) {
      const destination = offset + 1 + point * 2;
      target[destination] = (hand[point].x - neck.x) / shoulderWidth;
      target[destination + 1] = (hand[point].y - neck.y) / shoulderWidth;
    }
  }

  function handCount(frame) {
    if (!frame) return 0;
    return Number(frame[0] > 0.5) + Number(frame[HAND_BLOCK] > 0.5);
  }

  function motionBetween(previous, current) {
    if (!previous || !current) return 0;
    let total = 0;
    let hands = 0;
    for (let hand = 0; hand < 2; hand++) {
      const offset = hand * HAND_BLOCK;
      if (previous[offset] < 0.5 || current[offset] < 0.5) continue;
      const wristMotion = Math.hypot(
        current[offset + 1] - previous[offset + 1],
        current[offset + 2] - previous[offset + 2]
      );
      let shapeMotion = 0;
      for (let value = offset + 3; value < offset + HAND_BLOCK; value++) {
        shapeMotion += Math.abs(current[value] - previous[value]);
      }
      total += wristMotion + (shapeMotion / 40) * 0.3;
      hands++;
    }
    return hands ? total / hands : 0;
  }

  function trimToGesture(frames) {
    if (!frames || frames.length < 8) return [];
    const moving = [];
    for (let index = 1; index < frames.length; index++) {
      if (handCount(frames[index - 1]) && handCount(frames[index]) &&
          motionBetween(frames[index - 1], frames[index]) > CONTINUE_MOTION) {
        moving.push(index);
      }
    }
    if (moving.length < 2) return [];
    const start = Math.max(0, moving[0] - 3);
    const end = Math.min(frames.length, moving[moving.length - 1] + 5);
    return frames.slice(start, end);
  }

  function isUsableGesture(frames) {
    if (!frames || frames.length < 8) return false;
    const visibleFrames = frames.filter(frame => handCount(frame) > 0).length;
    if (visibleFrames / frames.length < 0.6) return false;
    let totalMotion = 0;
    for (let index = 1; index < frames.length; index++) {
      totalMotion += motionBetween(frames[index - 1], frames[index]);
    }
    return totalMotion > 0.05;
  }

  function frameDistance(left, right) {
    let cost = 0;
    let comparedHands = 0;
    for (let hand = 0; hand < 2; hand++) {
      const offset = hand * HAND_BLOCK;
      const leftPresent = left[offset] > 0.5;
      const rightPresent = right[offset] > 0.5;
      if (!leftPresent && !rightPresent) continue;
      comparedHands++;
      if (leftPresent !== rightPresent) {
        cost += 3.0;
        continue;
      }

      const wristX = left[offset + 1] - right[offset + 1];
      const wristY = left[offset + 2] - right[offset + 2];
      const wristDistance = Math.hypot(wristX, wristY);
      let shapeCost = 0;
      for (let point = 1; point < 21; point++) {
        const coordinate = offset + 1 + point * 2;
        const leftRelativeX = left[coordinate] - left[offset + 1];
        const leftRelativeY = left[coordinate + 1] - left[offset + 2];
        const rightRelativeX = right[coordinate] - right[offset + 1];
        const rightRelativeY = right[coordinate + 1] - right[offset + 2];
        const differenceX = leftRelativeX - rightRelativeX;
        const differenceY = leftRelativeY - rightRelativeY;
        shapeCost += differenceX * differenceX + differenceY * differenceY;
      }
      const shapeDistance = Math.sqrt(shapeCost / 40);
      cost += shapeDistance * 0.75 + wristDistance * 0.25;
    }
    return comparedHands ? cost / comparedHands : 5;
  }

  function limitFrames(frames, maximum = 100) {
    if (!frames || frames.length <= maximum) return frames || [];
    return Array.from({ length: maximum }, (_, index) =>
      frames[Math.round(index * (frames.length - 1) / (maximum - 1))]
    );
  }

  function dtwDistance(userFrames, templateFrames) {
    const user = limitFrames(userFrames);
    const template = limitFrames(templateFrames);
    const rows = user.length;
    const columns = template.length;
    if (!rows || !columns) return Infinity;

    const costs = Array.from({ length: rows + 1 }, () => new Float64Array(columns + 1).fill(Infinity));
    const steps = Array.from({ length: rows + 1 }, () => new Uint16Array(columns + 1));
    costs[0][0] = 0;

    for (let row = 1; row <= rows; row++) {
      for (let column = 1; column <= columns; column++) {
        if (Math.abs(row / rows - column / columns) > 0.35) continue;
        const localCost = frameDistance(user[row - 1], template[column - 1]);
        const diagonal = costs[row - 1][column - 1];
        const vertical = costs[row - 1][column] + 0.06;
        const horizontal = costs[row][column - 1] + 0.06;
        if (diagonal <= vertical && diagonal <= horizontal) {
          costs[row][column] = localCost + diagonal;
          steps[row][column] = steps[row - 1][column - 1] + 1;
        } else if (vertical <= horizontal) {
          costs[row][column] = localCost + vertical;
          steps[row][column] = steps[row - 1][column] + 1;
        } else {
          costs[row][column] = localCost + horizontal;
          steps[row][column] = steps[row][column - 1] + 1;
        }
      }
    }
    return costs[rows][columns] / Math.max(1, steps[rows][columns]);
  }

  function mirrorGesture(frames) {
    if (!frames) return [];
    return frames.map(frame => {
      const mirrored = new Float32Array(FEATURE_DIM);
      for (let destinationHand = 0; destinationHand < 2; destinationHand++) {
        const sourceOffset = (1 - destinationHand) * HAND_BLOCK;
        const destinationOffset = destinationHand * HAND_BLOCK;
        mirrored[destinationOffset] = frame[sourceOffset];
        mirrored[destinationOffset + 1] = -frame[sourceOffset + 1];
        mirrored[destinationOffset + 2] = frame[sourceOffset + 2];
        for (let point = 0; point < 20; point++) {
          const source = sourceOffset + 3 + point * 2;
          const destination = destinationOffset + 3 + point * 2;
          mirrored[destination] = -frame[source];
          mirrored[destination + 1] = frame[source + 1];
        }
      }
      return mirrored;
    });
  }

  function confidenceFromDistance(distance) {
    if (!Number.isFinite(distance)) return 0;
    const normalized = (BAD_DTW_DISTANCE - distance) / (BAD_DTW_DISTANCE - GOOD_DTW_DISTANCE);
    return Math.round(Math.max(0, Math.min(1, normalized)) * 100);
  }

  function compareSyntheticIdle(templateFrames) {
    const idle = Array.from({ length: 60 }, () => new Float32Array(FEATURE_DIM));
    return !isUsableGesture(trimToGesture(idle)) && templateFrames && templateFrames.length > 0;
  }

  function runDtwSelfCheck() {
    const makeFrame = progress => {
      const frame = new Float32Array(FEATURE_DIM);
      frame[0] = 1;
      frame[1] = progress;
      frame[2] = -0.4 + progress * 0.2;
      for (let value = 3; value < HAND_BLOCK; value++) {
        frame[value] = Math.sin(progress * Math.PI + value * 0.05) * 0.25;
      }
      return frame;
    };
    const referenceFrames = Array.from({ length: 30 }, (_, index) => makeFrame(index / 29));
    const slowFrames = Array.from({ length: 75 }, (_, index) => makeFrame(index / 74));
    const wrongFrames = Array.from({ length: 30 }, (_, index) => {
      const frame = makeFrame(index / 29);
      frame[1] += 3;
      frame[2] += 2;
      for (let point = 1; point < 21; point++) {
        const coordinate = 1 + point * 2;
        frame[coordinate] = frame[1] + (point % 2 ? 4 : -4);
        frame[coordinate + 1] = frame[2] + (point % 3 ? 3 : -3);
      }
      return frame;
    });
    const same = confidenceFromDistance(dtwDistance(referenceFrames, referenceFrames));
    const slow = confidenceFromDistance(dtwDistance(slowFrames, referenceFrames));
    const wrong = confidenceFromDistance(dtwDistance(wrongFrames, referenceFrames));
    const idleRejected = compareSyntheticIdle(referenceFrames);
    const passed = same >= 99 && slow >= 70 && wrong < MATCH_THRESHOLD && idleRejected;
    return passed;
  }

  const exportObj = {
    FEATURE_DIM,
    HAND_BLOCK,
    START_MOTION,
    CONTINUE_MOTION,
    QUIET_FRAMES_TO_FINISH,
    MAX_GESTURE_FRAMES,
    MATCH_THRESHOLD,
    GOOD_DTW_DISTANCE,
    BAD_DTW_DISTANCE,
    extractFeature,
    writeHandFeature,
    handCount,
    motionBetween,
    trimToGesture,
    isUsableGesture,
    frameDistance,
    limitFrames,
    dtwDistance,
    mirrorGesture,
    confidenceFromDistance,
    compareSyntheticIdle,
    runDtwSelfCheck
  };

  if (typeof window !== 'undefined') {
    window.SignSenseGestureMath = exportObj;
    Object.assign(window, exportObj);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportObj;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
