const progress = SignSenseProgress.read();
const totals = [14, 13, 9];
const titles = ['First connections', 'Stay curious', 'Your people'];
let achieved = 0, next = 0;
totals.forEach((total, i) => {
  const count = Math.min(total, Object.values(progress[i + 1] || {}).filter(value => typeof value === 'number' && value > 60).length);
  achieved += count;
  document.querySelector(`[data-count="${i + 1}"]`).textContent = `${count} / ${total}`;
  document.querySelector(`[data-exercise="${i + 1}"]`).classList.toggle('done', count === total);
  if (!next && count < total) next = i + 1;
});
const percent = Math.round(achieved / 36 * 100);
document.getElementById('username').textContent = sessionStorage.getItem('loggedInUser') || 'Learner';
document.getElementById('total-progress').textContent = `${achieved} / 36`;
document.getElementById('progress-percent').textContent = `${percent}%`;
document.getElementById('progress-ring').style.setProperty('--progress', `${percent}%`);
document.getElementById('continue').href = `exercise.html?exercise=${next || 1}`;
document.getElementById('continue-title').textContent = next ? titles[next - 1] : 'Every island explored!';
if (achieved) {
 document.getElementById('continue').textContent = next ? 'Continue your journey \u2192' : 'Practise again \u2192';
 document.getElementById('continue-description').textContent = next ? 'Your progress is right here. Ready for your next connection?' : '36 signs achieved. Keep your confidence growing with a little practice.';
}
document.getElementById('signout').addEventListener('click', () => sessionStorage.removeItem('loggedInUser'));
