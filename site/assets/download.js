/*
 * OrbitDrop download buttons.
 *
 * Without JavaScript (or when anything below fails) the page keeps its static "coming soon" state,
 * whose links all go to https://github.com/keilvher1/orbitdrop/releases. With JavaScript it asks
 * the GitHub API for the latest release, picks the installers by file name, shows their version and
 * size, links SHA256SUMS.txt when the release has one and marks the visitor's platform.
 * No cookies, no storage, no other requests.
 */
(function () {
  'use strict';

  // Full literals, so site/scripts/check.mjs can audit every URL this file uses.
  var API = 'https://api.github.com/repos/keilvher1/orbitdrop/releases/latest';
  var RELEASES = 'https://github.com/keilvher1/orbitdrop/releases';
  var RELEASE_PREFIX = 'https://github.com/keilvher1/orbitdrop/releases/';
  var DOWNLOAD_PREFIX = 'https://github.com/keilvher1/orbitdrop/releases/download/';
  var TIMEOUT_MS = 8000;

  /*
   * Installers by file name (docs/packaging.md: OrbitDrop-<ver>-mac-<arch>[-unsigned].dmg,
   * OrbitDrop-<ver>-win-x64[-unsigned]-setup.exe). Unsigned macOS builds never match: Gatekeeper
   * blocks them. An unsigned Windows installer is only used when no signed one exists, and is
   * labelled as such.
   */
  var ASSETS = {
    'mac-arm64': [{ suffix: '-mac-arm64.dmg' }],
    'mac-x64': [{ suffix: '-mac-x64.dmg' }],
    'win-x64': [{ suffix: '-win-x64-setup.exe' }, { suffix: '-win-x64-unsigned-setup.exe', unsigned: true }],
  };

  var TEXT = {
    ko: {
      checking: '최신 버전을 확인하는 중입니다…',
      latest: function (v, date) { return '최신 버전 ' + v + (date ? ' · ' + date + ' 공개' : ''); },
      notes: '릴리스 노트',
      soon: '곧 공개됩니다.',
      soonMeta: '곧 공개됩니다',
      none: '아직 공개된 버전이 없습니다. 곧 공개됩니다 — ',
      rate: 'GitHub API 요청 한도에 걸려 버전 정보를 불러오지 못했습니다. 잠시 뒤 다시 열거나 ',
      error: '버전 정보를 불러오지 못했습니다. ',
      releasesLink: 'GitHub Releases',
      releasesTail: '에서 직접 받으세요.',
      noneTail: '에서 소식을 확인하세요.',
      download: function (ext) { return ext + ' 다운로드'; },
      missing: '이 버전에는 이 설치 파일이 없습니다. 곧 공개됩니다.',
      viewRelease: '릴리스 페이지 열기',
      version: '버전',
      unsigned: '코드 서명이 없는 설치 파일입니다. Windows SmartScreen이 경고할 수 있습니다.',
      digest: 'GitHub에 기록된 SHA-256',
      sums: 'SHA256SUMS.txt 받기',
      sumsLead: '이 릴리스의 체크섬 목록: ',
      noSums: '이 릴리스에는 SHA256SUMS.txt가 없습니다. 릴리스 페이지에 적힌 값과 비교하세요.',
      match: '이 컴퓨터',
      hintMac: 'Mac에서 보고 계십니다. Apple silicon과 Intel 가운데 내 Mac에 맞는 파일을 고르세요.',
      hintWin: 'Windows에서 보고 계십니다. Windows 판은 베타입니다.',
      hintOther: 'OrbitDrop은 macOS와 Windows용 데스크톱 앱입니다. Mac이나 Windows PC에서 받아 주세요.',
      locale: 'ko-KR',
    },
    en: {
      checking: 'Checking the latest version…',
      latest: function (v, date) { return 'Latest version ' + v + (date ? ' · released ' + date : ''); },
      notes: 'Release notes',
      soon: 'Coming soon.',
      soonMeta: 'Coming soon',
      none: 'No version has been released yet. Coming soon — follow ',
      rate: 'The GitHub API rate limit was reached, so the version could not be loaded. Try again later or download from ',
      error: 'The version could not be loaded. Download from ',
      releasesLink: 'GitHub Releases',
      releasesTail: ' directly.',
      noneTail: ' for news.',
      download: function (ext) { return 'Download ' + ext; },
      missing: 'This release has no installer for this system yet. Coming soon.',
      viewRelease: 'Open the release page',
      version: 'Version',
      unsigned: 'This installer is not code-signed. Windows SmartScreen may warn about it.',
      digest: 'SHA-256 recorded by GitHub',
      sums: 'Download SHA256SUMS.txt',
      sumsLead: 'Checksums for this release: ',
      noSums: 'This release has no SHA256SUMS.txt. Compare with the values on the release page.',
      match: 'Your computer',
      hintMac: 'You are on a Mac. Choose the file for your Mac: Apple silicon or Intel.',
      hintWin: 'You are on Windows. The Windows version is in beta.',
      hintOther: 'OrbitDrop is a desktop app for macOS and Windows. Download it on a Mac or a Windows PC.',
      locale: 'en-GB',
    },
  };

  var section = document.getElementById('download');
  if (!section) return;
  var t = TEXT[(document.documentElement.lang || 'ko').slice(0, 2)] || TEXT.ko;
  var status = section.querySelector('[data-role="status"]');
  var hint = section.querySelector('[data-role="hint"]');
  var sums = section.querySelector('[data-role="sums"]');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (key === 'text') node.textContent = props[key];
        else node.setAttribute(key, props[key]);
      }
    }
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function releasesLink() {
    return el('a', { href: RELEASES, text: t.releasesLink });
  }

  function setStatus(state, nodes) {
    if (!status) return;
    status.setAttribute('data-state', state);
    status.textContent = '';
    nodes.forEach(function (n) {
      status.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
    });
  }

  /* ------------------------------------------------------------ platform */

  function platform() {
    var data = navigator.userAgentData;
    var p = (data && data.platform) || '';
    if (p) {
      if (/^mac/i.test(p)) return 'mac';
      if (/^win/i.test(p)) return 'windows';
      return 'other';
    }
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return 'other';
    // iPadOS asks for desktop sites as "Macintosh"; it has a touch screen, Macs do not.
    if (/Macintosh|Mac OS X/i.test(ua)) return navigator.maxTouchPoints > 1 ? 'other' : 'mac';
    if (/Windows/i.test(ua)) return 'windows';
    return 'other';
  }

  var visitor = platform();
  section.setAttribute('data-visitor', visitor);
  Array.prototype.forEach.call(section.querySelectorAll('.dl-card'), function (card) {
    if (card.getAttribute('data-platform') !== visitor) return;
    card.setAttribute('data-match', 'true');
    var badge = card.querySelector('[data-role="match"]');
    if (badge) {
      badge.textContent = t.match;
      badge.hidden = false;
    }
  });
  if (hint) {
    hint.textContent = visitor === 'mac' ? t.hintMac : visitor === 'windows' ? t.hintWin : t.hintOther;
    hint.hidden = false;
  }

  /* ------------------------------------------------------------ release */

  if (!window.fetch || !window.Promise) return;

  function formatSize(bytes) {
    var mb = bytes / 1e6;
    try {
      return new Intl.NumberFormat(t.locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(mb);
    } catch (e) {
      return mb.toFixed(1) + ' MB';
    }
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (!iso || isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(t.locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
    } catch (e) {
      return iso.slice(0, 10);
    }
  }

  function pick(assets, rules) {
    for (var r = 0; r < rules.length; r++) {
      for (var i = 0; i < assets.length; i++) {
        var a = assets[i];
        var name = a && typeof a.name === 'string' ? a.name.toLowerCase() : '';
        if (!name || name.slice(-rules[r].suffix.length) !== rules[r].suffix) continue;
        if (!rules[r].unsigned && name.indexOf('-unsigned') !== -1) continue;
        if (typeof a.browser_download_url !== 'string' || a.browser_download_url.indexOf(DOWNLOAD_PREFIX) !== 0) continue;
        return { asset: a, unsigned: !!rules[r].unsigned };
      }
    }
    return null;
  }

  function fillCard(card, found, release, version) {
    var link = card.querySelector('[data-role="link"]');
    var meta = card.querySelector('[data-role="meta"]');
    var note = card.querySelector('[data-role="note"]');
    var digest = card.querySelector('[data-role="digest"]');
    if (!found) {
      if (meta) meta.textContent = t.missing;
      if (link && typeof release.html_url === 'string' && release.html_url.indexOf(RELEASE_PREFIX) === 0) {
        link.setAttribute('href', release.html_url);
        link.textContent = t.viewRelease;
      }
      return;
    }
    var asset = found.asset;
    var ext = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase();
    if (link) {
      link.setAttribute('href', asset.browser_download_url);
      link.classList.remove('btn-secondary');
      link.classList.add('btn-primary');
      link.textContent = t.download(ext);
    }
    if (meta) meta.textContent = t.version + ' ' + version + (asset.size > 0 ? ' · ' + formatSize(asset.size) : '');
    if (note && found.unsigned) {
      note.textContent = t.unsigned;
      note.hidden = false;
    }
    if (digest && typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
      digest.textContent = '';
      digest.appendChild(document.createTextNode(t.digest + ': '));
      digest.appendChild(el('code', { text: asset.digest.slice(7).toLowerCase() }));
      digest.hidden = false;
    }
  }

  function showRelease(release) {
    var assets = Array.isArray(release.assets) ? release.assets : [];
    var version = String(release.tag_name || release.name || '').replace(/^v(?=\d)/, '');
    var any = false;
    Array.prototype.forEach.call(section.querySelectorAll('.dl-card'), function (card) {
      var rules = ASSETS[card.getAttribute('data-asset')];
      if (!rules) return;
      var found = pick(assets, rules);
      if (found) any = true;
      fillCard(card, found, release, version);
    });
    var notes = typeof release.html_url === 'string' && release.html_url.indexOf(RELEASE_PREFIX) === 0 ? release.html_url : null;
    if (!any) {
      setStatus('soon', [t.soon + ' ', releasesLink(), t.noneTail]);
    } else {
      var parts = [t.latest(version, formatDate(release.published_at))];
      if (notes) parts.push(' · ', el('a', { href: notes, text: t.notes }));
      setStatus('ready', parts);
    }
    // Without installers to check, the static text (pointing at GitHub Releases) stays.
    if (sums && any) {
      var file = pick(assets, [{ suffix: 'sha256sums.txt' }]);
      sums.textContent = '';
      if (file) {
        sums.appendChild(document.createTextNode(t.sumsLead));
        sums.appendChild(el('a', { href: file.asset.browser_download_url, text: t.sums }));
      } else {
        sums.appendChild(document.createTextNode(t.noSums + ' '));
        if (notes) sums.appendChild(el('a', { href: notes, text: t.viewRelease }));
      }
    }
  }

  function fallback(kind) {
    if (kind === 'none') setStatus('soon', [t.none, releasesLink(), t.noneTail]);
    else if (kind === 'rate') setStatus('error', [t.rate, releasesLink(), t.releasesTail]);
    else setStatus('error', [t.error, releasesLink(), t.releasesTail]);
  }

  setStatus('loading', [t.checking]);
  section.setAttribute('aria-busy', 'true');

  var controller = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () {
    if (controller) controller.abort();
  }, TIMEOUT_MS);

  fetch(API, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: controller ? controller.signal : undefined,
  })
    .then(function (response) {
      if (response.status === 404) return { kind: 'none' };
      var remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 429 || (response.status === 403 && remaining === '0')) return { kind: 'rate' };
      if (!response.ok) return { kind: 'error' };
      return response.json().then(function (release) {
        if (!release || typeof release !== 'object' || release.draft) return { kind: 'error' };
        return { kind: 'release', release: release };
      });
    })
    .then(function (result) {
      if (result.kind === 'release') showRelease(result.release);
      else fallback(result.kind);
    })
    .catch(function () {
      fallback('error');
    })
    .then(function () {
      clearTimeout(timer);
      section.removeAttribute('aria-busy');
    });
})();
