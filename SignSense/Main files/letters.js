'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const camera = $('camera');
  let catalog = [], deck = [], index = 0, photoIndex = 0, duration = 3;
  let stream = null, busy = false, disposed = false, controller = null;
  let scores = SignSenseProgress.read().letters || {};
  if (typeof scores !== 'object' || Array.isArray(scores)) scores = {};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const current = () => deck[index];

  function shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function controls() {
    $('check-button').disabled = busy || !stream || !deck.length;
    $('camera-button').disabled = busy;
    $('camera-button').textContent = stream ? 'Stop camera' : 'Start camera';
    for (const id of ['next-button', 'shuffle-button']) $(id).disabled = busy || !deck.length;
    $('photo-button').disabled = busy || !current() || current().images.length < 2;
  }

  function feedback(title, message, status = '') {
    $('result-title').textContent = title;
    $('feedback').textContent = message;
    $('result-card').dataset.status = status;
    $('result-card').classList.toggle('success', status === 'match');
    $('camera-panel').classList.toggle('success', status === 'match');
    $('result-label').textContent = status === 'match' ? 'LETTER RECOGNISED' : status === 'different_sign' ? 'GIVE IT ANOTHER TRY' : status === 'uncertain' ? 'LET’S TRY AGAIN' : 'LETTER PRACTICE';
  }

  function showPhoto() {
    $('reference-image').src = current().images[photoIndex];
    $('reference-image').alt = `Auslan reference for letter ${current().letter}`;
    $('reference-image').hidden = false;
    $('reference-placeholder').hidden = true;
  }

  function showLetter() {
    photoIndex = Math.floor(Math.random() * current().images.length);
    $('letter-title').textContent = `Letter ${current().letter}`;
    $('round-progress').textContent = `${index + 1} / ${deck.length} this round`;
    $('saved-progress').textContent = `${catalog.filter(item => scores[item.letter] === true).length} / ${catalog.length} letters recognised`;
    $('next-button').textContent = index === deck.length - 1 ? 'Finish round →' : 'Next letter →';
    $('detected').textContent = '';
    $('check-button').textContent = 'Check my sign';
    feedback(`Let’s sign ${current().letter}.`, 'Copy the photo, then check your sign.');
    showPhoto();
    controls();
  }

  function newRound() {
    const previous = current()?.letter;
    deck = shuffle(catalog);
    if (deck.length > 1 && deck[0].letter === previous) [deck[0], deck[1]] = [deck[1], deck[0]];
    index = 0;
    showLetter();
  }

  function stopCamera() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    camera.srcObject = null;
    $('camera-state').textContent = 'Camera off';
    controls();
  }

  async function toggleCamera() {
    if (stream) { stopCamera(); return; }
    busy = true;
    controls();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs localhost or HTTPS. Open the app through its Python server.');
      const acquired = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      if (disposed) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      camera.srcObject = stream;
      await camera.play();
      stream.getVideoTracks()[0].addEventListener('ended', () => { stopCamera(); controller?.abort(); });
      $('camera-state').textContent = 'Ready to practise';
    } catch (error) {
      stopCamera();
      feedback('Camera unavailable', error.name === 'NotAllowedError' ? 'Allow camera access in your browser, then select Start camera.' : error.message, 'uncertain');
    } finally { busy = false; controls(); }
  }

  async function checkSign() {
    if (busy || !stream) return;
    busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    const expected = current().letter;
    let timeout;
    controls();
    $('detected').textContent = '';
    feedback('Get ready…', 'Bring your hands into position before the countdown ends.');
    const overlay = $('capture-overlay');
    const active = () => {
      if (disposed || signal.aborted || document.hidden || !stream || !stream.getVideoTracks()[0]?.enabled || stream.getVideoTracks()[0]?.readyState !== 'live') throw new Error('Capture interrupted. Keep this tab open and try again.');
    };
    try {
      overlay.hidden = false;
      for (let n = 3; n > 0; n--) { active(); overlay.textContent = String(n); await sleep(1000); }
      const canvas = document.createElement('canvas');
      if (!camera.videoWidth || !camera.videoHeight) throw new Error('Camera is still starting. Please try again.');
      canvas.width = 640;
      canvas.height = Math.round(640 * camera.videoHeight / camera.videoWidth);
      if (!Number.isFinite(canvas.height) || canvas.height < 120 || canvas.height > 720) throw new Error('Use a landscape camera view, then try again.');
      const context = canvas.getContext('2d');
      const frames = [];
      const started = performance.now();
      let previousTime = -1;
      $('camera-state').textContent = 'Recording your sign';
      while (true) {
        active();
        const elapsed = performance.now() - started;
        overlay.textContent = `Sign ${expected} · ${Math.max(0, Math.ceil(duration - elapsed / 1000))}s`;
        if (camera.readyState >= 2 && camera.currentTime !== previousTime) {
          previousTime = camera.currentTime;
          // CSS mirrors only the preview; model pixels keep the camera orientation.
          context.drawImage(camera, 0, 0, canvas.width, canvas.height);
          const jpeg = canvas.toDataURL('image/jpeg', 0.8);
          if (!jpeg.startsWith('data:image/jpeg;base64,')) throw new Error('This browser cannot capture JPEG frames. Try another browser.');
          frames.push({ timestamp_ms: Math.round(elapsed), jpeg: jpeg.split(',')[1] });
          if (frames.length > 1 && frames.at(-1).timestamp_ms - frames[0].timestamp_ms >= duration * 1000) break;
        }
        if (elapsed > (duration + 0.8) * 1000) throw new Error('Camera frames were too slow. Please try again.');
        await sleep(100);
      }
      overlay.textContent = 'Checking…';
      $('camera-state').textContent = 'Checking your sign';
      feedback('Checking your sign…', 'The first check can take longer while recognition starts.');
      timeout = setTimeout(() => controller?.abort(), 120000);
      const response = await fetch('/api/letter-attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ letter: expected, frames }), signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Recognition failed. Please retry.');
      if (disposed || signal.aborted) return;
      feedback(result.status === 'match' ? `Correct — ${expected}!` : result.status === 'different_sign' ? `Not quite — we detected ${result.detected_letter}.` : 'We’re not sure yet.', result.feedback, result.status);
      $('detected').textContent = result.detected_letter ? `${result.status === 'uncertain' ? 'Best guess' : 'Detected'}: ${result.detected_letter}` : 'No letter detected';
      if (result.status === 'match') {
        scores[expected] = true;
        SignSenseProgress.save('letters', scores);
        $('saved-progress').textContent = `${catalog.filter(item => scores[item.letter] === true).length} / ${catalog.length} letters recognised`;
      }
      $('check-button').textContent = 'Try again';
    } catch (error) {
      if (!disposed) feedback('Let’s try again', error.name === 'AbortError' ? 'The check was interrupted or timed out. Keep this tab open and retry.' : error.message, 'uncertain');
    } finally {
      clearTimeout(timeout);
      controller = null;
      overlay.hidden = true;
      busy = false;
      $('camera-state').textContent = stream ? 'Ready to practise' : 'Camera off';
      controls();
    }
  }

  $('camera-button').addEventListener('click', toggleCamera);
  $('check-button').addEventListener('click', checkSign);
  $('shuffle-button').addEventListener('click', newRound);
  $('photo-button').addEventListener('click', () => { photoIndex = (photoIndex + 1) % current().images.length; showPhoto(); });
  $('next-button').addEventListener('click', () => {
    if (index === deck.length - 1) { location.href = 'exercise_map.html'; return; }
    index++;
    showLetter();
  });
  $('reference-image').addEventListener('error', () => {
    $('reference-image').hidden = true;
    $('reference-placeholder').hidden = false;
    $('reference-placeholder').textContent = 'Photo unavailable. Please move to the next letter.';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { controller?.abort(); stopCamera(); }
  });
  window.addEventListener('pagehide', () => { disposed = true; controller?.abort(); stopCamera(); });
  window.addEventListener('pageshow', () => { disposed = false; });
  fetch('/api/letters', { signal: AbortSignal.timeout(15000) }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (!result.letters?.length) throw new Error('No supported reference photos were found.');
    catalog = result.letters;
    duration = result.window_seconds;
    newRound();
  }).catch(error => {
    $('round-progress').textContent = 'Letter practice unavailable';
    feedback('Unable to load letters', `${error.message} Start the app with python serve.py and reload this page.`, 'uncertain');
  });
})();
