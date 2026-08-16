#!/usr/bin/env node
import { PassThrough } from 'node:stream';
import React from 'react';
import { Box, render } from 'ink';
import { InputBox } from '../src/tui/components/InputBox.js';
import { ConversationViewport } from '../src/tui/components/ConversationViewport.js';

const WARMUP_SAMPLES = 12;
const MEASURED_SAMPLES = 60;
const SAMPLE_TIMEOUT_MS = 2_000;

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
  // Match App's stdout proxy: components use the real size, while Ink never
  // enters its clear-the-whole-terminal branch.
  stream.rows = 9_999;
  stream.isTTY = true;
  return stream;
}

function percentile(sorted: number[], value: number): number {
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function measureScenario(name: string, transcript: string): Promise<{
  name: string;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}> {
  const stdin = fakeInput();
  const stdout = fakeOutput();
  const stderr = fakeOutput();
  let nextWrite: ((elapsedMs: number) => void) | null = null;
  let nextWriteStartedAt = 0;
  // Always drain the virtual terminal and timestamp the first write caused by
  // the pending key. This is the same input-event -> terminal-write boundary
  // used by the live tmux probe.
  stdout.on('data', () => {
    if (!nextWrite) return;
    const resolve = nextWrite;
    nextWrite = null;
    resolve(performance.now() - nextWriteStartedAt);
  });
  stderr.on('data', () => {});

  const app = render(
    React.createElement(
      Box,
      { flexDirection: 'column', minHeight: 43 },
      React.createElement(ConversationViewport, {
        completedEntries: [
          { id: `${name}-1`, role: 'assistant', content: transcript, timestamp: 1 },
          { id: `${name}-2`, role: 'assistant', content: transcript, timestamp: 2 },
        ],
        columns: 100,
        rows: 24,
      }),
      React.createElement(InputBox, {
        onSubmit: () => {},
        isProcessing: true,
        draftValue: '',
        draftVersion: 0,
        onDraftChange: () => {},
      }),
    ),
    {
      stdin,
      stdout,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 0,
    },
  );

  await delay(100);
  const samples: number[] = [];
  const total = WARMUP_SAMPLES + MEASURED_SAMPLES;
  for (let i = 0; i < total; i++) {
    const key = i % 2 === 0 ? 'x' : '\u007f';
    const sample = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        nextWrite = null;
        reject(new Error(`${name}: no terminal write within ${SAMPLE_TIMEOUT_MS}ms`));
      }, SAMPLE_TIMEOUT_MS);
      nextWrite = (elapsedMs) => {
        clearTimeout(timer);
        resolve(elapsedMs);
      };
      nextWriteStartedAt = performance.now();
      stdin.write(key);
    });
    if (i >= WARMUP_SAMPLES) samples.push(sample);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  app.unmount();
  app.cleanup();
  stdin.end();
  stdout.end();
  stderr.end();
  samples.sort((a, b) => a - b);
  return {
    name,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: samples[samples.length - 1] ?? 0,
  };
}

const short = await measureScenario('short', 'Short transcript line.');
const huge = await measureScenario(
  'huge',
  Array.from({ length: 20_000 }, (_, index) => `long transcript row ${index}`).join('\n'),
);

for (const result of [short, huge]) {
  process.stdout.write(
    `${result.name}: p50=${result.p50Ms.toFixed(3)}ms `
    + `p95=${result.p95Ms.toFixed(3)}ms max=${result.maxMs.toFixed(3)}ms\n`,
  );
}
process.stdout.write(`huge/short p95 slope=${(huge.p95Ms / Math.max(0.001, short.p95Ms)).toFixed(2)}x\n`);

// Shared runners can have scheduling noise; the hard contract is both a small
// absolute budget and no transcript-length slope. Live QA applies the tighter
// operator target on the deployed binary.
if (huge.p95Ms > 25 || huge.p95Ms > Math.max(8, short.p95Ms * 2.0 + 2)) {
  throw new Error(
    `TUI input latency regression: short p95=${short.p95Ms.toFixed(3)}ms, `
    + `huge p95=${huge.p95Ms.toFixed(3)}ms`,
  );
}
