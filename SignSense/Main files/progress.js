'use strict';

((root) => {
  function createProgressTracker(storage, session) {
    const key = 'signsense-progress:' + ((session && session.getItem('loggedInUser')) || 'guest');
    function read() {
      try {
        const raw = storage ? storage.getItem(key) : null;
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    }
    return {
      getKey() { return key; },
      read,
      save(exercise, scores) {
        try {
          const all = read();
          all[exercise] = scores;
          if (storage) storage.setItem(key, JSON.stringify(all));
        } catch {
          /* Practice remains available when storage is full or disabled. */
        }
      }
    };
  }

  const defaultInstance = typeof window !== 'undefined'
    ? createProgressTracker(window.localStorage, window.sessionStorage)
    : null;

  if (typeof window !== 'undefined') {
    window.SignSenseProgress = defaultInstance;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createProgressTracker, SignSenseProgress: defaultInstance };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
