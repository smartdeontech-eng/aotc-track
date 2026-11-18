(function () {
  try {
    var pref = localStorage.getItem('theme-pref') || 'auto';
    var theme = pref;
    if (pref === 'auto') {
      var h = new Date().getHours();
      // Evening window: 7 PM to 6 AM local device time.
      theme = (h >= 19 || h < 6) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
})();
