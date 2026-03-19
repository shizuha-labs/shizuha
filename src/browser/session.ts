import type { Browser, BrowserContext, Page } from 'playwright';

const MAX_TEXT_SIZE = 100 * 1024; // 100KB
const PAGE_LOAD_TIMEOUT = 30_000; // 30s
const IDLE_TIMEOUT = 5 * 60_000; // 5 minutes

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onClose?: () => void;

  constructor(onClose?: () => void) {
    this.onClose = onClose;
  }

  /** Lazy-init: launch browser on first use */
  private async ensurePage(): Promise<Page> {
    this.resetIdleTimer();

    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    if (!this.browser) {
      const { chromium } = await import('playwright');

      // Playwright finds its bundled Chromium automatically via PLAYWRIGHT_BROWSERS_PATH.
      // Override only if CHROME_PATH is explicitly set (e.g., system Chromium on host).
      const executablePath = process.env['CHROME_PATH'] || undefined;

      // Enable GPU acceleration if NVIDIA runtime is available
      const gpuArgs = process.env['NVIDIA_VISIBLE_DEVICES']
        ? ['--enable-gpu-rasterization', '--enable-zero-copy', '--ignore-gpu-blocklist']
        : [];

      this.browser = await chromium.launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          ...gpuArgs,
        ],
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Shizuha/0.1 (Browser Tool)',
        ignoreHTTPSErrors: true, // Container proxy uses self-signed certs
      });
    }

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);
    return this.page;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, IDLE_TIMEOUT);
  }

  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_LOAD_TIMEOUT,
    });
    const status = response?.status() ?? 0;
    const title = await page.title();
    return `Navigated to ${url} (HTTP ${status}). Title: "${title}"`;
  }

  async screenshot(): Promise<string> {
    const page = await this.ensurePage();
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return buffer.toString('base64');
  }

  async click(selector: string): Promise<string> {
    const page = await this.ensurePage();
    await page.click(selector, { timeout: 15_000 });
    // Wait briefly for any navigation/render triggered by click
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => { /* ignore */ });
    return `Clicked element: ${selector}`;
  }

  async type(selector: string, text: string): Promise<string> {
    const page = await this.ensurePage();
    await page.fill(selector, text, { timeout: 15_000 });
    return `Typed "${text.length > 50 ? text.slice(0, 50) + '...' : text}" into ${selector}`;
  }

  async scroll(direction: 'up' | 'down'): Promise<string> {
    const page = await this.ensurePage();
    const delta = direction === 'down' ? 600 : -600;
    await page.mouse.wheel(0, delta);
    // Small pause for scroll to complete
    await page.waitForTimeout(300);
    return `Scrolled ${direction}`;
  }

  async getText(selector?: string): Promise<string> {
    const page = await this.ensurePage();

    let text: string;
    if (selector) {
      text = await page.locator(selector).innerText({ timeout: 15_000 });
    } else {
      // Remove scripts and styles, then extract text.
      // Using string form to avoid TypeScript DOM lib requirement (runs in browser context).
      text = await page.evaluate(`(() => {
        const clone = document.body.cloneNode(true);
        for (const el of clone.querySelectorAll('script, style, noscript, svg')) {
          el.remove();
        }
        return clone.innerText || clone.textContent || '';
      })()`);
    }

    // Clean up whitespace
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    if (text.length > MAX_TEXT_SIZE) {
      text = text.slice(0, MAX_TEXT_SIZE) + '\n[Content truncated at 100KB]';
    }

    return text;
  }

  async evaluate(script: string): Promise<string> {
    const page = await this.ensurePage();
    const result = await page.evaluate(script);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  async back(): Promise<string> {
    const page = await this.ensurePage();
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
    const title = await page.title();
    const url = page.url();
    return `Navigated back to ${url}. Title: "${title}"`;
  }

  async close(): Promise<string> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => { /* ignore */ });
    }
    this.page = null;

    if (this.context) {
      await this.context.close().catch(() => { /* ignore */ });
    }
    this.context = null;

    if (this.browser) {
      await this.browser.close().catch(() => { /* ignore */ });
    }
    this.browser = null;

    this.onClose?.();
    return 'Browser session closed.';
  }

  get isActive(): boolean {
    return this.browser !== null;
  }
}
