import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// BRW-36: human-mode browser screenshots failed in live QA with
//   /bin/sh: 1: xwd: not found
//   /bin/sh: 1: convert: not found
// Root cause: the DinD agent image (AGENT_DOCKERFILE in manager.ts) installed
// Xvfb + openbox + Chrome but NOT the X11 screenshot tools. The display
// screenshot fallback chain (src/input-devices/display.ts) tries scrot →
// ImageMagick `import` → `xwd | convert`; with none installed every screenshot
// after the first CDP capture failed, blocking pixel evidence for live QA.
// This guard keeps the screenshot-tool packages in the DinD image's browser
// dependency layer so the fallback chain can never be empty again.
describe('BRW-36 — DinD image ships X11 screenshot tools', () => {
  const managerSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/daemon/manager.ts'),
    'utf-8',
  );

  it('installs scrot (first-choice display capture) in the browser dep layer', () => {
    // The Layer 3 apt-get install list must include scrot.
    const layer3 = managerSource.match(
      /Layer 3: Browser dependencies[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
    expect(layer3, 'expected Layer 3 browser deps block in AGENT_DOCKERFILE').not.toBeNull();
    expect(layer3![0]).toMatch(/\bscrot\b/);
  });

  it('installs imagemagick (provides import + convert) in the browser dep layer', () => {
    const layer3 = managerSource.match(
      /Layer 3: Browser dependencies[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
    expect(layer3, 'expected Layer 3 browser deps block in AGENT_DOCKERFILE').not.toBeNull();
    expect(layer3![0]).toMatch(/\bimagemagick\b/);
  });

  it('installs x11-apps (provides xwd) in the browser dep layer', () => {
    const layer3 = managerSource.match(
      /Layer 3: Browser dependencies[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
    expect(layer3, 'expected Layer 3 browser deps block in AGENT_DOCKERFILE').not.toBeNull();
    expect(layer3![0]).toMatch(/\bx11-apps\b/);
  });

  it('keeps Xvfb + openbox in the same layer (human-mode display runtime)', () => {
    const layer3 = managerSource.match(
      /Layer 3: Browser dependencies[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
    expect(layer3, 'expected Layer 3 browser deps block in AGENT_DOCKERFILE').not.toBeNull();
    expect(layer3![0]).toMatch(/\bxvfb\b/);
    expect(layer3![0]).toMatch(/\bopenbox\b/);
  });
});
