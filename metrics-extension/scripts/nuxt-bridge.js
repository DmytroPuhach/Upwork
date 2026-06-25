// OptimizeUp Metrics — MAIN-world Nuxt bridge (READ-ONLY).
//
// The stat pages keep their data in the live `window.__NUXT__` object, which the
// isolated content script (metrics.js) cannot see. This tiny MAIN-world script
// relays a JSON snapshot of __NUXT__.state on request, over a DOM CustomEvent
// (events cross the isolated/main boundary; detail is a plain string).
//
// HARD BOUNDARY: read-only, runs only on the 4 stat pages (manifest-enforced),
// reads nothing but __NUXT__.state. No feed access, no writes, no network.
(function () {
  document.addEventListener('OU_GET_NUXT', () => {
    let payload = null;
    try {
      const N = window.__NUXT__;
      if (N && N.state) {
        try { payload = JSON.stringify({ state: N.state }); }
        catch { try { payload = JSON.stringify({ state: { lists: N.state.lists, connects: N.state.connects, ['$s$pageData:notificationsMap']: N.state['$s$pageData:notificationsMap'] } }); } catch {} }
      }
    } catch {}
    document.dispatchEvent(new CustomEvent('OU_NUXT', { detail: payload }));
  });
})();
