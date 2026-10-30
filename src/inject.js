// Page-side layer. Injected at document-start by the controller, then called
// with the current knob values whenever Wallpaper Engine's config.json changes.
(() => {
  const VERSION = 19;
  // The client embeds third-party pages (<iframe src="https://music.163.com/st/...">).
  // This script runs inside those too, and painting a whole background layer there
  // would just give the iframe its own opaque canvas. All a subframe needs is to get
  // out of the way so the wallpaper behind the top document shows through.
  if (window.top !== window) {
    const transparent = () => {
      if (!document.documentElement || document.getElementById('__neFrameStyle')) return;
      const s = document.createElement('style');
      s.id = '__neFrameStyle';
      s.textContent = 'html,body{background:transparent!important}';
      (document.head || document.documentElement).appendChild(s);
      const stale = document.getElementById('__neBase');
      if (stale) stale.remove();
    };
    if (document.documentElement) transparent();
    else document.addEventListener('readystatechange', transparent, { once: true });
    return;
  }
  if (window.__neInstalled === VERSION) return;
  // hot-update: a previous layer keeps its own closure alive, so retire it first
  if (typeof window.__neTeardown === 'function') {
    try {
      window.__neTeardown();
    } catch {}
  }
  // intervals and timeouts from an older closure keep firing after a hot update,
  // and two watchdogs fighting over one <img> src means neither ever loads
  if (Array.isArray(window.__neTimers)) {
    for (const t of window.__neTimers) {
      clearInterval(t);
      clearTimeout(t);
    }
  }
  const timers = [];
  window.__neTimers = timers;
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  };
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    timers.push(t);
    return t;
  };
  window.__neInstalled = VERSION;
  // lets the controller notice that a new document was created (reload / navigation)
  window.__neEpoch = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  const S = {
    enabled: true,
    opacity: 100,
    dim: 0,
    tint: null, // [r,g,b] 0..1
    tintStrength: 0,
    blur: 0,
    fit: 'cover',
    audio: false,
    mode: 'video', // 'video' = a real <video>; 'scene' = MJPEG <img> fed by the WE pop-out
    url: '',
    server: '',
  };

  let styleEl = null;
  let baseEl = null;
  let mediaEl = null;
  let spareEl = null;
  let mediaKind = '';
  let dimEl = null;
  let tintEl = null;

  const css = () => `
.StyledBackground_s1tq3cvd, .StyledComp_sikguoo { background: none !important; }
/* CEF paints its window white, so we need our own opaque canvas underneath.
   It is set from --colorBackground at runtime (see syncTheme). */
html { background: var(--colorBackground, #13131a) !important; }
body { background: transparent !important; }
#__neBase {
  position: fixed; inset: 0; z-index: -101; pointer-events: none;
  background: #13131a;
  /* switching routes repaints the whole document; without a compositor layer
     of its own the background drops out for one frame and the white CEF
     canvas underneath shows through as a flash */
}

#__neVideo, #__neSpare {
  position: fixed; inset: 0; width: 100%; height: 100%;
  object-fit: ${S.fit}; object-position: center;
  z-index: -100; pointer-events: none;
  opacity: ${S.enabled ? S.opacity / 100 : 0};
  filter: blur(${S.blur}px);
  transform: scale(${1 + Math.min(S.blur, 60) / 900});
  background: transparent;
}
/* the warm spare keeps decoding while the visible stream is out; it must stay
   in the layout (visibility, not display) or the browser stops feeding it */
#__neSpare { visibility: hidden; }
#__neDim {
  position: fixed; inset: 0; z-index: -99; pointer-events: none;
  background: #000;
  opacity: ${S.enabled ? S.dim / 100 : 0};
}
#__neTint {
  position: fixed; inset: 0; z-index: -98; pointer-events: none;
  background: ${S.tint ? `rgb(${S.tint.map((v) => Math.round(v * 255)).join(',')})` : 'transparent'};
  opacity: ${S.enabled ? S.tintStrength / 100 : 0};
}

/* scroll-fade mask: pure obstruction once a wallpaper is behind the page */
.StyledStickyMask_s1iiif9f { background: none !important; }

/* sticky clone of the playlist tab row ghosting over the wallpaper */
.StyledStickyOper_svzrh3b { opacity: 0 !important; pointer-events: none !important; }

/* search suggestion popover: tinted glass instead of an opaque slab */
.PopoverWrapper_p62664h {
  background: transparent !important;
  backdrop-filter: blur(24px) saturate(1.5);
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  isolation: isolate;
}
.PopoverWrapper_p62664h::before {
  content: ''; position: absolute; inset: 0; z-index: -1;
  border-radius: inherit;
  background: var(--colorFunction4, rgba(45, 45, 56, 1));
  opacity: 0.62; pointer-events: none;
}

/* vinyl / player page: it paints the cover's dominant colour as a full-screen
   gradient and hides the app background, so the wallpaper never shows through.
   Drop both the gradient and its dimming mask and let the wallpaper be the
   background; readability is then controlled by the panel's dim slider. */
.CoverBackgroundContainer_c1d12ebz { background: none !important; }
.CoverBackgroundContainer_c1d12ebz .mask { background: none !important; }

/* the player page mounts long before the app puts .vinyl-mode on <body>, so for
   the whole opening transition the home page is still painted underneath and the
   two pages overlap. #vinyl-page-container flips to display:block the moment the
   player page mounts, so mirror that onto <html> and hide the main route at once
   instead of waiting for the app's own class. */
html.ne-vinyl .should-hide-under-vinyl-mode { content-visibility: hidden !important; }

/* bottom player bar: frosted glass driven by the theme colour */
.DefaultBarWrapper_d196mrsa {
  background: var(--ne-bar, rgba(19, 19, 26, 0.28)) !important;
  backdrop-filter: blur(40px) saturate(1.6);
  -webkit-backdrop-filter: blur(40px) saturate(1.6);
}
`;

  const parseRgb = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };

  let lastBar = '';
  const syncTheme = () => {
    const v = getComputedStyle(document.body).getPropertyValue('--colorBackground').trim();
    const c = parseRgb(v) || parseRgb(getComputedStyle(document.body).backgroundColor) || { r: 19, g: 19, b: 26, a: 1 };
    const base = `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
    if (baseEl) baseEl.style.setProperty('background', base, 'important');

    const a = Math.min(1, c.a * 0.28);
    const next = `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a.toFixed(3)})`;
    if (next !== lastBar) {
      lastBar = next;
      // the theme service rewrites <html style> wholesale, so our variable lives on <body>
      document.body.style.setProperty('--ne-bar', next);
    }
  };

  // a scene wallpaper arrives as an MJPEG stream (the WE pop-out is captured and
  // re-encoded as JPEG, so the browser can decode it natively through <img>)
  const ensureMedia = (kind) => {
    if (mediaEl && mediaKind === kind && mediaEl.isConnected) return mediaEl;
    if (mediaEl) {
      try {
        mediaEl.remove();
      } catch {}
    }
    if (spareEl) {
      try {
        spareEl.remove();
      } catch {}
      spareEl = null;
    }
    mediaEl = null;

    let el;
    if (kind === 'scene') {
      // MJPEG over a single <img> goes blank the moment the stream drops (WE
      // minimises our pop-out, the controller restarts, ...), and a blank image
      // is a visible flash. Keep a second stream decoding out of sight and swap
      // to it instead of ever showing an empty layer.
      el = makeSpareImg();
      spareEl = makeSpareImg();
      spareEl.id = '__neSpare';
      spareEl.style.visibility = 'hidden';
      spareEl.src = streamUrl();
      spareEl.addEventListener('error', () => {
        setTimeout(() => {
          if (mediaKind !== 'scene' || !S.url) return;
          spareEl.src = streamUrl();
        }, 1500);
      });
      document.body.insertBefore(spareEl, document.body.firstChild);
    } else {
      el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.autoplay = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.disablePictureInPicture = true;
    }
    el.id = '__neVideo';
    el.tabIndex = -1;
    el.setAttribute('aria-hidden', 'true');
    mediaEl = el;
    mediaKind = kind;
    document.body.insertBefore(el, document.body.firstChild);
    return el;
  };

  // a cache-busted URL so the element opens a fresh stream instead of reusing
  // the dead one
  const streamUrl = () => S.url + (S.url.includes('?') ? '&' : '?') + 't=' + Date.now();

  function makeSpareImg() {
    const i = document.createElement('img');
    i.alt = '';
    i.decoding = 'async';
    i.addEventListener('error', () => {
      setTimeout(() => {
        if (mediaKind !== 'scene' || !S.url) return;
        i.src = streamUrl();
      }, 1500);
    });
    return i;
  }

  // the visible stream died — promote the spare, then quietly re-arm this one
  function swapToSpare(why) {
    if (mediaKind !== 'scene' || !mediaEl || !spareEl) return false;
    const dead = mediaEl;
    const warm = spareEl;
    if (!warm.naturalWidth) return false;
    warm.style.visibility = '';
    warm.id = '__neVideo';
    dead.style.visibility = 'hidden';
    dead.id = '__neSpare';
    mediaEl = warm;
    spareEl = dead;
    setTimeout(() => {
      if (spareEl === dead && S.url) dead.src = streamUrl();
    }, 600);
    return true;
  }

  const ensure = () => {
    if (!document.body) return false;

    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement('style');
      styleEl.id = '__neSkin';
      document.head.appendChild(styleEl);
    }

    if (!baseEl || !baseEl.isConnected) {
      baseEl = document.createElement('div');
      baseEl.id = '__neBase';
      baseEl.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(baseEl, document.body.firstChild);
    }

    ensureMedia(S.mode === 'scene' ? 'scene' : 'video');

    for (const [id, key] of [
      ['__neDim', 'dimEl'],
      ['__neTint', 'tintEl'],
    ]) {
      const cur = id === '__neDim' ? dimEl : tintEl;
      if (!cur || !cur.isConnected) {
        const el = document.createElement('div');
        el.id = id;
        document.body.insertBefore(el, mediaEl.nextSibling);
        if (id === '__neDim') dimEl = el;
        else tintEl = el;
      }
    }
    return true;
  };

  const render = () => {
    if (!ensure()) return;
    styleEl.textContent = css();
    syncTheme();

    if (S.url && mediaEl.dataset.src !== S.url) {
      mediaEl.dataset.src = S.url;
      // cache-bust so a restarted MJPEG server is picked up immediately
      mediaEl.src = mediaKind === 'scene' ? S.url + '?t=' + Date.now() : S.url;
    }
    if (mediaKind !== 'scene') {
      mediaEl.muted = !S.audio;
      if (mediaEl.paused) mediaEl.play().catch(() => {});
    }
  };

  // A machine coming back from standby can leave the <video> with a dead
  // source: paused, errored, or stuck at readyState 0, and no event is fired
  // for that. Reconnect quietly rather than waiting for the user to restart.
  every(() => {
    if (document.hidden || !mediaEl || mediaKind === 'scene' || !S.url) return;
    const broken = mediaEl.error || mediaEl.readyState < 2;
    if (broken) {
      const bump = S.url + (S.url.includes('?') ? '&' : '?') + 't=' + Date.now();
      mediaEl.dataset.src = '';
      mediaEl.src = bump;
      mediaEl.play().catch(() => {});
    } else if (mediaEl.paused) {
      mediaEl.play().catch(() => {});
    }
  }, 3000);

  window.__neApply = (patch) => {
    Object.assign(S, patch || {});
    render();
    const w = mediaEl ? mediaEl.videoWidth || mediaEl.naturalWidth : 0;
    return {
      ok: true,
      mode: S.mode,
      url: S.url,
      paused: mediaKind === 'scene' ? null : mediaEl ? mediaEl.paused : null,
      w,
    };
  };

  window.__neState = () => ({ ...S });

  // react to theme rewrites (<html style> is replaced wholesale on theme switch)
  const themeObserver = new MutationObserver(() => syncTheme());
  // the SPA occasionally re-renders body children — keep our layers present
  const treeObserver = new MutationObserver(() => {
    if (!document.getElementById('__neVideo')) ensure();
  });

  // at document-start CEF may not have created <html> yet, so observing it can
  // throw; retry until the roots exist instead of dying silently
  const startObservers = () => {
    const root = document.documentElement;
    if (!root) return false;
    themeObserver.observe(root, { attributes: true, attributeFilter: ['style'] });
    treeObserver.observe(root, { childList: true, subtree: true });
    return true;
  };

  window.__neTeardown = () => {
    themeObserver.disconnect();
    treeObserver.disconnect();
    for (const ev of ['mousedown', 'click', 'keydown']) {
      try {
        document.removeEventListener(ev, burst, true);
      } catch {}
    }
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.length = 0;
    for (const el of [styleEl, baseEl, mediaEl, dimEl, tintEl]) {
      try {
        el && el.remove();
      } catch {}
    }
    document.documentElement.classList.remove('ne-vinyl');
    styleEl = baseEl = mediaEl = dimEl = tintEl = null;
    mediaKind = '';
    lastBar = '';
    vinylOn = null;
  };

  // Chrome suspends MJPEG decoding while the page is hidden and does not resume
  // the old stream, so re-arm the <img> whenever we come back into view. While
  // hidden we must NOT retry: every attempt would abort the previous request and
  // the stream would never get a chance to deliver its first frame.
  let armedAt = 0;
  const rearmScene = (force) => {
    if (mediaKind !== 'scene' || !mediaEl || !S.url) return;
    if (!force && Date.now() - armedAt < 8000) return;
    armedAt = Date.now();
    const sep = S.url.includes('?') ? '&' : '?';
    mediaEl.src = S.url + sep + 't=' + Date.now();
  };

  // Re-open the stream on the hidden spare and swap it in once it has a frame.
  // Clearing the visible <img> to reconnect is what the user sees as a flash, so
  // the frozen last frame stays on screen for as long as it takes.
  let pendingSwap = false;
  const rearmSpare = () => {
    if (mediaKind !== 'scene' || !spareEl || !S.url) return false;
    spareEl.src = '';
    spareEl.src = streamUrl();
    armedAt = Date.now();
    pendingSwap = true;
    return true;
  };

  every(() => {
    if (mediaKind === 'scene' && pendingSwap && spareEl && spareEl.naturalWidth) {
      pendingSwap = false;
      swapToSpare('ready');
      return;
    }
    if (document.visibilityState !== 'visible') return;
    if (!mediaEl || mediaEl.naturalWidth) return;
    // the spare is cheaper and, more importantly, invisible: only fall back to
    // blanking the visible element when there is no warm stream to swap in
    if (mediaKind === 'scene') {
      if (swapToSpare('watchdog')) return;
      if (Date.now() - armedAt > 8000 && rearmSpare()) return;
    }
    rearmScene(false);
  }, 2000);

  // the app adds .vinyl-mode only after its page transition ends; until then the
  // home page keeps painting behind the player page. Watch the container we know
  // flips synchronously instead, and hold the class through the close animation.
  let vinylOn = null;
  let vinylRelease = 0;
  const syncVinyl = () => {
    const root = document.documentElement;
    if (!root) return;
    const el = document.getElementById('vinyl-page-container');
    const on = !!el && getComputedStyle(el).display !== 'none';
    if (on === vinylOn) return;
    vinylOn = on;
    clearTimeout(vinylRelease);
    // the app keeps the container displayed for the whole close animation, so we
    // can hand the frame back the moment it goes away — holding it any longer
    // leaves the user staring at a bare wallpaper
    if (on) root.classList.add('ne-vinyl');
    else root.classList.remove('ne-vinyl');
  };
  // polling alone leaves up to one interval of overlap; a click can open the
  // player page at any time, so sample every frame for half a second around any
  // interaction and let the poll cover the rest
  let burstUntil = 0;
  const burst = () => {
    const end = performance.now() + 600;
    if (burstUntil > end) return;
    burstUntil = end;
    const step = () => {
      syncVinyl();
      if (performance.now() < end) requestAnimationFrame(step);
    };
    step();
  };
  document.addEventListener('mousedown', burst, true);
  document.addEventListener('click', burst, true);
  document.addEventListener('keydown', burst, true);
  every(syncVinyl, 80);

  // Q14: constant frame rate while visible, no painting while hidden
  document.addEventListener('visibilitychange', () => {
    if (!mediaEl) return;
    if (mediaKind === 'scene') {
      if (!document.hidden && !rearmSpare()) rearmScene(true);
      return;
    }
    if (document.hidden) mediaEl.pause();
    else mediaEl.play().catch(() => {});
  });

  // observers must be live before the first render so the SPA's own re-renders
  // cannot delete our layers; keep retrying while the document is still empty
  if (!startObservers()) {
    const tick = every(() => {
      if (startObservers()) clearInterval(tick);
    }, 50);
  }

  if (document.body) {
    render();
  } else {
    // document-start: wait for <body>, then paint and never look back
    const tick = every(() => {
      if (!document.body) return;
      clearInterval(tick);
      render();
    }, 50);
  }
})();
