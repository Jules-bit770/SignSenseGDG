const EXERCISES = {
  1: ['BYE', 'HELLO', 'HOW ARE YOU', 'NO', 'OKAY', 'PLEASE', 'SORRY', 'STOP', 'THANK YOU', 'YES', 'MY1', 'MY2', 'NAME1', 'NAME2'],
  2: ['AT', 'BAD', 'GOOD', 'HOW', 'I', 'LOVE', 'WHAT', 'WHEN', 'WHERE', 'WHICH', 'WHO', 'WHY', 'YOU'],
  3: ['BABY', 'BROTHER', 'FAMILY', 'FATHER', 'FRIEND', 'MOTHER', 'PERSON', 'SCHOOL', 'SISTER']
};

const SOURCES = {
  BYE: 'bye.mp4', HELLO: 'hello.mp4', 'HOW ARE YOU': 'how_are_you.mp4', NO: 'No.mp4',
  OKAY: 'okay.mp4', PLEASE: 'please.mp4', SORRY: 'sorry.mp4', STOP: 'stop.mp4',
  'THANK YOU': 'thank_you.mp4', YES: 'Yes.mp4', MY1: 'my1.mp4', MY2: 'my2.mp4',
  NAME1: 'name1.mp4', NAME2: 'name2.mp4', AT: 'at.mp4', BAD: 'bad.mp4', GOOD: 'good.mp4',
  HOW: 'how.mp4', I: 'I.mp4', LOVE: 'love.mp4', WHAT: 'what.mp4', WHEN: 'when.mp4',
  WHERE: 'where.mp4', WHICH: 'which.mp4', WHO: 'who.mp4', WHY: 'why.mp4', YOU: 'you.mp4',
  BABY: 'baby.mp4', BROTHER: 'brother.mp4', FAMILY: 'family.mp4', FATHER: 'father.mp4',
  FRIEND: 'friend.mp4', MOTHER: 'mother.mp4', PERSON: 'person.mp4', SCHOOL: 'school.mp4',
  SISTER: 'sister.mp4'
};

const FEATURE_DIM = 86;
const HAND_BLOCK = 43;
const START_MOTION = 0.018;
const CONTINUE_MOTION = 0.006;
const QUIET_FRAMES_TO_FINISH = 10;
const MAX_GESTURE_FRAMES = 150;
const MATCH_THRESHOLD = 60;
const GOOD_DTW_DISTANCE = 0.4;
const BAD_DTW_DISTANCE = 2.0;
const $ = id => document.getElementById(id);

const query = new URLSearchParams(location.search);
const exerciseNumber = EXERCISES[Number(query.get('exercise'))] ? Number(query.get('exercise')) : 1;
const signs = EXERCISES[exerciseNumber] || EXERCISES[1];
const camera = $('camera');
const reference = $('reference');
const referenceProcessor = document.createElement('video');
referenceProcessor.muted = true;
referenceProcessor.playsInline = true;
referenceProcessor.preload = 'auto';
const canvas = $('canvas');
const canvasContext = canvas.getContext('2d');

let signIndex = 0;
let referenceTemplate = null;
let referenceBuildId = 0;
const referenceTemplateCache = new Map();
let cameraStream = null;
let cameraLoopBusy = false;
let cameraFrameCounter = 0;
let matcherReady = false;
let bestScores = SignSenseProgress.read()[exerciseNumber] || {};
if (typeof bestScores !== 'object' || Array.isArray(bestScores)) bestScores = {};
const firstUnachieved = signs.findIndex(sign => !(bestScores[sign] > MATCH_THRESHOLD));
if (firstUnachieved >= 0) signIndex = firstUnachieved;
const celebratedSigns = new Set();
let celebrationTimer;

let previousFrame = null;
let preRoll = [];
let gestureFrames = [];
let signing = false;
let startMotionStreak = 0;
let quietFrameCount = 0;

$('exercise-label').textContent = `EXERCISE ${exerciseNumber}`;

function extractFeature(results) {
  const feature = new Float32Array(FEATURE_DIM);
  const pose = results.poseLandmarks || [];
  const shouldersVisible = pose[11] && pose[12];
  const neck = shouldersVisible
    ? { x: (pose[11].x + pose[12].x) / 2, y: (pose[11].y + pose[12].y) / 2 }
    : { x: 0.5, y: 0.5 };
  const shoulderWidth = shouldersVisible
    ? Math.max(0.08, Math.hypot(pose[11].x - pose[12].x, pose[11].y - pose[12].y))
    : 0.25;

  writeHandFeature(feature, 0, results.leftHandLandmarks, neck, shoulderWidth);
  writeHandFeature(feature, HAND_BLOCK, results.rightHandLandmarks, neck, shoulderWidth);
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
  if (frames.length < 8) return [];
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
  if (frames.length < 8) return false;
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
  if (frames.length <= maximum) return frames;
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

function compareGesture(candidate) {
  const trimmed = trimToGesture(candidate);
  if (!isUsableGesture(trimmed) || !referenceTemplate) return null;
  const normalDistance = dtwDistance(trimmed, referenceTemplate);
  const mirroredDistance = dtwDistance(mirrorGesture(trimmed), referenceTemplate);
  const bestDistance = Math.min(normalDistance, mirroredDistance);
  const confidence = confidenceFromDistance(bestDistance);
  const diagnostic = `${signs[signIndex]} · user ${trimmed.length}f / ref ${referenceTemplate.length}f · normal ${normalDistance.toFixed(3)} · mirrored ${mirroredDistance.toFixed(3)} · best ${bestDistance.toFixed(3)}`;
  console.info(`[DTW] ${diagnostic} · confidence ${confidence}%`);
  $('dtw-debug').textContent = diagnostic;
  return confidence;
}

function runDtwSelfCheck() {
  const makeFrame = progress => {
    const frame = new Float32Array(FEATURE_DIM);
    frame[0] = 1;
    frame[1] = progress;
    frame[2] = -0.4 + progress * 0.2;
    for (let value = 3; value < HAND_BLOCK; value++) frame[value] = Math.sin(progress * Math.PI + value * 0.05) * 0.25;
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
  console.info(`DTW self-check: same=${same}%, slow=${slow}%, wrong=${wrong}%, idleRejected=${idleRejected}`);
  return passed;
}

function compareSyntheticIdle(templateFrames) {
  const idle = Array.from({ length: 60 }, () => new Float32Array(FEATURE_DIM));
  return !isUsableGesture(trimToGesture(idle)) && templateFrames.length > 0;
}

const dtwSelfCheckPassed = runDtwSelfCheck();

function resetGestureDetector() {
  previousFrame = null;
  preRoll = [];
  gestureFrames = [];
  signing = false;
  startMotionStreak = 0;
  quietFrameCount = 0;
  if (cameraStream) $('camera-state').textContent = 'Waiting for movement…';
}

function processCameraResult(results) {
  drawCameraLandmarks(results);
  if (!matcherReady || !cameraStream) return;

  const currentFrame = extractFeature(results);
  const handsVisible = handCount(currentFrame) > 0;
  const motion = motionBetween(previousFrame, currentFrame);

  preRoll.push(currentFrame);
  if (preRoll.length > 6) preRoll.shift();

  if (!signing) {
    startMotionStreak = handsVisible && motion > START_MOTION ? startMotionStreak + 1 : 0;
    if (startMotionStreak >= 2) {
      signing = true;
      gestureFrames = preRoll.slice();
      quietFrameCount = 0;
      $('camera-state').textContent = 'Signing detected…';
      $('score-label').textContent = 'Analysing current attempt';
    }
  } else {
    gestureFrames.push(currentFrame);
    quietFrameCount = handsVisible && motion > CONTINUE_MOTION ? 0 : quietFrameCount + 1;
    if (quietFrameCount >= QUIET_FRAMES_TO_FINISH || gestureFrames.length >= MAX_GESTURE_FRAMES) {
      finishDetectedGesture();
    }
  }
  previousFrame = currentFrame;
}

function finishDetectedGesture() {
  const tailToRemove = Math.max(0, quietFrameCount - 2);
  const completed = tailToRemove ? gestureFrames.slice(0, -tailToRemove) : gestureFrames.slice();
  const confidence = compareGesture(completed);
  if (confidence === null) {
    $('camera-state').textContent = 'Movement was too short — try again';
  } else {
    showCompletedScore(confidence);
  }
  previousFrame = null;
  preRoll = [];
  gestureFrames = [];
  signing = false;
  startMotionStreak = 0;
  quietFrameCount = 0;
}

function showCompletedScore(confidence) {
  const sign = signs[signIndex];
  updateAchievement(confidence, true);
  $('score-label').textContent = `Last completed ${sign} attempt`;
  $('score').textContent = `${confidence}%`;
  $('bar').style.width = `${confidence}%`;
  $('camera-state').textContent = confidence > MATCH_THRESHOLD ? `Matched ${sign}: ${confidence}%` : `Not matched — try ${sign} again: ${confidence}%`;
  if (bestScores[sign] === undefined || confidence > bestScores[sign]) {
    bestScores[sign] = confidence;
    SignSenseProgress.save(exerciseNumber, bestScores);
    renderSignList();
  }
}

function updateAchievement(confidence, celebrate = false) {
  const matched = confidence > MATCH_THRESHOLD;
  $('score-card').classList.toggle('success', matched);
  $('camera-panel').classList.toggle('success', matched);
  $('confidence-meter').setAttribute('aria-valuenow', confidence || 0);
  $('achievement-title').textContent = matched ? 'Sign achieved. Beautifully done!' : confidence == null ? "Give it a try. You've got this." : 'Every attempt is a step forward.';
  $('achievement-message').textContent = matched ? 'A new connection, earned. Keep going when you\u2019re ready.' : confidence == null ? 'Watch the sign, copy the movement, then pause.' : 'Try matching the hand shape and movement in the reference.';
  if (matched && celebrate && !celebratedSigns.has(signs[signIndex])) {
    celebratedSigns.add(signs[signIndex]);
    $('score-card').classList.add('celebrate');
    const colours = ['#3269e8', '#218451', '#f7c948', '#e45c50'];
    $('confetti').replaceChildren(...Array.from({length: 32}, (_, i) => {
      const piece = document.createElement('i');
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--c', colours[i % 4]);
      piece.style.setProperty('--delay', `${Math.random() * .4}s`);
      return piece;
    }));
    clearTimeout(celebrationTimer);
    celebrationTimer = setTimeout(() => { $('confetti').replaceChildren(); $('score-card').classList.remove('celebrate'); }, 2300);
  }
}

function drawCameraLandmarks(results) {
  canvasContext.clearRect(0, 0, canvas.width, canvas.height);
  for (const [hand, colour] of [[results.leftHandLandmarks, '#38bdf8'], [results.rightHandLandmarks, '#36d399']]) {
    if (!hand) continue;
    drawConnectors(canvasContext, hand, HAND_CONNECTIONS, { color: colour, lineWidth: 2 });
    drawLandmarks(canvasContext, hand, { color: colour, radius: 2 });
  }
}

const userHolistic = new Holistic({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}` });
userHolistic.setOptions({
  modelComplexity: 0,
  smoothLandmarks: true,
  enableSegmentation: false,
  refineFaceLandmarks: false,
  minDetectionConfidence: 0.55,
  minTrackingConfidence: 0.55
});
userHolistic.onResults(processCameraResult);

let referenceFrameCollector = null;
const referenceHolistic = new Holistic({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}` });
referenceHolistic.setOptions({
  modelComplexity: 0,
  smoothLandmarks: false,
  enableSegmentation: false,
  refineFaceLandmarks: false,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});
referenceHolistic.onResults(results => {
  if (referenceFrameCollector) referenceFrameCollector.push(extractFeature(results));
});

function waitForVideoMetadata(video) {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Reference video could not be read.')), { once: true });
  });
}

function rewindVideo(video) {
  if (video.currentTime < 0.01) return Promise.resolve();
  return new Promise((resolve, reject) => {
    video.addEventListener('seeked', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Reference video could not be rewound.')), { once: true });
    video.currentTime = 0;
  });
}

function waitForDecodedVideoFrame(video) {
  if (typeof video.requestVideoFrameCallback === 'function') {
    return new Promise(resolve => {
      let finished = false;
      const fallback = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve({ mediaTime: video.currentTime });
      }, 500);
      video.requestVideoFrameCallback((_, metadata) => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        resolve(metadata);
      });
    });
  }
  return new Promise(resolve => {
    setTimeout(() => resolve({ mediaTime: video.currentTime }), 50);
  });
}

async function seekToDecodedFrame(video, time) {
  const safeTime = Math.max(0.001, Math.min(time, video.duration - 0.001));
  const decodedFrame = waitForDecodedVideoFrame(video);
  const seekFinished = new Promise((resolve, reject) => {
    video.addEventListener('seeked', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Reference frame seek failed.')), { once: true });
  });
  video.currentTime = safeTime;
  await seekFinished;
  await decodedFrame;
}

async function extractSequentialReferenceFrames(video, buildId) {
  const collected = [];
  const sampleRate = 15;
  const step = 1 / sampleRate;
  video.pause();
  video.loop = false;
  await rewindVideo(video);
  referenceFrameCollector = collected;

  try {
    for (let time = step / 2; time < video.duration; time += step) {
      if (buildId !== referenceBuildId) break;
      await seekToDecodedFrame(video, time);
      await referenceHolistic.send({ image: video });
      const detected = collected.filter(frame => handCount(frame) > 0).length;
      $('template-state').textContent = `Reading video… ${collected.length} frames, ${detected} with hands`;
    }
  } finally {
    referenceFrameCollector = null;
    video.pause();
    video.loop = true;
  }
  return collected;
}

async function buildReferenceTemplate() {
  const buildId = ++referenceBuildId;
  matcherReady = false;
  referenceTemplate = null;
  resetGestureDetector();
  $('next-btn').disabled = true;
  $('template-state').textContent = 'Building movement template…';

  const sign = signs[signIndex];
  const filename = SOURCES[sign];
  if (!filename) throw new Error(`No reference filename is configured for ${sign}.`);
  const sourceUrl = `dynamic_signs/${filename}`;
  reference.src = sourceUrl;
  reference.play().catch(() => {});
  if (referenceTemplateCache.has(sign)) {
    referenceTemplate = referenceTemplateCache.get(sign);
    matcherReady = true;
    $('template-state').textContent = `DTW ready · ${referenceTemplate.length} cached motion frames`;
    $('next-btn').disabled = false;
    $('status').textContent = 'Start the camera, then perform the sign at your own speed. Scoring happens when your movement ends.';
    reference.currentTime = 0;
    reference.play().catch(() => {});
    resetGestureDetector();
    return;
  }

  referenceProcessor.src = sourceUrl;
  referenceProcessor.load();
  await waitForVideoMetadata(referenceProcessor);
  const collected = await extractSequentialReferenceFrames(referenceProcessor, buildId);

  if (buildId !== referenceBuildId) return;
  const trimmed = trimToGesture(collected);
  if (!isUsableGesture(trimmed)) {
    const detected = collected.filter(frame => handCount(frame) > 0).length;
    throw new Error(`Reference tracking failed: ${detected}/${collected.length} decoded frames contained hands.`);
  }
  if (!dtwSelfCheckPassed) throw new Error('The DTW self-check failed.');

  referenceTemplate = trimmed;
  referenceTemplateCache.set(sign, trimmed);
  const detectedFrames = collected.filter(frame => handCount(frame) > 0).length;
  console.info(`[REFERENCE] ${sign}: ${trimmed.length} motion frames from ${collected.length} decoded frames (${detectedFrames} with hands)`);
  console.info(`[REFERENCE] first hands=${handCount(trimmed[0])}, middle hands=${handCount(trimmed[Math.floor(trimmed.length / 2)])}, last hands=${handCount(trimmed[trimmed.length - 1])}`);
  matcherReady = true;
  $('template-state').textContent = `DTW ready · ${trimmed.length} motion frames`;
  $('next-btn').disabled = false;
  $('status').textContent = 'Start the camera, then perform the sign at your own speed. Scoring happens when your movement ends.';
  resetGestureDetector();
}

function renderSignList() {
  $('lesson-progress').textContent = `${signs.filter(sign => bestScores[sign] > MATCH_THRESHOLD).length} / ${signs.length} signs achieved`;
  $('items').innerHTML = signs.map((sign, index) => {
    const classes = ['item'];
    if (index === signIndex) classes.push('current');
    if (bestScores[sign] > MATCH_THRESHOLD) classes.push('done');
    const value = bestScores[sign] === undefined ? '—' : `${bestScores[sign]}%`;
    return `<div class="${classes.join(' ')}"><span>${sign}</span><b>${value}</b></div>`;
  }).join('');
}

async function showCurrentSign() {
  const sign = signs[signIndex];
  $('sign-title').textContent = `${sign} · ${signIndex + 1} of ${signs.length}`;
  clearTimeout(celebrationTimer);
  $('confetti').replaceChildren();
  $('score-card').classList.remove('celebrate');
  updateAchievement(bestScores[sign]);
  $('next-btn').textContent = signIndex === signs.length - 1 ? 'Back to islands \u2192' : 'Next sign \u2192';
  $('score-label').textContent = 'Your best attempt';
  $('score').textContent = bestScores[sign] === undefined ? '—' : `${bestScores[sign]}%`;
  $('bar').style.width = `${bestScores[sign] || 0}%`;
  renderSignList();
  try {
    await buildReferenceTemplate();
  } catch (error) {
    matcherReady = false;
    referenceTemplate = null;
    $('template-state').textContent = 'DTW unavailable for this sign';
    $('status').textContent = `${error.message} You can still watch the reference and continue to the next sign.`;
    $('next-btn').disabled = false;
    reference.play().catch(() => {});
    resetGestureDetector();
    console.error(error);
  }
}

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    camera.srcObject = cameraStream;
    await camera.play();
    $('camera-btn').disabled = true;
    $('camera-btn').textContent = 'Camera active';
    $('camera-state').textContent = matcherReady ? 'Waiting for movement…' : 'Waiting for reference template…';

    const processFrame = async () => {
      if (!cameraStream) return;
      cameraFrameCounter++;
      if (cameraFrameCounter % 2 === 0 && !cameraLoopBusy && camera.readyState >= 2) {
        cameraLoopBusy = true;
        try {
          await userHolistic.send({ image: camera });
        } finally {
          cameraLoopBusy = false;
        }
      }
      requestAnimationFrame(processFrame);
    };
    requestAnimationFrame(processFrame);
  } catch (error) {
    $('camera-state').textContent = 'Camera blocked';
    $('status').textContent = 'Allow camera access and try again.';
  }
}

$('camera-btn').addEventListener('click', startCamera);
$('replay-btn').addEventListener('click', () => {
  reference.currentTime = 0;
  reference.play().catch(() => {});
});
$('next-btn').addEventListener('click', () => {
  if (signIndex === signs.length - 1) { location.href = 'exercise_map.html'; return; }
  signIndex++;
  showCurrentSign();
});

showCurrentSign();