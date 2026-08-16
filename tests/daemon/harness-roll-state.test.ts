import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readHarnessRollState,
  writeHarnessRollState,
} from '../../src/daemon/harness-roll-state.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('harness roll state', () => {
  it('round-trips restart progress atomically', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roll-state-'));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, 'state.json');
    const desiredImage = 'registry/runtime:desired';

    writeHarnessRollState(statePath, {
      desiredImage,
      lastRollAt: 1234,
      inFlightAgentIds: ['a', 'b'],
      driftSince: { [`c\0${desiredImage}`]: 456 },
      deferrals: {
        [`c\0${desiredImage}`]: {
          since: 789,
          agent: 'sora',
          reason: 'bridge-busy',
          protocol: 'drain-v1',
          alerted: true,
        },
      },
    });

    expect(readHarnessRollState(statePath, desiredImage)).toEqual({
      desiredImage,
      lastRollAt: 1234,
      inFlightAgentIds: ['a', 'b'],
      driftSince: { [`c\0${desiredImage}`]: 456 },
      deferrals: {
        [`c\0${desiredImage}`]: {
          since: 789,
          agent: 'sora',
          reason: 'bridge-busy',
          protocol: 'drain-v1',
          alerted: true,
        },
      },
    });
    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });

  it('carries pacing and unresolved-tail age across a superseded target but reprobes drains', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roll-state-'));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, 'state.json');
    const oldImage = 'registry/runtime:old';
    const newImage = 'registry/runtime:new';
    writeHarnessRollState(statePath, {
      desiredImage: oldImage,
      lastRollAt: 1234,
      inFlightAgentIds: ['a'],
      driftSince: {
        [`tail\0${oldImage}`]: 456,
        [`converged\0${newImage}`]: 789,
      },
      deferrals: {
        [`tail\0${oldImage}`]: {
          since: 321,
          agent: 'sara',
          reason: 'probe-failed',
          protocol: 'unknown',
          alerted: false,
        },
      },
    });

    expect(readHarnessRollState(statePath, newImage)).toEqual({
      desiredImage: newImage,
      lastRollAt: 1234,
      // The old requestId is derived from the old target and cannot authorize
      // the successor. The real controller sequence must obtain a new bridge
      // drain/legacy-idle proof before changing this agent's pod template.
      inFlightAgentIds: [],
      driftSince: {
        [`tail\0${newImage}`]: 456,
      },
      deferrals: {
        [`tail\0${newImage}`]: {
          since: 321,
          agent: 'sara',
          reason: 'probe-failed',
          protocol: 'unknown',
          alerted: false,
        },
      },
    });
  });

  it('drops malformed persisted deferrals instead of exporting unbounded labels', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roll-state-'));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, 'state.json');
    const desiredImage = 'registry/runtime:desired';
    fs.writeFileSync(statePath, JSON.stringify({
      desiredImage,
      lastRollAt: 0,
      inFlightAgentIds: [],
      driftSince: {},
      deferrals: {
        [`ok\0${desiredImage}`]: {
          since: 123,
          agent: 'ok',
          reason: 'bridge-busy',
          protocol: 'drain-v1',
          alerted: false,
        },
        [`bad\0${desiredImage}`]: {
          since: 123,
          agent: 'bad',
          reason: 'free-form-error-text',
          protocol: 'anything',
          alerted: false,
        },
      },
    }));

    expect(readHarnessRollState(statePath, desiredImage)?.deferrals).toEqual({
      [`ok\0${desiredImage}`]: {
        since: 123,
        agent: 'ok',
        reason: 'bridge-busy',
        protocol: 'drain-v1',
        alerted: false,
      },
    });
  });
});
