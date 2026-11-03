// Tiny progressive enhancements. The app works without JS.
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const t = document.querySelector('textarea[name=message]');
  if (t) { t.value = b.dataset.preset; t.focus(); }
}));
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; } catch { prompt('Copy this link:', b.dataset.copy); }
}));
document.querySelectorAll('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => {
  if (!confirm(f.dataset.confirm)) e.preventDefault();
}));
// Stop double-submits (e.g. buying two numbers by tapping Connect twice).
document.querySelectorAll('form').forEach((f) => f.addEventListener('submit', () => {
  setTimeout(() => f.querySelectorAll('button').forEach((b) => { b.disabled = true; }), 0);
}));
