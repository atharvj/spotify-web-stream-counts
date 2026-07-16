// ==UserScript==
// @name         Spotify Web Stream Counts
// @namespace    https://open.spotify.com/
// @version      1.0.1
// @description  Adds app-style Spotify play counts to artist and album track rows. Hidden on playlists. No analytics, backend, or stored credentials.
// @author       Intellectual07
// @license      MIT
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_ID = 'spotify-web-stream-counts';
  const COUNT_CLASS = 'sw-stream-count';
  const ROW_CLASS = 'sw-stream-count-row';
  const NATIVE_CLASS = 'sw-native-stream-count';
  const CACHE_KEY = `${SCRIPT_ID}:counts:v1`;
  const QUERY_OPERATION = 'queryAlbumTracks';
  const QUERY_HASH = '4e7c57acec1683d8a67265042c2afc30268246417b8fb551cea9454caeaa3560';
  const SPOTIFY_PARTNER_HOST = 'api-partner.spotify.com';
  const TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;
  const MAX_CACHE_ENTRIES = 5000;
  const ALBUM_REFRESH_MS = 15 * 60 * 1000;

  const counts = new Map();
  const requestedAlbums = new Map();
  const pendingAlbums = new Set();

  let bearerToken = '';
  let spotifyAppVersion = '';
  let renderQueued = false;
  let cacheSaveTimer = 0;

  const originalFetch = window.fetch.bind(window);
  const OriginalXHR = window.XMLHttpRequest;

  loadCache();
  installStylesWhenReady();
  interceptFetch();
  interceptXHR();
  observePage();

  function interceptFetch() {
    window.fetch = async function spotifyStreamCountsFetch(input, init) {
      try {
        captureRequestHeaders(input, init);
      } catch (error) {
        debug('Could not inspect fetch request headers', error);
      }

      const response = await originalFetch(input, init);

      try {
        const url = getRequestUrl(input);
        if (isSpotifyDataUrl(url)) {
          response.clone().json().then(ingestSpotifyResponse).catch(() => { });
        }
      } catch (error) {
        debug('Could not inspect Spotify fetch response', error);
      }

      return response;
    };
  }

  function interceptXHR() {
    if (!OriginalXHR?.prototype) return;

    const originalOpen = OriginalXHR.prototype.open;
    const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__swStreamCountsUrl = String(url ?? '');
      this.__swStreamCountsHeaders = Object.create(null);
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      try {
        const key = String(name).toLowerCase();
        this.__swStreamCountsHeaders ??= Object.create(null);
        this.__swStreamCountsHeaders[key] = String(value);
        captureHeader(key, value);
      } catch (_) {
        // Never interfere with Spotify if inspection fails.
      }
      return originalSetRequestHeader.call(this, name, value);
    };

    OriginalXHR.prototype.send = function patchedSend(...args) {
      if (isSpotifyDataUrl(this.__swStreamCountsUrl)) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.response === 'object' && this.response !== null) {
              ingestSpotifyResponse(this.response);
            } else if (typeof this.responseText === 'string' && this.responseText) {
              ingestSpotifyResponse(JSON.parse(this.responseText));
            }
          } catch (_) {
            // Ignore non-JSON responses.
          }
        }, { once: true });
      }
      return originalSend.apply(this, args);
    };
  }

  function captureRequestHeaders(input, init) {
    const merged = new Headers();

    if (typeof Request !== 'undefined' && input instanceof Request) {
      input.headers.forEach((value, key) => merged.set(key, value));
    }

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => merged.set(key, value));
    }

    merged.forEach((value, key) => captureHeader(key, value));
  }

  function captureHeader(name, value) {
    const key = String(name).toLowerCase();
    const text = String(value);

    if (key === 'authorization' && /^Bearer\s+\S+/i.test(text)) {
      bearerToken = text;
      processVisibleAlbum();
    } else if (key === 'spotify-app-version' && text.length < 100) {
      spotifyAppVersion = text;
    }
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    return String(input?.url ?? '');
  }

  function isSpotifyDataUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      const url = new URL(rawUrl, location.href);
      return url.hostname === SPOTIFY_PARTNER_HOST || url.pathname.includes('/pathfinder/');
    } catch (_) {
      return String(rawUrl).includes('pathfinder');
    }
  }

  function ingestSpotifyResponse(payload) {
    const discovered = extractTrackCounts(payload);
    if (discovered === 0) return;

    saveCacheSoon();
    queueRender();
  }

  function extractTrackCounts(root) {
    if (!root || typeof root !== 'object') return 0;

    const seen = new WeakSet();
    let added = 0;

    function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);

      const nestedTrack = value.track && typeof value.track === 'object' ? value.track : null;
      const candidate = nestedTrack ?? value;
      const playcount = candidate.playcount ?? (nestedTrack ? value.playcount : undefined);
      const trackId = extractTrackId(candidate, Boolean(nestedTrack));

      if (trackId && playcount !== undefined && playcount !== null) {
        const normalized = normalizeCount(playcount);
        if (normalized && counts.get(trackId) !== normalized) {
          counts.set(trackId, normalized);
          added += 1;
        }
      }

      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else {
        for (const child of Object.values(value)) walk(child);
      }
    }

    walk(root);
    return added;
  }

  function extractTrackId(candidate, cameFromTrackProperty) {
    if (!candidate || typeof candidate !== 'object') return '';

    const uri = String(candidate.uri ?? '');
    const uriMatch = uri.match(/^spotify:track:([A-Za-z0-9]{22})$/);
    if (uriMatch) return uriMatch[1];

    for (const key of ['shareUrl', 'url', 'href']) {
      const match = String(candidate[key] ?? '').match(/\/track\/([A-Za-z0-9]{22})(?:[?/#]|$)/);
      if (match) return match[1];
    }

    const id = String(candidate.id ?? '');
    return cameFromTrackProperty && TRACK_ID_RE.test(id) ? id : '';
  }

  function normalizeCount(value) {
    const digits = String(value).replace(/[^0-9]/g, '');
    if (!digits) return '';
    return digits.replace(/^0+(?=\d)/, '');
  }

  function observePage() {
    const start = () => {
      const observer = new MutationObserver(() => {
        queueRender();
        processVisibleAlbum();
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      window.addEventListener('popstate', onNavigation, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) onNavigation();
      });

      setInterval(() => {
        queueRender();
        processVisibleAlbum();
      }, 2500);

      queueRender();
      processVisibleAlbum();
    };

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  function onNavigation() {
    queueRender();
    processVisibleAlbum();
  }

  function processVisibleAlbum() {
    const albumId = getCurrentAlbumId();
    if (!albumId || !bearerToken || pendingAlbums.has(albumId)) return;

    const lastFetchedAt = requestedAlbums.get(albumId) ?? 0;
    if (Date.now() - lastFetchedAt < ALBUM_REFRESH_MS) return;

    void fetchAlbumCounts(albumId);
  }

  async function fetchAlbumCounts(albumId) {
    if (!TRACK_ID_RE.test(albumId)) return;
    pendingAlbums.add(albumId);

    try {
      const url = new URL('https://api-partner.spotify.com/pathfinder/v1/query');
      url.searchParams.set('operationName', QUERY_OPERATION);
      url.searchParams.set('variables', JSON.stringify({
        uri: `spotify:album:${albumId}`,
        offset: 0,
        limit: 300,
      }));
      url.searchParams.set('extensions', JSON.stringify({
        persistedQuery: {
          version: 1,
          sha256Hash: QUERY_HASH,
        },
      }));

      const headers = new Headers({
        Accept: 'application/json',
        Authorization: bearerToken,
        'App-Platform': 'WebPlayer',
      });
      if (spotifyAppVersion) headers.set('Spotify-App-Version', spotifyAppVersion);

      const response = await originalFetch(url.href, {
        method: 'GET',
        headers,
        credentials: 'include',
      });

      if (response.status === 401 || response.status === 403) {
        bearerToken = '';
        throw new Error(`Spotify authorization expired (${response.status})`);
      }
      if (response.status === 429) {
        throw new Error('Spotify rate-limited the request');
      }
      if (!response.ok) {
        throw new Error(`Spotify returned HTTP ${response.status}`);
      }

      const json = await response.json();
      if (Array.isArray(json?.errors) && json.errors.length > 0) {
        throw new Error(String(json.errors[0]?.message ?? 'Spotify GraphQL error'));
      }

      requestedAlbums.set(albumId, Date.now());
      ingestSpotifyResponse(json);
    } catch (error) {
      debug(`Could not load album ${albumId}`, error);
    } finally {
      pendingAlbums.delete(albumId);
    }
  }

  function getCurrentAlbumId() {
    const match = location.pathname.match(/^\/album\/([A-Za-z0-9]{22})(?:\/|$)/);
    return match?.[1] ?? '';
  }

  function getVisibleTrackIds() {
    const ids = new Set();
    for (const link of document.querySelectorAll('main a[href*="/track/"], [role="main"] a[href*="/track/"]')) {
      const id = trackIdFromHref(link.getAttribute('href'));
      if (id) ids.add(id);
    }
    return [...ids];
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderCounts();
    });
  }

  function renderCounts() {
    const pageKind = getPageKind();

    // Match the desktop app: playlists and all unsupported page types do not
    // receive a stream-count column. This also cleans up rows when Spotify
    // reuses DOM nodes during single-page navigation.
    if (pageKind === 'other') {
      removeAllInjectedCounts();
      return;
    }

    removeStaleCounts();

    const links = document.querySelectorAll(
      'main a[href*="/track/"], [role="main"] a[href*="/track/"], [data-testid="tracklist-row"] a[href*="/track/"]'
    );
    const seenRows = new WeakSet();

    for (const link of links) {
      const row = link.closest('[data-testid="tracklist-row"], [role="row"]');
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);

      // Spotify can include several track links in one row. The first one is
      // normally the title and is the only one we use to identify the song.
      const titleLink = row.querySelector('a[href*="/track/"]');
      if (!titleLink) continue;

      const trackId = trackIdFromHref(titleLink.getAttribute('href'));
      if (!trackId) continue;

      const count = counts.get(trackId);
      const existing = row.querySelector(`.${COUNT_CLASS}`);

      if (!count) {
        existing?.remove();
        row.classList.remove(ROW_CLASS);
        continue;
      }

      const formatted = formatCount(count);
      const nativeCount = findNativeCountElement(row, count, formatted);

      // Spotify occasionally renders the play count itself on some artist
      // layouts. Do not duplicate it; simply give the native value a tooltip.
      if (nativeCount) {
        existing?.remove();
        row.classList.remove(ROW_CLASS);
        nativeCount.classList.add(NATIVE_CLASS);
        nativeCount.title = `${formatted} Spotify plays`;
        continue;
      }

      row.classList.add(ROW_CLASS);
      row.dataset.swStreamPage = pageKind;

      const cell = existing ?? createCountCell(trackId);
      cell.dataset.trackId = trackId;
      cell.textContent = formatted;
      cell.title = `${formatted} Spotify plays`;

      if (!existing) row.appendChild(cell);
    }
  }

  function removeStaleCounts() {
    for (const cell of document.querySelectorAll(`.${COUNT_CLASS}`)) {
      const row = cell.closest('[data-testid="tracklist-row"], [role="row"]');
      const titleLink = row?.querySelector('a[href*="/track/"]');
      const currentTrackId = trackIdFromHref(titleLink?.getAttribute('href'));

      if (!row || !currentTrackId || cell.dataset.trackId !== currentTrackId) {
        cell.remove();
        row?.classList.remove(ROW_CLASS);
      }
    }
  }

  function removeAllInjectedCounts() {
    for (const cell of document.querySelectorAll(`.${COUNT_CLASS}`)) {
      cell.remove();
    }

    for (const row of document.querySelectorAll(`.${ROW_CLASS}`)) {
      row.classList.remove(ROW_CLASS);
      delete row.dataset.swStreamPage;
    }

    for (const nativeCount of document.querySelectorAll(`.${NATIVE_CLASS}`)) {
      nativeCount.classList.remove(NATIVE_CLASS);
      if (nativeCount.title?.endsWith(' Spotify plays')) {
        nativeCount.removeAttribute('title');
      }
    }
  }

  function findNativeCountElement(row, rawCount, formattedCount) {
    const rawDigits = String(rawCount);

    for (const element of row.querySelectorAll('span, div')) {
      if (element.classList.contains(COUNT_CLASS)) continue;
      if (element.closest(`.${COUNT_CLASS}`)) continue;
      if (element.querySelector('span, div')) continue;

      const text = String(element.textContent ?? '').trim();
      if (!text || /^\d{1,2}:\d{2}$/.test(text)) continue;

      const digits = text.replace(/[^0-9]/g, '');
      if (text === formattedCount || digits === rawDigits) return element;
    }

    return null;
  }

  function createCountCell(trackId) {
    const cell = document.createElement('span');
    cell.className = COUNT_CLASS;
    cell.dataset.trackId = trackId;
    cell.setAttribute('aria-label', 'Spotify stream count');
    return cell;
  }

  function getPageKind() {
    if (/^\/artist\//.test(location.pathname)) return 'artist';
    if (/^\/album\//.test(location.pathname)) return 'album';
    return 'other';
  }

  function trackIdFromHref(rawHref) {
    if (!rawHref) return '';
    const match = String(rawHref).match(/\/track\/([A-Za-z0-9]{22})(?:[?/#]|$)/);
    return match?.[1] ?? '';
  }

  function formatCount(digits) {
    try {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(BigInt(digits));
    } catch (_) {
      const number = Number(digits);
      return Number.isFinite(number) ? number.toLocaleString() : digits;
    }
  }

  function installStylesWhenReady() {
    const install = () => {
      if (document.getElementById(`${SCRIPT_ID}-styles`)) return;
      const style = document.createElement('style');
      style.id = `${SCRIPT_ID}-styles`;
      style.textContent = `
        /* Dedicated app-style play-count column. It is overlaid instead of
           changing Spotify's grid, which makes it much less likely to break
           Spotify's row controls or keyboard navigation. */
        .${ROW_CLASS} {
          position: relative !important;
        }
        .${COUNT_CLASS} {
          position: absolute;
          inset-inline-start: 61%;
          top: 50%;
          width: clamp(104px, 10vw, 142px);
          transform: translateY(-50%);
          overflow: hidden;
          color: var(--text-subdued, #b3b3b3);
          font-family: var(--encore-body-font-stack, CircularSp, CircularSp-Arab, CircularSp-Hebr, CircularSp-Cyrl, CircularSp-Grek, CircularSp-Deva, sans-serif);
          font-size: 14px;
          font-weight: 400;
          font-variant-numeric: tabular-nums;
          line-height: 20px;
          text-align: end;
          text-overflow: ellipsis;
          white-space: nowrap;
          user-select: text;
          z-index: 1;
        }
        .${COUNT_CLASS}:hover {
          color: var(--text-base, #fff);
        }
        .${NATIVE_CLASS} {
          font-variant-numeric: tabular-nums;
        }

        /* Give long titles more room on medium-width windows and hide the
           extra column before it can overlap Spotify's duration/actions. */
        @media (max-width: 1080px) {
          .${COUNT_CLASS} {
            inset-inline-start: 58%;
            width: 112px;
            font-size: 13px;
          }
        }
        @media (max-width: 860px) {
          .${COUNT_CLASS} {
            display: none;
          }
        }

      `;
      (document.head ?? document.documentElement).appendChild(style);
    };

    if (document.documentElement) install();
    else document.addEventListener('DOMContentLoaded', install, { once: true });
  }

  function loadCache() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '[]');
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [trackId, count] = entry;
        if (TRACK_ID_RE.test(String(trackId)) && /^\d+$/.test(String(count))) {
          counts.set(String(trackId), String(count));
        }
      }
    } catch (_) {
      sessionStorage.removeItem(CACHE_KEY);
    }
  }

  function saveCacheSoon() {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = window.setTimeout(() => {
      try {
        const entries = [...counts.entries()].slice(-MAX_CACHE_ENTRIES);
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(entries));
      } catch (_) {
        // Caching is optional; the script works without it.
      }
    }, 500);
  }

  function debug(message, error) {
    // Deliberately logs no access tokens, cookies, or request headers.
    console.debug(`[Spotify Stream Counts] ${message}`, error ?? '');
  }
})();
