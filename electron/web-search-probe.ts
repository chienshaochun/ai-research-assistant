import {
  ChatGPTError,
  type ChatGPTClient,
  type ChatGPTModel,
  type WebSearchSource,
} from '@siwc/local';
import { normalizePublicHttpUrl } from './security/public-url.js';

export { normalizePublicHttpUrl } from './security/public-url.js';

export const WEB_SEARCH_PROBE_PROMPT = [
  'Use web search to find the official OpenAI developer documentation page about web search.',
  'Reply with one short sentence describing the tool and cite the page you used.',
].join(' ');

export interface PublicWebSearchSource {
  url: string;
  title?: string;
}

export interface WebSearchProbeResult {
  text: string;
  sources: PublicWebSearchSource[];
}

export function sanitizeWebSearchSources(sources: WebSearchSource[]): PublicWebSearchSource[] {
  const safe = new Map<string, PublicWebSearchSource>();
  for (const source of sources.slice(0, 100)) {
    const url = normalizePublicHttpUrl(source.url);
    if (!url || safe.has(url)) continue;
    const title = source.title?.trim().slice(0, 500);
    safe.set(url, { url, ...(title ? { title } : {}) });
    if (safe.size === 25) break;
  }
  return [...safe.values()];
}

export async function probeWebSearchCapability(
  chatgpt: Pick<ChatGPTClient, 'streamWebSearch'>,
  model: ChatGPTModel,
  signal: AbortSignal,
  onDelta?: (delta: string) => void,
): Promise<WebSearchProbeResult> {
  const result = await chatgpt.streamWebSearch({
    model: model.slug,
    input: WEB_SEARCH_PROBE_PROMPT,
    signal,
    onDelta,
  });
  const text = result.text.trim();
  if (!result.usedWebSearch) {
    throw new ChatGPTError(
      'web_search_not_used',
      '模型完成了文字回應，但串流中沒有 web_search_call，不能算搜尋驗證成功。',
    );
  }
  const sources = sanitizeWebSearchSources(result.sources);
  if (sources.length === 0) {
    throw new ChatGPTError(
      'web_search_sources_missing',
      '模型執行了 web search，但沒有取得可追溯的公開 HTTP(S) 來源。',
    );
  }
  if (!text) {
    throw new ChatGPTError('web_search_empty_response', 'Web search 已完成，但沒有最終文字回應。');
  }
  return { text, sources };
}
