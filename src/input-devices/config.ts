/**
 * Browser tool config loader.
 *
 * Reads ~/.shizuha/browser.toml for sensitive settings (proxy credentials,
 * stealth overrides) that must not be in source code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BrowserProxyConfig {
  /** SOCKS5/HTTP proxy URL (e.g., "socks5://1.2.3.4:1080") */
  url: string;
  /** Proxy auth username */
  username?: string;
  /** Proxy auth password */
  password?: string;
}

export interface BrowserStealthConfig {
  /** Custom user agent string */
  userAgent?: string;
  /** Browser locale (e.g., "en-US") */
  locale?: string;
  /** Timezone (e.g., "America/New_York") */
  timezone?: string;
  /** Viewport width */
  viewportWidth?: number;
  /** Viewport height */
  viewportHeight?: number;
  /** WebGL vendor string override */
  webglVendor?: string;
  /** WebGL renderer string override */
  webglRenderer?: string;
}

export interface BrowserToolConfig {
  proxy?: BrowserProxyConfig;
  stealth?: BrowserStealthConfig;
}

/** Default config when no file exists. */
const DEFAULT_CONFIG: BrowserToolConfig = {};

/**
 * Load browser config from ~/.shizuha/browser.toml.
 * Returns defaults if file doesn't exist.
 */
export function loadBrowserConfig(): BrowserToolConfig {
  const configPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'browser.toml');

  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    // Dynamic import smol-toml (already a project dependency)
    const { parse } = require('smol-toml') as { parse: (s: string) => Record<string, unknown> };
    const data = parse(raw);

    const config: BrowserToolConfig = {};

    // [proxy] section
    const proxy = data['proxy'] as Record<string, unknown> | undefined;
    if (proxy?.url) {
      config.proxy = {
        url: String(proxy.url),
        username: proxy.username ? String(proxy.username) : undefined,
        password: proxy.password ? String(proxy.password) : undefined,
      };
    }

    // [stealth] section
    const stealth = data['stealth'] as Record<string, unknown> | undefined;
    if (stealth) {
      config.stealth = {
        userAgent: stealth.user_agent ? String(stealth.user_agent) : undefined,
        locale: stealth.locale ? String(stealth.locale) : undefined,
        timezone: stealth.timezone ? String(stealth.timezone) : undefined,
        viewportWidth: stealth.viewport_width ? Number(stealth.viewport_width) : undefined,
        viewportHeight: stealth.viewport_height ? Number(stealth.viewport_height) : undefined,
        webglVendor: stealth.webgl_vendor ? String(stealth.webgl_vendor) : undefined,
        webglRenderer: stealth.webgl_renderer ? String(stealth.webgl_renderer) : undefined,
      };
    }

    return config;
  } catch (err) {
    console.warn(`[browser-config] Failed to parse browser.toml: ${(err as Error).message}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Build a proxy URL with embedded credentials for Chrome's --proxy-server flag.
 * Chrome doesn't support username:password in the proxy URL directly for SOCKS,
 * so for authenticated SOCKS proxies we'll need to use a local proxy forwarder.
 */
export function buildProxyUrl(proxy: BrowserProxyConfig): string {
  // For HTTP proxies, credentials can be embedded
  if (proxy.url.startsWith('http') && proxy.username) {
    const url = new URL(proxy.url);
    url.username = proxy.username;
    if (proxy.password) url.password = proxy.password;
    return url.toString();
  }

  // For SOCKS5, Chrome accepts the URL directly but auth requires
  // a helper like microsocks or dante. Return the URL as-is;
  // the session will set up auth separately if needed.
  return proxy.url;
}
