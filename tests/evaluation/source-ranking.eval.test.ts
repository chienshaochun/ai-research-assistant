import { describe, expect, it } from 'vitest';
import { rankArxivCandidates } from '../../electron/research/arxiv-search-provider.js';
import { SOURCE_RANKING_CASES } from '../../evaluation/source-ranking-cases.js';

describe('source ranking evaluation baseline', () => {
  for (const testCase of SOURCE_RANKING_CASES) {
    it(testCase.id, () => {
      expect(rankArxivCandidates(testCase.candidates, testCase.query).map(({ url }) => url))
        .toEqual(testCase.expectedUrls);
    });
  }
});
