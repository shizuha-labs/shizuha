import { describe, expect, it } from 'vitest';
import {
  cmdlineLooksLikeShizuhaDaemon,
  isShizuhaDaemonProcess,
} from '../../src/daemon/state.js';

describe('isShizuhaDaemonProcess — tini/init safety', () => {
  it('never treats pid 0/1 as a shizuha daemon', () => {
    expect(isShizuhaDaemonProcess(1)).toBe(false);
    expect(isShizuhaDaemonProcess(0)).toBe(false);
    expect(isShizuhaDaemonProcess(-3)).toBe(false);
  });

  it('rejects tini cmdlines that only forward up + a shizuha-* platform URL', () => {
    const tini =
      '/usr/bin/tini\0--\0/usr/local/bin/agent-runtime-entrypoint.sh\0up\0--foreground\0--no-service\0--platform\0http://shizuha-nginx.shizuha.svc.cluster.local';
    expect(cmdlineLooksLikeShizuhaDaemon(tini)).toBe(false);
  });

  it('accepts the real node shizuha.js up process', () => {
    expect(cmdlineLooksLikeShizuhaDaemon(
      '/usr/bin/node\0/opt/shizuha/dist/shizuha.js\0up\0--foreground',
    )).toBe(true);
    expect(cmdlineLooksLikeShizuhaDaemon(
      'node\0/home/user/.shizuha/lib/shizuha.js\0up\0--platform\0http://example',
    )).toBe(true);
  });

  it('rejects a host systemd-style cmdline even if it mentions shizuha', () => {
    expect(cmdlineLooksLikeShizuhaDaemon(
      '/sbin/init\0splash\0shizuha-boot',
    )).toBe(false);
  });
});
