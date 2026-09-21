/**
 * SCLI-559: `shizuha up --image` must validate the image selector BEFORE any
 * initialization/state mutation. Empty/whitespace/control-bearing, URL-shaped,
 * and unreasonable-length values must be rejected; valid OCI references pass.
 */
import { describe, expect, it } from 'vitest';
import { validateImageSelector, MAX_IMAGE_SELECTOR_LENGTH } from '../../src/cli/image-selector.js';

describe('validateImageSelector (SCLI-559)', () => {
  it('accepts the default and valid OCI image references', () => {
    expect(validateImageSelector('shizuha-agent-runtime:latest')).toBeNull();
    expect(validateImageSelector('ubuntu:24.04')).toBeNull();
    expect(validateImageSelector('node:22')).toBeNull();
    expect(validateImageSelector('registry.example.com/team/app:v1.2')).toBeNull();
    expect(validateImageSelector('ghcr.io/org/repo@sha256:' + 'a'.repeat(64))).toBeNull();
    expect(validateImageSelector('localhost:5000/my-image:1.0')).toBeNull();
  });

  it('rejects empty and missing selectors', () => {
    expect(validateImageSelector('')).toMatch(/must not be empty/);
    expect(validateImageSelector(undefined as unknown as string)).toMatch(/must not be empty/);
  });

  it('rejects whitespace and control-bearing selectors', () => {
    expect(validateImageSelector(' ')).toMatch(/whitespace or control/);
    expect(validateImageSelector('\t')).toMatch(/whitespace or control/);
    expect(validateImageSelector('qa\nforged')).toMatch(/whitespace or control/);
    expect(validateImageSelector('a b')).toMatch(/whitespace or control/);
    expect(validateImageSelector('a\x00b')).toMatch(/whitespace or control/);
  });

  it('rejects URL-shaped selectors', () => {
    expect(validateImageSelector('http://127.0.0.1/x')).toMatch(/not a URL/);
    expect(validateImageSelector('https://example.com/img')).toMatch(/not a URL/);
    expect(validateImageSelector('ftp://host/path')).toMatch(/not a URL/);
  });

  it('rejects unreasonable-length selectors', () => {
    const long = 'a'.repeat(MAX_IMAGE_SELECTOR_LENGTH + 1);
    expect(validateImageSelector(long)).toMatch(/too long/);
  });

  it('rejects unsupported characters', () => {
    expect(validateImageSelector('image;rm')).toMatch(/unsupported characters/);
    expect(validateImageSelector('image$')).toMatch(/unsupported characters/);
    expect(validateImageSelector('image|tag')).toMatch(/unsupported characters/);
  });
});
