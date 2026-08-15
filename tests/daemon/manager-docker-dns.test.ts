import { describe, expect, it } from 'vitest';

import { resolveAgentDockerDnsArgs } from '../../src/daemon/manager.js';


describe('runtime-fleet nested Docker DNS', () => {
  it('forwards Kubernetes CoreDNS and search domains to agent containers', () => {
    const resolv = [
      'search rt-fleet.svc.cluster.local svc.cluster.local cluster.local',
      'nameserver 10.43.0.10',
      'options ndots:5',
    ].join('\n');

    expect(resolveAgentDockerDnsArgs(resolv, '')).toEqual([
      '--dns', '10.43.0.10',
      '--dns-search', 'rt-fleet.svc.cluster.local',
      '--dns-search', 'svc.cluster.local',
      '--dns-search', 'cluster.local',
    ]);
  });

  it('keeps ordinary workstation Docker resolver behavior unchanged', () => {
    const resolv = [
      'search tail.shizuha.com lan',
      'nameserver 127.0.0.53',
    ].join('\n');

    expect(resolveAgentDockerDnsArgs(resolv, '')).toEqual([]);
  });

  it('supports an explicit non-loopback resolver override', () => {
    expect(resolveAgentDockerDnsArgs('nameserver 127.0.0.53', '10.43.0.10, 1.1.1.1')).toEqual([
      '--dns', '10.43.0.10',
      '--dns', '1.1.1.1',
    ]);
  });

  it('does not inject a loopback-only Kubernetes resolver', () => {
    const resolv = [
      'search svc.cluster.local cluster.local',
      'nameserver 127.0.0.53',
    ].join('\n');

    expect(resolveAgentDockerDnsArgs(resolv, '')).toEqual([]);
  });
});
