import { afterEach, describe, expect, it } from 'vitest';
import { daemonEndpoint } from '../../src/auth/agent-gateway.js';

// PLAT-7611 regression: the people-ops primitives (list_agents/resume_agent/
// pause_agent) ECONNREFUSEDed on 127.0.0.1:8015 on every fleet seat because the
// client default predated the container-port unification — every managed agent
// runtime is started with `--port 8080` (daemon/manager.ts
// CONTAINER_INTERNAL_PORT = 8080). The client default must match the port the
// local gateway actually listens on.
describe('agent gateway daemon endpoint (PLAT-7611)', () => {
  const originalPort = process.env['DAEMON_PORT'];
  const originalHost = process.env['DAEMON_HOST'];

  afterEach(() => {
    if (originalPort === undefined) delete process.env['DAEMON_PORT'];
    else process.env['DAEMON_PORT'] = originalPort;
    if (originalHost === undefined) delete process.env['DAEMON_HOST'];
    else process.env['DAEMON_HOST'] = originalHost;
  });

  it('defaults to the container-agent gateway port 8080 on loopback', () => {
    delete process.env['DAEMON_PORT'];
    delete process.env['DAEMON_HOST'];
    expect(daemonEndpoint()).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('honors an explicit DAEMON_PORT override (dev runs on 8015)', () => {
    process.env['DAEMON_PORT'] = '8015';
    expect(daemonEndpoint()).toEqual({ host: '127.0.0.1', port: 8015 });
  });

  it('honors DAEMON_HOST for non-loopback daemon endpoints', () => {
    process.env['DAEMON_HOST'] = '10.43.81.15';
    expect(daemonEndpoint()).toEqual({ host: '10.43.81.15', port: 8080 });
  });
});
