import { describe, expect, it } from 'vitest';

import { Inbox, gatewayInboxClass } from '../../src/gateway/inbox.js';
import type { InboundMessage } from '../../src/gateway/types.js';

function message(content: string, options: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: options.id ?? content,
    channelId: 'connect-test',
    channelType: 'connect',
    threadId: options.threadId ?? 'thread',
    userId: options.userId ?? 'user',
    userName: options.userName ?? 'system',
    content,
    timestamp: options.timestamp ?? Date.now(),
    ...options,
  };
}

describe('gateway scheduler inbox priority', () => {
  it('runs direct/control, then heartbeat, and drops parked assignment notices', async () => {
    const inbox = new Inbox();
    inbox.busy = true;
    inbox.push(message('[system] [Task Update] PLS-100 changed'));
    inbox.push(message('[system] incident: database unavailable'));
    inbox.push(message('[HEARTBEAT]', { source: 'heartbeat', userName: 'heartbeat' }));
    inbox.busy = false;

    expect(gatewayInboxClass(await inbox.next())).toBe('direct-control');
    expect(gatewayInboxClass(await inbox.next())).toBe('heartbeat');
    expect(inbox.depth).toBe(0);
  });

  it('coalesces heartbeat ticks while one checkpoint is pending', () => {
    const inbox = new Inbox();
    inbox.busy = true;
    inbox.push(message('heartbeat one', { source: 'heartbeat', id: 'heartbeat-1' }));
    inbox.push(message('heartbeat two', { source: 'heartbeat', id: 'heartbeat-2' }));

    expect(inbox.depth).toBe(1);
    expect(inbox.hasClass('heartbeat')).toBe(true);
  });

  it('coalesces routine updates by task key and retains the newest hint', async () => {
    const inbox = new Inbox();
    inbox.busy = true;
    inbox.push(message('[system] [Task Assigned] PLS-496 old head'));
    inbox.push(message('[system] [Task Update] PLS-496 fresh head'));

    expect(inbox.depth).toBe(1);
    expect((await inbox.next()).content).toContain('fresh head');
  });

  it('does not demote non-routine system alerts', async () => {
    const inbox = new Inbox();
    inbox.busy = true;
    inbox.push(message('[system] [Review Seat Starvation] PLS-509'));
    inbox.push(message('[system] [Routability Hold] PLAT-4829'));
    inbox.push(message('[system] [Security Alert] rotate compromised key'));
    inbox.busy = false;

    expect((await inbox.next()).content).toContain('Security Alert');
  });

  it('does not start a turn for Task Assigned while a work session is live', async () => {
    const inbox = new Inbox();
    inbox.push(message('[hritik] keep going on VEN-229', { userName: 'hritik' }));
    expect(gatewayInboxClass(await inbox.next())).toBe('direct-control');

    inbox.push(message('[system] [Task Assigned] HIVE-1687: QA failure'));
    inbox.push(message('[system] [Task Assigned] ORIG-230: probe'));

    let admitted = false;
    const pending = inbox.next().then((row) => {
      admitted = true;
      return row;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(inbox.depth).toBe(2);

    inbox.push(message('[HEARTBEAT]', { source: 'heartbeat', userName: 'heartbeat' }));
    const row = await pending;
    expect(row.source).toBe('heartbeat');
    expect(admitted).toBe(true);
    expect(inbox.depth).toBe(0);
  });

  it('lets a real user DM interrupt a work session immediately', async () => {
    const inbox = new Inbox();
    inbox.push(message('[hritik] first', { userName: 'hritik' }));
    await inbox.next();
    inbox.push(message('[system] [Task Assigned] PLS-496 old head'));

    let admitted = false;
    const pending = inbox.next().then((row) => {
      admitted = true;
      return row;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    inbox.push(message('[hritik] stop and look at this', { userName: 'hritik' }));
    const row = await pending;
    expect(row.content).toContain('stop and look at this');
    expect(inbox.depth).toBe(1);
  });

  it('wakes an idle agent with one coalesced digest for a burst of assignments', async () => {
    const inbox = new Inbox();
    inbox.push(message('[system] [Task Assigned] HIVE-1687: one'));
    inbox.push(message('[system] [Task Assigned] ORIG-230: two'));
    inbox.push(message('[system] [Task Update] PLS-854: three'));

    const row = await inbox.next();
    expect(row.metadata?.syntheticDigest).toBe(true);
    expect(row.content).toContain('HIVE-1687');
    expect(row.content).toContain('ORIG-230');
    expect(row.content).toContain('PLS-854');
    expect(inbox.depth).toBe(0);
  });

  it('still injects a single idle Task Assigned as itself', async () => {
    const inbox = new Inbox();
    inbox.push(message('[system] [Task Assigned] HIVE-1687: one'));
    const row = await inbox.next();
    expect(row.content).toContain('[Task Assigned] HIVE-1687');
    expect(row.metadata?.syntheticDigest).toBeUndefined();
  });

  it('rejects new admissions while a runtime-roll ingress fence is sealed', () => {
    const inbox = new Inbox();
    expect(inbox.tryPush(message('accepted-before-fence'))).toBe(true);
    const version = inbox.admissionVersion;

    inbox.sealIngress();
    expect(inbox.tryPush(message('rejected-during-fence'))).toBe(false);
    expect(inbox.depth).toBe(1);
    expect(inbox.admissionVersion).toBe(version);

    inbox.unsealIngress();
    expect(inbox.tryPush(message('accepted-after-fence'))).toBe(true);
    expect(inbox.admissionVersion).toBe(version + 1);
  });
});
