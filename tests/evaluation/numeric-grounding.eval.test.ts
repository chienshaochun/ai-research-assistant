import { describe, expect, it } from 'vitest';
import { unsupportedNumericTokens } from '../../electron/research/report-audit.js';
import { NUMERIC_GROUNDING_CASES } from '../../evaluation/numeric-grounding-cases.js';

describe('numeric citation-grounding baseline', () => {
  for (const testCase of NUMERIC_GROUNDING_CASES) {
    it(testCase.id, () => {
      expect(unsupportedNumericTokens(
        testCase.statement, testCase.sourceContentById,
      )).toEqual(testCase.expectedUnsupportedTokens);
    });
  }
});
