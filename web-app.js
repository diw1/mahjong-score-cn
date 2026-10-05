(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !(location.protocol === 'http:' && localHost)) return;
  function registerOfflineCache() {
    try {
      navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
        .catch(error => console.warn('离线缓存暂不可用，网页功能不受影响。', error));
    } catch (error) {
      console.warn('离线缓存暂不可用，网页功能不受影响。', error);
    }
  }
  if (document.readyState === 'complete') registerOfflineCache();
  else window.addEventListener('load', registerOfflineCache, { once: true });
})();
