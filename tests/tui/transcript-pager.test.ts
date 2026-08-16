/**
 * SCLI-382: transcript pager content + navigation contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flattenTranscript } from '../../src/tui/components/TranscriptPager.js';
import type { TranscriptEntry } from '../../src/tui/state/types.js';

const repoRoot = resolve(__dirname, '../..');

describe('SCLI-382 TranscriptPager', () => {
  it('flattenTranscript includes long plain and table assistant content', () => {
    const plainLines = Array.from({ length: 70 }, (_, i) =>
      `SCROLL_${String(i + 1).padStart(3, '0')}`,
    ).join('\n');
    const tableRows = [
      '| id | name |',
      '| --- | --- |',
      ...Array.from({ length: 60 }, (_, i) => `| TBL${String(i + 1).padStart(3, '0')} | row |`),
    ].join('\n');

    const entries: TranscriptEntry[] = [
      { id: 'u1', role: 'user', content: 'print 70 lines', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: plainLines, timestamp: 2 },
      { id: 'u2', role: 'user', content: 'print table', timestamp: 3 },
      { id: 'a2', role: 'assistant', content: tableRows, timestamp: 4 },
    ];

    const flat = flattenTranscript(entries);
    expect(flat).toContain('SCROLL_001');
    expect(flat).toContain('SCROLL_070');
    expect(flat).toContain('TBL001');
    expect(flat).toContain('TBL060');
    expect(flat.split('\n').length).toBeGreaterThan(70);
  });

  it('can omit tool cards from the live conversation while retaining pager detail', () => {
    const entries: TranscriptEntry[] = [{
      id: 'a-tool',
      role: 'assistant',
      content: 'Checking the fleet.',
      timestamp: 1,
      toolCalls: [{
        id: 'tool-1',
        name: 'bash',
        input: { command: 'kubectl get pods -A' },
        commandPreview: 'kubectl get pods -A',
        status: 'complete',
        result: 'VERY_VERBOSE_TOOL_OUTPUT',
      }],
    }];

    expect(flattenTranscript(entries, 100)).toContain('VERY_VERBOSE_TOOL_OUTPUT');
    const live = flattenTranscript(entries, 100, { includeTools: false });
    expect(live).toContain('Checking the fleet.');
    expect(live).not.toContain('bash');
    expect(live).not.toContain('VERY_VERBOSE_TOOL_OUTPUT');
  });

  it('App isolates pager as sole Ink root and preserves composer draft', () => {
    const app = readFileSync(resolve(repoRoot, 'src/tui/App.tsx'), 'utf8');
    expect(app).toMatch(/screen === 'pager'/);
    expect(app).toMatch(/sole Ink root|only Ink/);
    expect(app).toContain('composerDraft');
    expect(app).toContain('draftValue={composerDraft}');
    // Must not render StatusBar alongside pager
    expect(app).toMatch(/if \(ready && screen === 'pager'\)[\s\S]*return \(/);
  });

  it('TranscriptPager binds PageUp/PageDown and starts near end', () => {
    const src = readFileSync(resolve(repoRoot, 'src/tui/components/TranscriptPager.tsx'), 'utf8');
    expect(src).toMatch(/pageUp/);
    expect(src).toMatch(/pageDown/);
    expect(src).toMatch(/useState\(maxOffset\)/);
    expect(src).toMatch(/Transcript/);
  });

  it('getPagerTranscript loads full history on demand without a lifetime cache', () => {
    const src = readFileSync(resolve(repoRoot, 'src/tui/hooks/useAgentSession.ts'), 'utf8');
    expect(src).toMatch(/loadTranscriptMessagesForDisplay/);
    expect(src).not.toMatch(/pagerTranscriptCacheRef/);
  });
});
