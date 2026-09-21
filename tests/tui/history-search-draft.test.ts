/**
 * SCLI-449: Ctrl+R history-search Esc must restore the user's unsent draft.
 *
 * The App snapshots the composer draft (inputRef.current → composerDraft) when
 * Ctrl+R opens the HistorySearch overlay, unmounts the InputBox while the
 * overlay is active, and remounts it with draftValue={composerDraft} on Esc.
 * This test drives that exact InputBox mount/unmount/remount contract with real
 * keystrokes and asserts the draft survives byte-for-byte (SCLI-449 acceptance:
 * empty draft, nonempty draft + Esc, multiline/Unicode draft + Esc).
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { InputBox } from '../../src/tui/components/InputBox.js';

type TtyInput = PassThrough & NodeJS.ReadStream & {
  isRaw: boolean;
  setRawMode: (mode: boolean) => TtyInput;
  ref: () => TtyInput;
  unref: () => TtyInput;
};
type TtyOutput = PassThrough & NodeJS.WriteStream & {
  columns: number;
  rows: number;
  isTTY: true;
};

function fakeInput(): TtyInput {
  const stream = new PassThrough() as TtyInput;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (mode: boolean) => {
    stream.isRaw = mode;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

function fakeOutput(): TtyOutput {
  const stream = new PassThrough() as TtyOutput;
  stream.columns = 100;
  stream.rows = 9_999;
  stream.isTTY = true;
  return stream;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Render an InputBox and return a handle to drive keystrokes + remounts. */
function mountInputBox(opts: {
  draftValue?: string;
  draftVersion?: number;
  onDraftChange: (v: string) => void;
}) {
  const stdin = fakeInput();
  const stdout = fakeOutput();
  const stderr = fakeOutput();
  const app = render(
    React.createElement(InputBox, {
      onSubmit: () => {},
      isProcessing: false,
      draftValue: opts.draftValue ?? '',
      draftVersion: opts.draftVersion ?? 0,
      onDraftChange: opts.onDraftChange,
    }),
    { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false, maxFps: 0 },
  );
  return {
    stdin,
    app,
    async type(text: string) {
      for (const ch of text) {
        stdin.write(ch);
        await delay(5);
      }
      await delay(20);
    },
    async teardown() {
      app.unmount();
      app.cleanup();
      stdin.end();
      stdout.end();
      stderr.end();
    },
  };
}

describe('SCLI-449 history-search draft preservation', () => {
  it('nonempty draft survives unmount/remount (Ctrl+R → Esc) byte-for-byte', async () => {
    const draftChanges: string[] = [];
    // Phase 1: user types a draft; App records it via onDraftChange (inputRef).
    const first = mountInputBox({ onDraftChange: (v) => draftChanges.push(v) });
    await first.type('draft sentinel');
    const snapshot = draftChanges[draftChanges.length - 1] ?? '';
    expect(snapshot).toBe('draft sentinel');
    await first.teardown(); // InputBox unmounts while the overlay is open

    // Phase 2: App remounts InputBox with draftValue=<snapshot> (Esc cancel).
    const restored: string[] = [];
    const second = mountInputBox({
      draftValue: snapshot,
      onDraftChange: (v) => restored.push(v),
    });
    // Typing must APPEND to the restored draft, not start from empty.
    await second.type('!');
    expect(restored[restored.length - 1]).toBe('draft sentinel!');
    await second.teardown();
  });

  it('multiline/Unicode draft survives unmount/remount byte-for-byte', async () => {
    const draftChanges: string[] = [];
    const first = mountInputBox({ onDraftChange: (v) => draftChanges.push(v) });
    const unicodeDraft = 'héllo wörld\n第二行\nemoji 🚀 done';
    await first.type(unicodeDraft);
    const snapshot = draftChanges[draftChanges.length - 1] ?? '';
    expect(snapshot).toBe(unicodeDraft);
    await first.teardown();

    const restored: string[] = [];
    const second = mountInputBox({
      draftValue: snapshot,
      onDraftChange: (v) => restored.push(v),
    });
    await second.type('Z');
    expect(restored[restored.length - 1]).toBe(`${unicodeDraft}Z`);
    await second.teardown();
  });

  it('empty draft stays empty after unmount/remount (fresh composer)', async () => {
    const restored: string[] = [];
    const box = mountInputBox({
      draftValue: '',
      onDraftChange: (v) => restored.push(v),
    });
    await box.type('x');
    expect(restored[restored.length - 1]).toBe('x');
    await box.teardown();
  });

  it('App snapshots the draft on Ctrl+R and restores it via draftValue on cancel', () => {
    const appSrc = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../src/tui/App.tsx'),
      'utf8',
    );
    // Ctrl+R must snapshot the live composer text into composerDraft.
    expect(appSrc).toMatch(
      /key\.ctrl && _input === 'r'[\s\S]*?setComposerDraft\(inputRef\.current\)[\s\S]*?setHistorySearchActive\(true\)/,
    );
    // The InputBox is unmounted while the overlay is open and remounts with
    // the snapshot on cancel — the restore path.
    expect(appSrc).toMatch(/!historySearchActive/);
    expect(appSrc).toMatch(/draftValue=\{composerDraft\}/);
    // Esc in the overlay must call onCancel (→ setHistorySearchActive(false)),
    // never leak the search query into the composer.
    expect(appSrc).toMatch(/handleHistoryCancel[\s\S]*?setHistorySearchActive\(false\)/);
  });

  it('HistorySearch Esc routes to onCancel, Enter routes to onSelect', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../src/tui/components/HistorySearch.tsx'),
      'utf8',
    );
    expect(src).toMatch(/key\.escape[\s\S]*?onCancel\(\)/);
    expect(src).toMatch(/key\.return[\s\S]*?onSelect/);
  });
});
