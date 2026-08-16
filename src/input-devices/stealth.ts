/**
 * Browser anti-detection — maximum stealth without sacrificing functionality.
 *
 * Layers:
 *   1. Chrome launch args (flags that prevent automation tells)
 *   2. JavaScript patches (property overrides injected before page scripts)
 *   3. Canvas/WebGL noise (per-session fingerprint variation)
 *   4. WebRTC leak prevention
 *   5. Screen/window geometry consistency
 *   6. Navigator.connection realistic values
 *   7. Font fingerprint normalization
 *   8. Stack trace sanitization
 *
 * Combined with uinput (real kernel input) + GPU rendering + persistent
 * profiles + proper fonts, this makes the browser indistinguishable from
 * a human on a Linux desktop or VPS.
 */

export interface StealthConfig {
  proxyUrl?: string;
  userDataDir?: string;
  userAgent?: string;
  languages?: string[];
  platform?: string;
  vendor?: string;
  timezone?: string;
  locale?: string;
  /** Viewport dimensions (should match Xvfb display) */
  screenWidth?: number;
  screenHeight?: number;
  /** WebGL override (only needed if no real GPU) */
  webglVendor?: string;
  webglRenderer?: string;
  /** Per-session seed for canvas/WebGL noise (auto-generated if not set) */
  fingerprintSeed?: number;
}

/**
 * Chrome launch args for stealth mode.
 */
export function getStealthArgs(config?: StealthConfig): string[] {
  const width = config?.screenWidth ?? 1920;
  const height = config?.screenHeight ?? 1080;

  const args = [
    // === DO NOT include (automation tells) ===
    // --no-sandbox, --disable-setuid-sandbox, --headless, --disable-gpu
    // --enable-automation, --disable-extensions, --remote-debugging-port
    // --disable-blink-features=AutomationControlled  ← triggers webdriver=true in Chromium 130+
    // --load-extension=...  ← triggers webdriver=true (developer mode flag)

    '--disable-infobars',

    // === WebRTC leak prevention ===
    // Prevents local IP leak (172.17.x.x = Docker fingerprint)
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',

    // === Window geometry ===
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    '--start-maximized',

    // === GPU (real hardware via /dev/dri) ===
    // Enable GPU rasterization for real WebGL fingerprint, but disable Vulkan
    // (vkCreateInstance fails in DinD/sysbox containers → white screen).
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--ignore-gpu-blocklist',
    '--disable-vulkan',
    '--enable-features=VaapiVideoDecoder',

    // === Performance (don't throttle background tabs) ===
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',

    // === Telemetry off ===
    '--disable-breakpad',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',

    // === Media: allow autoplay (some sites test this) ===
    '--autoplay-policy=no-user-gesture-required',

    // === Disable "Save password?" prompts (distracting in automation) ===
    '--disable-save-password-bubble',
  ];

  if (config?.proxyUrl) {
    args.push(`--proxy-server=${config.proxyUrl}`);
  }

  if (config?.userDataDir) {
    args.push(`--user-data-dir=${config.userDataDir}`);
  }

  // DO NOT use --load-extension (triggers navigator.webdriver=true).
  // Stealth patches are injected via CDP Page.addScriptToEvaluateOnNewDocument
  // after Chrome launches — see human-session.ts injectStealthViaCDP().

  // Timezone via TZ env is handled separately (in spawn env)

  return args;
}

/**
 * JavaScript stealth patches — injected via extension content_script
 * at document_start in the MAIN world (before any page JS runs).
 */
export function getStealthScript(config?: StealthConfig): string {
  const ua = config?.userAgent ?? '';
  const languages = JSON.stringify(config?.languages ?? ['en-US', 'en']);
  const platform = config?.platform ?? 'Linux x86_64';
  const vendor = config?.vendor ?? 'Google Inc.';
  const screenW = config?.screenWidth ?? 1920;
  const screenH = config?.screenHeight ?? 1080;
  const seed = config?.fingerprintSeed ?? Math.floor(Math.random() * 2147483647);
  const webglVendor = config?.webglVendor ?? '';
  const webglRenderer = config?.webglRenderer ?? '';

  return `
// === Shizuha stealth patches v2 ===
(function() {
  'use strict';
  const SEED = ${seed};

  // ── Seeded PRNG (deterministic per session, varies between sessions) ──
  let _rngState = SEED;
  function rng() {
    _rngState = (_rngState * 1664525 + 1013904223) & 0x7fffffff;
    return (_rngState & 0xffff) / 0xffff;
  }

  // ── 1. navigator.webdriver = false ──
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  });

  // ── 2. chrome.runtime (restore for non-headless consistency) ──
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {} }; },
      sendMessage: function() {},
      onMessage: { addListener: function() {}, removeListener: function() {} },
      id: undefined,
    };
  }

  // ── 3. Plugins ──
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const p = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      p.length = 3;
      Object.setPrototypeOf(p, PluginArray.prototype);
      return p;
    },
    configurable: true,
  });

  // ── 4. Languages ──
  Object.defineProperty(navigator, 'languages', { get: () => ${languages}, configurable: true });

  // ── 5. Platform ──
  ${platform ? `Object.defineProperty(navigator, 'platform', { get: () => '${platform}', configurable: true });` : ''}

  // ── 6. Vendor ──
  ${vendor ? `Object.defineProperty(navigator, 'vendor', { get: () => '${vendor}', configurable: true });` : ''}

  // ── 7. User agent (if specified) ──
  ${ua ? `Object.defineProperty(navigator, 'userAgent', { get: () => '${ua.replace(/'/g, "\\'")}', configurable: true });` : ''}

  // ── 8. Permissions API consistency ──
  const origPermQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (origPermQuery) {
    window.navigator.permissions.query = function(desc) {
      if (desc.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origPermQuery(desc);
    };
  }

  // ── 9. WebGL vendor/renderer ──
  // If real GPU is mounted, the real values are fine. Only override if configured
  // (e.g., when GPU reports software renderer on Xvfb without /dev/dri).
  ${webglVendor || webglRenderer ? `
  const _glGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    ${webglVendor ? `if (p === 0x9245) return '${webglVendor}';` : ''}
    ${webglRenderer ? `if (p === 0x9246) return '${webglRenderer}';` : ''}
    return _glGetParam.call(this, p);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const _gl2GetParam = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      ${webglVendor ? `if (p === 0x9245) return '${webglVendor}';` : ''}
      ${webglRenderer ? `if (p === 0x9246) return '${webglRenderer}';` : ''}
      return _gl2GetParam.call(this, p);
    };
  }
  ` : '// WebGL: using real GPU values (no override needed)'}

  // ── 10. Canvas fingerprint noise ──
  // Adds imperceptible per-session noise to canvas toDataURL/toBlob.
  // This prevents cross-session fingerprint correlation without visually
  // affecting the rendered output (noise is sub-pixel level).
  const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    if (this.width > 16 && this.height > 16) {
      try {
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, Math.min(this.width, 4), Math.min(this.height, 4));
          for (let i = 0; i < imageData.data.length; i += 4) {
            // Flip least significant bit based on seeded RNG
            if (rng() < 0.1) {
              imageData.data[i] ^= 1;     // R
            }
            if (rng() < 0.1) {
              imageData.data[i+1] ^= 1;   // G
            }
          }
          ctx.putImageData(imageData, 0, 0);
        }
      } catch { /* CORS canvas — can't modify, skip */ }
    }
    return _toDataURL.call(this, type, quality);
  };

  const _toBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
    // Trigger noise via toDataURL path, then convert
    const dataUrl = this.toDataURL(type, quality);
    const byteString = atob(dataUrl.split(',')[1] || '');
    const mimeString = dataUrl.split(',')[0].split(':')[1]?.split(';')[0] || 'image/png';
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    callback(new Blob([ab], { type: mimeString }));
  };

  // ── 11. WebGL canvas noise (readPixels) ──
  const _readPixels = WebGLRenderingContext.prototype.readPixels;
  WebGLRenderingContext.prototype.readPixels = function(...args) {
    _readPixels.apply(this, args);
    const pixels = args[6]; // the ArrayBufferView
    if (pixels && pixels.length > 16) {
      for (let i = 0; i < Math.min(pixels.length, 64); i += 4) {
        if (rng() < 0.05) pixels[i] ^= 1;
      }
    }
  };

  // ── 12. Screen/window geometry consistency ──
  // Container screens report unusual values. Override with realistic desktop values.
  const W = ${screenW}, H = ${screenH};
  const TOOLBAR_H = 88; // Chrome toolbar + tab bar approximate height
  Object.defineProperty(screen, 'width', { get: () => W });
  Object.defineProperty(screen, 'height', { get: () => H });
  Object.defineProperty(screen, 'availWidth', { get: () => W });
  Object.defineProperty(screen, 'availHeight', { get: () => H - 48 }); // taskbar
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  // outerWidth/outerHeight should be slightly larger than inner (toolbar)
  Object.defineProperty(window, 'outerWidth', { get: () => W });
  Object.defineProperty(window, 'outerHeight', { get: () => H });
  // devicePixelRatio: 1 is correct for a standard display
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });

  // ── 13. navigator.connection (Network Information API) ──
  // Containers report unusual or missing values. Provide realistic desktop.
  if (navigator.connection) {
    try {
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 + Math.floor(rng() * 50) });
      Object.defineProperty(navigator.connection, 'downlink', { get: () => 5 + rng() * 15 });
      Object.defineProperty(navigator.connection, 'saveData', { get: () => false });
    } catch { /* read-only in some browsers */ }
  }

  // ── 14. navigator.hardwareConcurrency ──
  // Containers often have 1-2 cores visible. Real desktops have 4-16.
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

  // ── 15. navigator.deviceMemory ──
  // Containers may report low memory. Override with realistic value.
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // ── 16. Date/Intl timezone consistency ──
  // Ensure Intl API reports the same timezone as the TZ env var.
  // (Chrome respects TZ env, but double-check Intl.DateTimeFormat)
  // No override needed — Chrome's TZ env handling is correct.

  // ── 17. Stack trace sanitization ──
  const _Error = Error;
  const cleanStack = (stack) => stack ? stack.replace(/puppeteer|playwright|webdriver|selenium|cypress|headless|automation/gi, 'native') : stack;
  Error = class extends _Error {
    constructor(msg) {
      super(msg);
      if (this.stack) this.stack = cleanStack(this.stack);
    }
  };
  Error.prototype = _Error.prototype;
  Error.captureStackTrace = _Error.captureStackTrace;

  // ── 18. Prevent iframe-based bot detection ──
  // Some detectors create iframes and check if properties leak across frames.
  // contentWindow.chrome should match main window.
  const _createElement = document.createElement.bind(document);
  document.createElement = function(tagName, options) {
    const el = _createElement(tagName, options);
    if (tagName.toLowerCase() === 'iframe') {
      el.addEventListener('load', () => {
        try {
          if (el.contentWindow && !el.contentWindow.chrome) {
            el.contentWindow.chrome = window.chrome;
          }
        } catch { /* cross-origin */ }
      });
    }
    return el;
  };

})();
`;
}

/**
 * System fonts to install in the container for realistic font fingerprinting.
 * Returns apt package names.
 */
export function getRequiredFontPackages(): string[] {
  return [
    'fonts-liberation',           // Liberation Sans/Serif/Mono (metric-compatible with Arial/Times/Courier)
    'fonts-noto-core',            // Noto Sans/Serif (Google's universal font)
    'fonts-dejavu-core',          // DejaVu Sans/Serif/Mono
    'fonts-freefont-ttf',         // FreeSans/FreeSerif/FreeMono
    'fonts-ubuntu',               // Ubuntu font family
    'fonts-roboto',               // Roboto (Android/Material Design)
    'fonts-droid-fallback',       // Droid fallback fonts
    'fonts-open-sans',            // Open Sans
    'fonts-lato',                 // Lato
    'fontconfig',                 // Font configuration
  ];
}
