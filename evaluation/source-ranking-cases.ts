import type { SearchCandidateInput } from '../electron/research/search-provider.js';

export interface SourceRankingCase {
  id: string;
  query: string;
  candidates: SearchCandidateInput[];
  expectedUrls: string[];
}

function paper(id: string, title: string, excerpt: string): SearchCandidateInput {
  return {
    title,
    url: `https://arxiv.org/abs/2610.${id}`,
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    excerpt,
  };
}

export const SOURCE_RANKING_CASES: readonly SourceRankingCase[] = [
  {
    id: 'combined-topic-coverage',
    query: 'AI Agent 與 RAG',
    candidates: [
      paper('00001', 'New AI Agent Runtime', 'A shared state runtime for agents.'),
      paper('00002', 'New RAG Retriever', 'Retrieval-augmented generation with sparse search.'),
      paper('00003', 'Grounded Agent Systems', 'AI agents use RAG for grounded decisions.'),
    ],
    expectedUrls: [
      'https://arxiv.org/abs/2610.00003',
      'https://arxiv.org/abs/2610.00001',
      'https://arxiv.org/abs/2610.00002',
    ],
  },
  {
    id: 'title-before-abstract',
    query: 'RAG',
    candidates: [
      paper('00004', 'Grounded Generation', 'This work studies retrieval-augmented generation.'),
      paper('00005', 'RAG Evaluation', 'A benchmark for grounded answers.'),
    ],
    expectedUrls: [
      'https://arxiv.org/abs/2610.00005',
      'https://arxiv.org/abs/2610.00004',
    ],
  },
  {
    id: 'abstract-before-no-match',
    query: '推論效率',
    candidates: [
      paper('00006', 'Serving Language Models', 'A general deployment survey.'),
      paper('00007', 'Serving Language Models', 'We study LLM inference efficiency.'),
    ],
    expectedUrls: [
      'https://arxiv.org/abs/2610.00007',
      'https://arxiv.org/abs/2610.00006',
    ],
  },
  {
    id: 'stable-tie-keeps-provider-order',
    query: 'AI Agent',
    candidates: [
      paper('00008', 'AI Agent Memory', 'Persistent memory for agents.'),
      paper('00009', 'AI Agent Planning', 'Planning for autonomous agents.'),
    ],
    expectedUrls: [
      'https://arxiv.org/abs/2610.00008',
      'https://arxiv.org/abs/2610.00009',
    ],
  },
  {
    id: 'unknown-topic-keeps-provider-order',
    query: '量子拓撲',
    candidates: [
      paper('00010', 'Second Result', 'A newer result.'),
      paper('00011', 'First Result', 'An older result.'),
    ],
    expectedUrls: [
      'https://arxiv.org/abs/2610.00010',
      'https://arxiv.org/abs/2610.00011',
    ],
  },
];
