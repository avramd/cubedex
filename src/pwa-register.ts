import { registerSW } from 'virtual:pwa-register';

const BANNER_ID = 'cubedex-pwa-update-banner';

function removeUpdateBanner(): void {
  document.getElementById(BANNER_ID)?.remove();
}

// Tell the waiting SW to skip waiting, then reload as soon as it takes over
// (or after a short fallback). We don't go through vite-plugin-pwa's
// `updateSW(true)` because it relies on a `controllerchange` event that
// never fires when the SW doesn't call `clients.claim()`, leaving the
// promise hanging and the page un-reloaded. Posting SKIP_WAITING directly
// and listening for both `controllerchange` and the waiting worker's
// `activated` state covers both clientsClaim-on and clientsClaim-off
// configs; the timeout is last-ditch insurance.
async function refreshToNewVersion(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    window.location.reload();
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const waiting = reg?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
  waiting.addEventListener('statechange', () => {
    if (waiting.state === 'activated') reloadOnce();
  });
  waiting.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(reloadOnce, 3000);
}

function showUpdateBanner(): void {
  if (document.getElementById(BANNER_ID)) return;

  const bar = document.createElement('div');
  bar.id = BANNER_ID;
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.className =
    'fixed top-0 left-0 right-0 z-[60] flex flex-wrap items-center justify-center gap-3 px-4 py-3 shadow-lg ' +
    'bg-white text-gray-900 border-b border-gray-200 ' +
    'dark:bg-gray-800 dark:text-white dark:border-gray-700';

  const msg = document.createElement('p');
  msg.className = 'text-sm sm:text-base text-center';
  msg.textContent = 'A new version of Cubedex is available. Refresh now?';

  const actions = document.createElement('div');
  actions.className = 'flex flex-shrink-0 gap-2';

  const later = document.createElement('button');
  later.type = 'button';
  later.className =
    'font-bold py-2 px-4 rounded-lg transition-colors duration-300 ease-in-out ' +
    'bg-gray-200 text-gray-900 hover:bg-gray-300 ' +
    'dark:bg-gray-600 dark:text-white dark:hover:bg-gray-500';
  later.textContent = 'Later';
  later.addEventListener('click', removeUpdateBanner);

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className =
    'font-bold py-2 px-4 rounded-lg transition-colors duration-300 ease-in-out ' +
    'bg-blue-500 text-white hover:bg-blue-700';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refresh.textContent = 'Refreshing…';
    void refreshToNewVersion();
  });

  actions.append(later, refresh);
  bar.append(msg, actions);
  document.body.append(bar);
}

registerSW({
  immediate: true,
  onNeedRefresh() {
    showUpdateBanner();
  },
  onOfflineReady() {},
  onRegisteredSW(_swUrl, registration) {
    void registration?.update();
  },
});

/** If reg.waiting is already set, Workbox may not emit "waiting"; show the banner from the registration API directly. */
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.ready.then((reg) => {
    if (reg.waiting) {
      showUpdateBanner();
    }
    reg.addEventListener('updatefound', () => {
      const inst = reg.installing;
      if (!inst) return;
      inst.addEventListener('statechange', () => {
        if (inst.state === 'installed' && navigator.serviceWorker.controller && reg.waiting) {
          showUpdateBanner();
        }
      });
    });
  });
}
