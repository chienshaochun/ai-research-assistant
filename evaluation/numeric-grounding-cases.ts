import type { CitedStatement } from '../electron/research/report.js';

export interface NumericGroundingCase {
  id: string;
  statement: CitedStatement;
  sourceContentById: ReadonlyMap<string, string>;
  expectedUnsupportedTokens: string[];
}

const statement = (text: string, sourceIds = ['src_a']): CitedStatement => ({
  text, sourceIds,
});

export const NUMERIC_GROUNDING_CASES: readonly NumericGroundingCase[] = [
  {
    id: 'supported_percentage',
    statement: statement('The reported gain is 12.5%.'),
    sourceContentById: new Map([['src_a', 'Results show a 12.5% gain.']]),
    expectedUnsupportedTokens: [],
  },
  {
    id: 'unsupported_percentage',
    statement: statement('The reported gain is 18%.'),
    sourceContentById: new Map([['src_a', 'Results show a 12.5% gain.']]),
    expectedUnsupportedTokens: ['18%'],
  },
  {
    id: 'format_normalization',
    statement: statement('Evaluated on １００,０００ tasks with 5.6倍 throughput and 92.6% success.'),
    sourceContentById: new Map([[
      'src_a', 'Evaluated on 100k tasks with $5.6\\times$ throughput and 92.6 percent success.',
    ]]),
    expectedUnsupportedTokens: [],
  },
  {
    id: 'multi_source_union',
    statement: statement('The two settings use 32 and 64 samples.', ['src_a', 'src_b']),
    sourceContentById: new Map([
      ['src_a', 'The first setting uses 32 samples.'],
      ['src_b', 'The second setting uses 64 samples.'],
    ]),
    expectedUnsupportedTokens: [],
  },
  {
    id: 'magnitude_suffix_must_be_adjacent',
    statement: statement('The cohort contains 200 patients.'),
    sourceContentById: new Map([['src_a', 'A cohort of 200 bariatric surgery patients.']]),
    expectedUnsupportedTokens: [],
  },
  {
    id: 'non_numeric_claim',
    statement: statement('The method preserves an evidence trail.'),
    sourceContentById: new Map([['src_a', 'A different description.']]),
    expectedUnsupportedTokens: [],
  },
];
