"use strict";
var SignSenseDtw = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/services/dtw/index.ts
  var index_exports = {};
  __export(index_exports, {
    ANCHOR_DIM: () => ANCHOR_DIM,
    EARLY_ABANDON_ROW_THRESHOLD: () => EARLY_ABANDON_ROW_THRESHOLD,
    HAND_DIM: () => HAND_DIM,
    KINETIC_ENERGY_THRESHOLD: () => KINETIC_ENERGY_THRESHOLD,
    MATRIX_SIZE: () => MATRIX_SIZE,
    MATRIX_STRIDE: () => MATRIX_STRIDE,
    PASSING_THRESHOLD: () => PASSING_THRESHOLD,
    SAKOE_CHIBA_WINDOW: () => SAKOE_CHIBA_WINDOW,
    SIFORMER_DIM: () => SIFORMER_DIM,
    SUBMETRIC_THRESHOLD: () => SUBMETRIC_THRESHOLD,
    TARGET_SEQUENCE_LENGTH: () => TARGET_SEQUENCE_LENGTH,
    TORSO_DIM: () => TORSO_DIM,
    alignDdtw: () => alignDdtw,
    calculateKineticEnergy: () => calculateKineticEnergy,
    computeFrameDistance: () => computeFrameDistance,
    computeVelocities: () => computeVelocities,
    evaluateScoring: () => evaluateScoring,
    extractSiformer112: () => extractSiformer112,
    extractSubmetricCosts: () => extractSubmetricCosts,
    isHandActive: () => isHandActive,
    matchGesture: () => matchGesture,
    performBilateralSwap: () => performBilateralSwap,
    preprocessTemplate: () => preprocessTemplate,
    resampleSequence: () => resampleSequence,
    sigmoidScore: () => sigmoidScore,
    trimRestingFrames: () => trimRestingFrames
  });

  // src/services/dtw/siformer.ts
  var SIFORMER_DIM = 112;
  var TORSO_DIM = 24;
  var HAND_DIM = 42;
  var ANCHOR_DIM = 4;
  var TARGET_SEQUENCE_LENGTH = 30;
  var POSE_KEY_INDICES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16];
  function extractSiformer112(results, outTarget, prevFeature, outVelocity) {
    outTarget.fill(0);
    const pose = results?.poseLandmarks;
    const leftHand = results?.leftHandLandmarks;
    const rightHand = results?.rightHandLandmarks;
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
    const minTorsoX = -3;
    const maxTorsoX = 3;
    const minTorsoY = (eyeY - 5 * H - neckY) / H;
    const maxTorsoY = (eyeY + H - neckY) / H;
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
          outTarget[outIdx] = 0;
          outTarget[outIdx + 1] = 0;
        }
      }
      outTarget[22] = 0;
      outTarget[23] = 0;
    }
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
      const S = Math.max(5e-3, Math.max(spanX, spanY) * 1.1);
      const boxMidX = (minX + maxX) * 0.5;
      const boxMidY = (minY + maxY) * 0.5;
      for (let i = 0; i < 21; i++) {
        const pt = leftHand[i];
        const targetOffset = 24 + i * 2;
        outTarget[targetOffset] = (pt.x - boxMidX) / S;
        outTarget[targetOffset + 1] = (pt.y - boxMidY) / S;
      }
    }
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
      const S = Math.max(5e-3, Math.max(spanX, spanY) * 1.1);
      const boxMidX = (minX + maxX) * 0.5;
      const boxMidY = (minY + maxY) * 0.5;
      for (let i = 0; i < 21; i++) {
        const pt = rightHand[i];
        const targetOffset = 66 + i * 2;
        outTarget[targetOffset] = (pt.x - boxMidX) / S;
        outTarget[targetOffset + 1] = (pt.y - boxMidY) / S;
      }
    }
    outTarget[108] = lhActive ? (lhCenterX - neckX) / H : 0;
    outTarget[109] = lhActive ? (lhCenterY - neckY) / H : 0;
    outTarget[110] = rhActive ? (rhCenterX - neckX) / H : 0;
    outTarget[111] = rhActive ? (rhCenterY - neckY) / H : 0;
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
  function isHandActive(feature) {
    return feature[24] !== 0 || feature[25] !== 0 || feature[66] !== 0 || feature[67] !== 0;
  }
  function trimRestingFrames(frames) {
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
  function resampleSequence(source, targetBuffer, targetCount = TARGET_SEQUENCE_LENGTH) {
    const n = source.length;
    if (n === 0) return 0;
    if (n === 1) {
      for (let i = 0; i < targetCount; i++) {
        targetBuffer[i].set(source[0]);
      }
      return targetCount;
    }
    for (let i = 0; i < targetCount; i++) {
      const norm = i / (targetCount - 1) * (n - 1);
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

  // src/services/dtw/scoring.ts
  var KINETIC_ENERGY_THRESHOLD = 0.04;
  var PASSING_THRESHOLD = 52;
  var SUBMETRIC_THRESHOLD = 50;
  function calculateKineticEnergy(frames) {
    if (frames.length < 2) return 0;
    let totalEnergy = 0;
    for (let t = 1; t < frames.length; t++) {
      const prev = frames[t - 1];
      const curr = frames[t];
      const lwDx = curr[18] - prev[18];
      const lwDy = curr[19] - prev[19];
      const lwDist = Math.sqrt(lwDx * lwDx + lwDy * lwDy);
      const rwDx = curr[20] - prev[20];
      const rwDy = curr[21] - prev[21];
      const rwDist = Math.sqrt(rwDx * rwDx + rwDy * rwDy);
      const laDx = curr[108] - prev[108];
      const laDy = curr[109] - prev[109];
      const laDist = Math.sqrt(laDx * laDx + laDy * laDy);
      const raDx = curr[110] - prev[110];
      const raDy = curr[111] - prev[111];
      const raDist = Math.sqrt(raDx * raDx + raDy * raDy);
      totalEnergy += Math.max(lwDist, laDist) + Math.max(rwDist, raDist);
    }
    return totalEnergy;
  }
  function sigmoidScore(avgCost) {
    if (!Number.isFinite(avgCost) || avgCost < 0) return 0;
    const raw = 100 / (1 + Math.exp(1.75 * (avgCost - 2.2)));
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
  function evaluateScoring(avgCost, handCost, pathCost, kineticEnergy, templateRequiresMovement = true, competitors) {
    if (templateRequiresMovement && kineticEnergy < KINETIC_ENERGY_THRESHOLD) {
      return {
        score: 0,
        passed: false,
        status: "IDLE_STATIONARY",
        handshapeScore: 0,
        spatialPathScore: 0,
        feedback: "Movement required. Please perform the sign trajectory rather than holding still."
      };
    }
    let baseScore = sigmoidScore(avgCost);
    const handshapeScore = sigmoidScore(handCost);
    const spatialPathScore = sigmoidScore(pathCost);
    if (competitors && competitors.length > 0) {
      let topCompetitorScore = -1;
      let topCompetitorName = "";
      for (const comp of competitors) {
        if (comp.score > topCompetitorScore) {
          topCompetitorScore = comp.score;
          topCompetitorName = comp.signName;
        }
      }
      if (baseScore - topCompetitorScore >= 8) {
        baseScore = Math.min(100, baseScore + 8);
      }
      if (baseScore < 45 && topCompetitorScore >= 65 && topCompetitorScore - baseScore > 25) {
        return {
          score: baseScore,
          passed: false,
          status: "DIFFERENT_SIGN",
          handshapeScore,
          spatialPathScore,
          feedback: `Did you mean: ${topCompetitorName}?`,
          disambiguation: topCompetitorName
        };
      }
    }
    const passedBase = baseScore >= PASSING_THRESHOLD;
    const passedHand = handshapeScore >= SUBMETRIC_THRESHOLD;
    const passedPath = spatialPathScore >= SUBMETRIC_THRESHOLD;
    const fullyPassed = passedBase && passedHand && passedPath;
    let feedback = "Try matching the hand shape and movement path.";
    if (fullyPassed) {
      feedback = "Sign achieved. Beautifully done!";
    } else if (passedPath && !passedHand) {
      feedback = "Movement path correct, but check your hand shape.";
    } else if (passedHand && !passedPath) {
      feedback = "Hand shape correct, but follow the movement path.";
    }
    return {
      score: baseScore,
      passed: fullyPassed,
      status: fullyPassed ? "MATCH" : baseScore >= 35 ? "UNCERTAIN" : "DIFFERENT_SIGN",
      handshapeScore,
      spatialPathScore,
      feedback
    };
  }

  // src/services/dtw/matcher.ts
  var MATRIX_STRIDE = 32;
  var MATRIX_SIZE = MATRIX_STRIDE * MATRIX_STRIDE;
  var SAKOE_CHIBA_WINDOW = 8;
  var EARLY_ABANDON_ROW_THRESHOLD = 3.2;
  var BufferPool = class {
    costMatrix = new Float32Array(MATRIX_SIZE);
    userDecimated = Array.from(
      { length: TARGET_SEQUENCE_LENGTH },
      () => new Float32Array(SIFORMER_DIM)
    );
    userSwapped = Array.from(
      { length: TARGET_SEQUENCE_LENGTH },
      () => new Float32Array(SIFORMER_DIM)
    );
    userVelocity = Array.from(
      { length: TARGET_SEQUENCE_LENGTH },
      () => new Float32Array(SIFORMER_DIM)
    );
    swappedVelocity = Array.from(
      { length: TARGET_SEQUENCE_LENGTH },
      () => new Float32Array(SIFORMER_DIM)
    );
    // Traceback steps: pathI and pathJ stored in Uint8Array(64)
    tracebackI = new Uint8Array(64);
    tracebackJ = new Uint8Array(64);
    submetricComponents = new Float32Array(2);
  };
  var POOL = new BufferPool();
  function computeFrameDistance(u, v, uVel, vVel, outComponents) {
    let dTorso = 0;
    for (let k = 0; k < 24; k++) {
      const diff = u[k] - v[k];
      dTorso += diff * diff;
    }
    dTorso *= 0.5;
    const uLhActive = u[24] !== 0 || u[25] !== 0;
    const vLhActive = v[24] !== 0 || v[25] !== 0;
    const uRhActive = u[66] !== 0 || u[67] !== 0;
    const vRhActive = v[66] !== 0 || v[67] !== 0;
    let dHands = 0;
    if (uLhActive && vLhActive) {
      let lhDiff = 0;
      for (let k = 24; k < 66; k++) {
        const diff = u[k] - v[k];
        lhDiff += diff * diff;
      }
      dHands += 1.3 * lhDiff;
    } else if (uLhActive !== vLhActive) {
      dHands += 0.75;
    }
    if (uRhActive && vRhActive) {
      let rhDiff = 0;
      for (let k = 66; k < 108; k++) {
        const diff = u[k] - v[k];
        rhDiff += diff * diff;
      }
      dHands += 1.3 * rhDiff;
    } else if (uRhActive !== vRhActive) {
      dHands += 0.75;
    }
    let dAnchorSpatial = 0;
    for (let k = 108; k < 112; k++) {
      const diff = u[k] - v[k];
      dAnchorSpatial += diff * diff;
    }
    dAnchorSpatial *= 1.4;
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
  function computeVelocities(frames, outVelocities, count) {
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
  function preprocessTemplate(signName, rawFrames) {
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
  function performBilateralSwap(sourceFrames, swappedFrames, count) {
    for (let t = 0; t < count; t++) {
      const src = sourceFrames[t];
      const dst = swappedFrames[t];
      for (let k = 0; k < 24; k++) {
        dst[k] = src[k];
      }
      for (let k = 0; k < 42; k++) {
        dst[24 + k] = src[66 + k];
        dst[66 + k] = src[24 + k];
      }
      dst[108] = -src[110];
      dst[109] = src[111];
      dst[110] = -src[108];
      dst[111] = src[109];
    }
  }
  function alignDdtw(user, userVel, userLen, template, templateVel, templateLen, outMatrix) {
    const N = Math.min(30, userLen);
    const M = Math.min(30, templateLen);
    if (N === 0 || M === 0) {
      return { avgCost: Infinity, bestJ: M, earlyAbandoned: true };
    }
    outMatrix.fill(Infinity);
    outMatrix[0] = 0;
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
      if (rowMin / i > EARLY_ABANDON_ROW_THRESHOLD) {
        return { avgCost: Infinity, bestJ: M, earlyAbandoned: true };
      }
    }
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
  function extractSubmetricCosts(user, userVel, N, template, templateVel, bestJ, matrix) {
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
  function matchGesture(userFrames, template, competitors) {
    const userCount = resampleSequence(userFrames, POOL.userDecimated, TARGET_SEQUENCE_LENGTH);
    computeVelocities(POOL.userDecimated, POOL.userVelocity, userCount);
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
  return __toCommonJS(index_exports);
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = SignSenseDtw; } if (typeof window !== 'undefined') { window.SignSenseDtw = SignSenseDtw; }
