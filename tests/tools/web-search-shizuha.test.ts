/**
 * Shizuha Search must work for SCLI agents — fleet AND host TUI.
 *
 * Operator 2026-08-05: "it's our inhouse search service .. but currently seems
 * broken for use with scli agents .. ensure that it is working for our agents".
 *
 * Two independent breakages were found:
 *
 * 1. FLEET: the egress NetworkPolicy allowed `search` namespace port 80 — the
 *    SERVICE port. NetworkPolicy is enforced AFTER kube-proxy DNAT, when the
 *    destination is already the pod's targetPort 8090, so the rule never
 *    matched a single real packet: every fleet agent's web_search got an
 *    instant connection-refused for as long as the policy existed. Fixed in
 *    hive's provision_user_daemon renderer (+ live patch, verified from a
 *    running agent pod).
 *
 * 2. HOST TUI: the daemon injects SEARCH_BASE_URL into fleet pods, but a TUI
 *    on the platform host receives nothing, so the tool reported "No search
 *    backend configured". The tool now discovers the NodePort itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';

import { webSearchTool } from '../../src/tools/builtin/web-search.js';

let server: http.Server;
let baseUrl: string;
let requests: string[];

function startServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

const SEARCH_RESPONSE = {
  query: 'rust cross compile',
  results: [{
    title: 'Cross-compilation - The rustup book',
    url: 'https://rust-lang.github.io/rustup/cross-compilation.html',
    snippet: 'Rust supports a great number of platforms.',
    source: 'searxng',
    source_type: 'web',
    score: 3.2,
    published_at: null,
  }],
  total: 1,
  meta: { category: 'general', backends: ['searxng'], took_ms: 850 },
};

beforeEach(async () => {
  requests = [];
  baseUrl = await startServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url?.startsWith('/search')) {
      if (req.url.includes('q=backend-down')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'searxng unavailable' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SEARCH_RESPONSE));
      return;
    }
    res.writeHead(404).end();
  });
  process.env['SEARCH_BASE_URL'] = baseUrl;
});

afterEach(() => {
  delete process.env['SEARCH_BASE_URL'];
  server?.close();
});

describe('web_search against Shizuha Search', () => {
  it('returns formatted results with source attribution', async () => {
    const result = await webSearchTool.execute(
      { query: 'rust cross compile', max_results: 3 },
      {} as never,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Cross-compilation - The rustup book');
    expect(result.content).toContain('rust-lang.github.io');
    expect(result.content).toContain('Source: searxng');
    expect(requests.some((u) => u.includes('q=rust+cross+compile') || u.includes('q=rust%20cross%20compile'))).toBe(true);
  });

  it('passes the category hint through', async () => {
    await webSearchTool.execute(
      { query: 'k8s netpol', max_results: 2, category: 'docs' },
      {} as never,
    );
    expect(requests.some((u) => u.includes('category=docs'))).toBe(true);
  });

  it('reports an HTTP failure as a tool error, not a crash', async () => {
    const result = await webSearchTool.execute(
      { query: 'backend-down', max_results: 1 },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Search error');
  });
});
