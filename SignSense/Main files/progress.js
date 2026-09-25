window.SignSenseProgress = (() => {
  const key = 'signsense-progress:' + (sessionStorage.getItem('loggedInUser') || 'guest');
  function read() { try { const value = JSON.parse(localStorage.getItem(key)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
  return { read, save(exercise, scores) { try { const all = read(); all[exercise] = scores; localStorage.setItem(key, JSON.stringify(all)); } catch { /* Practice remains available when storage is full or disabled. */ } } };
})();
