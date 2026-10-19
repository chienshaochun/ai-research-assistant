import { describe, expect, it, vi } from 'vitest';
import type { ChatGPTModel } from '@siwc/local';
import {
  normalizePublicHttpUrl,
  probeWebSearchCapability,
  sanitizeWebSearchSources,
} from '../electron/web-search-probe.js';
import { webSearchEvidenceFromEvent } from
  '../vendor/sign-in-with-chatgpt-devkit/packages/local/src/responses.js';

const model: ChatGPTModel = { slug: 'fixture-model', displayName: 'Fixture model' };
const signal = new AbortController().signal;

describe('web search capability probe', () => {
  it('passes only with tool evidence, public sources, and non-empty text', async () => {
    const onDelta = vi.fn();
    const streamWebSearch = vi.fn(async ({ onDelta: emit }) => {
      emit?.('Found it.');
      return {
        text: 'Found it.',
        usedWebSearch: true,
        sources: [{ url: 'https://developers.openai.com/api/docs/guides/tools#web-search', title: 'Tools' }],
      };
    });

    await expect(probeWebSearchCapability(
      { streamWebSearch }, model, signal, onDelta,
    )).resolves.toEqual({
      text: 'Found it.',
      sources: [{ url: 'https://developers.openai.com/api/docs/guides/tools', title: 'Tools' }],
    });
    expect(onDelta).toHaveBeenCalledWith('Found it.');
    expect(streamWebSearch).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture-model' }));
  });

  it('does not mistake completed text for tool usage', async () => {
    const streamWebSearch = vi.fn().mockResolvedValue({
      text: 'I already knew the answer.', usedWebSearch: false, sources: [],
    });
    await expect(probeWebSearchCapability({ streamWebSearch }, model, signal))
      .rejects.toMatchObject({ code: 'web_search_not_used' });
  });

  it('rejects tool output without a safe traceable source', async () => {
    const streamWebSearch = vi.fn().mockResolvedValue({
      text: 'Result', usedWebSearch: true,
      sources: [{ url: 'http://127.0.0.1/secret', title: 'Local' }],
    });
    await expect(probeWebSearchCapability({ streamWebSearch }, model, signal))
      .rejects.toMatchObject({ code: 'web_search_sources_missing' });
  });
});

describe('web search evidence and URL boundary', () => {
  it('extracts the web search call and sources from a completed response event', () => {
    const evidence = webSearchEvidenceFromEvent({
      type: 'response.completed',
      response: { output: [{ type: 'web_search_call', action: { sources: [
        { url: 'https://example.org/paper', title: 'Paper' },
      ] } }] },
    });
    expect(evidence).toEqual({
      usedWebSearch: true,
      sources: [{ url: 'https://example.org/paper', title: 'Paper' }],
    });
  });

  it.each([
    'file:///C:/secret.txt', 'http://localhost/admin', 'http://127.0.0.1/',
    'http://10.0.0.8/', 'http://[::1]/', 'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/', 'https://user:password@example.org/',
    'https://intranet/', 'http://198.51.100.10/', 'http://203.0.113.8/',
  ])('blocks non-public source URL %s', (url) => {
    expect(normalizePublicHttpUrl(url)).toBeUndefined();
  });

  it('allows a global-unicast IPv6 source', () => {
    expect(normalizePublicHttpUrl('https://[2606:4700:4700::1111]/'))
      .toBe('https://[2606:4700:4700::1111]/');
  });

  it('normalizes, deduplicates, and caps public sources', () => {
    expect(sanitizeWebSearchSources([
      { url: 'https://example.org/page#first', title: ' First ' },
      { url: 'https://example.org/page#second', title: 'Duplicate' },
      { url: 'https://openai.com/research/' },
    ])).toEqual([
      { url: 'https://example.org/page', title: 'First' },
      { url: 'https://openai.com/research/' },
    ]);
  });
});
