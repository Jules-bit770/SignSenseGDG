import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProgressTracker } = require('../SignSense/Main files/progress.js');

function createMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  };
}

test('SignSenseProgress: scopes key to guest when no session user', () => {
  const storage = createMockStorage();
  const session = createMockStorage();
  const tracker = createProgressTracker(storage, session);

  assert.equal(tracker.getKey(), 'signsense-progress:guest');
  assert.deepEqual(tracker.read(), {});
});

test('SignSenseProgress: scopes key to logged-in username', () => {
  const storage = createMockStorage();
  const session = createMockStorage({ loggedInUser: 'alex123' });
  const tracker = createProgressTracker(storage, session);

  assert.equal(tracker.getKey(), 'signsense-progress:alex123');
});

test('SignSenseProgress: saves and reads scores accurately', () => {
  const storage = createMockStorage();
  const session = createMockStorage({ loggedInUser: 'sarah' });
  const tracker = createProgressTracker(storage, session);

  tracker.save(1, { HELLO: 95, BYE: 80 });
  const data = tracker.read();
  assert.deepEqual(data[1], { HELLO: 95, BYE: 80 });

  tracker.save('letters', { A: true, B: true });
  const updated = tracker.read();
  assert.deepEqual(updated[1], { HELLO: 95, BYE: 80 });
  assert.deepEqual(updated.letters, { A: true, B: true });
});

test('SignSenseProgress: handles corrupted JSON gracefully without crashing', () => {
  const storage = createMockStorage({
    'signsense-progress:guest': '{invalid-json-content-here!!!'
  });
  const session = createMockStorage();
  const tracker = createProgressTracker(storage, session);

  assert.deepEqual(tracker.read(), {});
});

test('SignSenseProgress: handles storage failure gracefully', () => {
  const faultyStorage = {
    getItem() { return '{}'; },
    setItem() { throw new Error('QuotaExceededError'); }
  };
  const tracker = createProgressTracker(faultyStorage, createMockStorage());

  // Must not throw exception
  assert.doesNotThrow(() => {
    tracker.save(1, { TEST: 100 });
  });
});

test('Map Progress Logic: aggregates achieved signs across all 3 exercises correctly', () => {
  const totals = [14, 13, 9];
  const progress = {
    1: { HELLO: 85, BYE: 72, NO: 50 }, // 2 achieved (> 60)
    2: { AT: 90 },                     // 1 achieved
    3: {}                              // 0 achieved
  };

  let achieved = 0;
  const counts = totals.map((total, i) => {
    const count = Math.min(total, Object.values(progress[i + 1] || {}).filter(value => typeof value === 'number' && value > 60).length);
    achieved += count;
    return count;
  });

  assert.equal(counts[0], 2);
  assert.equal(counts[1], 1);
  assert.equal(counts[2], 0);
  assert.equal(achieved, 3);

  const percent = Math.round((achieved / 36) * 100);
  assert.equal(percent, 8); // 3 / 36 = 8.33% -> 8%
});
