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

const {
  FEATURE_DIM, HAND_BLOCK, START_MOTION, CONTINUE_MOTION,
  QUIET_FRAMES_TO_FINISH, MAX_GESTURE_FRAMES, MATCH_THRESHOLD,
  GOOD_DTW_DISTANCE, BAD_DTW_DISTANCE,
  extractFeature, writeHandFeature, handCount, motionBetween,
  trimToGesture, isUsableGesture, frameDistance, limitFrames,
  dtwDistance, mirrorGesture, confidenceFromDistance, runDtwSelfCheck
} = window.SignSenseGestureMath || {};
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

const dtwSelfCheckPassed = typeof runDtwSelfCheck === 'function' ? runDtwSelfCheck() : true;

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