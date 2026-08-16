/**
 * Verify that the bridge correctly disables itself in remote mode.
 *
 * Expected:
 *   - Page loads with no JS errors
 *   - Bridge logs "[connect-bridge] backend mode = remote — bridge disabled"
 *   - NO WebSocket attempts to /connect/ws/connect/user/
 *   - Existing /ws/chat WebSocket still appears (legacy path)
 */
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const errors: string[] = [];
  const consoleLines: string[] = [];
  const wsAttempts: string[] = [];

  page.on('pageerror', (e) => errors.push('JS_ERROR: ' + e.message));
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('websocket', (ws) => wsAttempts.push(ws.url()));

  await page.goto('https://localhost:8015/', { waitUntil: 'domcontentloaded', timeout: 12000 });
  // Bridge runs on dashboardAuthState 'authenticated' — without auth it stays
  // gated. To simulate auth, set the cookie to anything (real validation
  // happens server-side). The bridge's backend-mode probe doesn't require auth.
  await page.waitForTimeout(5000);

  console.log('=== Page errors ===');
  errors.forEach((e) => console.log('  ' + e));
  console.log(errors.length === 0 ? '  (none)' : '');

  console.log('');
  console.log('=== Console lines mentioning bridge ===');
  consoleLines
    .filter((l) => l.toLowerCase().includes('bridge') || l.toLowerCase().includes('connect'))
    .forEach((l) => console.log('  ' + l));

  console.log('');
  console.log('=== WebSocket attempts ===');
  wsAttempts.forEach((u) => console.log('  ' + u));
  if (wsAttempts.length === 0) console.log('  (none — page never authenticated)');

  const sawConnectUserWs = wsAttempts.some((u) => u.includes('/connect/ws/connect/user/'));
  const sawWsChat = wsAttempts.some((u) => u.includes('/ws/chat'));
  console.log('');
  console.log('SUMMARY:');
  console.log(`  Connect-direct WS attempt: ${sawConnectUserWs ? 'YES (bug — bridge should be disabled in remote mode)' : 'no (expected)'}`);
  console.log(`  /ws/chat WS attempt: ${sawWsChat ? 'yes (expected — legacy path active)' : 'no (page may not be authenticated)'}`);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
