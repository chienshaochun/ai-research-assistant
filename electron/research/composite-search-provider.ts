import {
  validateSearchRequest,
  type SearchCandidateInput,
  type SearchProvider,
  type SearchRequest,
} from './search-provider.js';

export class CompositeSearchProvider implements SearchProvider {
  readonly id: string;
  readonly scopeDescription: string;
  readonly publicationDateSupport: 'verified' | 'unknown';

  constructor(private readonly providers: readonly SearchProvider[], id = 'composite-search') {
    if (providers.length < 1) throw new Error('Composite search requires at least one provider.');
    this.id = id;
    this.scopeDescription = providers.map(({ scopeDescription }) => scopeDescription).join(' ');
    this.publicationDateSupport = providers.every(
      ({ publicationDateSupport }) => publicationDateSupport === 'verified',
    ) ? 'verified' : 'unknown';
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<readonly SearchCandidateInput[]> {
    const validated = validateSearchRequest(request);
    const candidates: SearchCandidateInput[] = [];
    let succeeded = 0;
    let lastError: unknown;
    for (const provider of this.providers) {
      signal.throwIfAborted();
      try {
        candidates.push(...await provider.search(validated, signal));
        succeeded += 1;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
      }
    }
    if (succeeded === 0 && lastError) throw lastError;
    return candidates;
  }
}
