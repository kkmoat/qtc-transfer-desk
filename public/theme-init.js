// Apply the saved display preference before the first page paint.
(() => {
  let theme = 'dark';
  try { if (localStorage.getItem('qtc-theme-v1') === 'light') theme = 'light'; } catch { /* optional display preference */ }
  document.documentElement.dataset.theme = theme;
})();
