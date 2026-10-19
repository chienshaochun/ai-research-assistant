import type { ChatGPTModel, LoginProfile, SessionState } from '@siwc/local';

export function preferredDevelopmentModel(
  models: readonly ChatGPTModel[],
): ChatGPTModel | undefined {
  return models.find((model) => /luna/i.test(`${model.slug} ${model.displayName}`)) ?? models[0];
}

export type VerificationStatus = 'idle' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  param?: string;
}

export interface VerificationState {
  status: VerificationStatus;
  modelSlug?: string;
  text: string;
  completedAt?: string;
  error?: PublicError;
}

export interface PublicWebSearchSource {
  url: string;
  title?: string;
}

export interface WebSearchProbeState {
  status: VerificationStatus;
  modelSlug?: string;
  text: string;
  sources: PublicWebSearchSource[];
  completedAt?: string;
  error?: PublicError;
}

export type ResearchRunStatus =
  | 'idle' | 'planning' | 'searching' | 'reading' | 'generating'
  | 'completed' | 'no_results' | 'no_evidence' | 'failed' | 'cancelled';

export interface PublicReportSource {
  id: string;
  title: string;
  url: string;
  authorOrOrganization: string | null;
  publishedDate: string | null;
  updatedDate: string | null;
  evidenceLevel: 'metadata' | 'snippet' | 'abstract' | 'full_text';
  sourceType: 'paper' | 'official_documentation' | 'official_blog' | 'repository' |
    'article' | 'rss' | 'other';
  retrievedAt: string;
  contentHash: string;
  content: string;
  contentTruncated: boolean;
}

export interface PublicCitedStatement {
  text: string;
  sourceIds: string[];
}

export interface PublicReportItem {
  id: string;
  name: string;
  primarySourceId: string;
  relatedSourceIds: string[];
  problem: PublicCitedStatement;
  method: PublicCitedStatement;
  evidence: PublicCitedStatement[];
  limitations: PublicCitedStatement[];
  analysis: {
    applicationValue: string;
    smallExperiment: string;
    unverified: string[];
  };
}

export interface PublicResearchReport {
  id: string;
  topic: string;
  publishedFrom: string | null;
  publishedTo: string | null;
  searchScope: string;
  generatedAt: string;
  summary: PublicCitedStatement[];
  items: PublicReportItem[];
  citedSources: PublicReportSource[];
  markdown: string;
}

export interface PublicReportAudit {
  sourceClaimCount: number;
  citationReferenceCount: number;
  citedSourceCount: number;
  knownPublicationDateCount: number;
  unknownPublicationDateCount: number;
  outsideDateRangeSourceCount: number;
  abstractOnlySourceCount: number;
  fullTextSourceCount: number;
  truncatedSourceCount: number;
  numericClaimCount: number;
  numericGroundingWarningCount: number;
  numericGroundingIssues: Array<{
    label: string;
    unsupportedTokens: string[];
  }>;
  structuralCitationStatus: 'passed';
  semanticSupportStatus: 'not_evaluated';
  warnings: string[];
}

export interface ResearchRunState {
  status: ResearchRunStatus;
  command: string;
  modelSlug?: string;
  understanding?: string;
  message: string;
  eligibleSourceCount?: number;
  supplementarySourceCount?: number;
  searchQueries?: Array<{
    kind: 'primary' | 'supplemental';
    query: string;
    rawCandidateCount: number;
    eligibleCandidateCount: number;
    supplementaryCandidateCount: number;
  }>;
  uncoveredConcepts?: string[];
  candidateShortfall?: number;
  searchCallLimitReached?: boolean;
  report?: PublicResearchReport;
  audit?: PublicReportAudit;
  evaluationSummary?: PublicCitationEvaluationSummary;
  activeItemId?: string;
  followUp?: PublicFollowUpAnswer;
  error?: PublicError;
}

export interface PublicCitationEvaluationSummary {
  reportId: string;
  total: number;
  evaluated: number;
  unlabeled: number;
  counts: {
    supported: number;
    partially_supported: number;
    unsupported: number;
    unclear: number;
  };
  strictSupportedRate: number | null;
  supportedOrPartialRate: number | null;
  annotations: Array<{
    claimId: string;
    label: 'supported' | 'partially_supported' | 'unsupported' | 'unclear' | null;
  }>;
}

export interface PublicFollowUpAnswer {
  id: string;
  reportId: string;
  targetItemId: string;
  command: string;
  createdAt: string;
  sourceGroundedDetails: PublicCitedStatement[];
  analysis: {
    interpretation: string;
    suggestedExperiment: string;
    unverified: string[];
  };
  citedSources: PublicReportSource[];
  searchContext: {
    performed: true;
    scope: string;
    queries: string[];
  } | null;
  markdown: string;
}

export interface PublicLongTermPreferences {
  topic?: string;
  lookbackDays?: number;
  publicationDateMode?: 'recent' | 'any';
  searchMode?: 'arxiv' | 'web';
  maxItems?: number;
  summaryPoints?: number;
  reportFormat?: 'brief' | 'detailed' | 'comparison_table';
  paperFirst?: boolean;
  preferOpenSource?: boolean;
  requireOpenSource?: boolean;
}

export interface PublicReportHistorySummary {
  id: string;
  topic: string;
  generatedAt: string;
  publishedFrom: string | null;
  publishedTo: string | null;
  itemCount: number;
  citedSourceCount: number;
}

export interface PublicResearchAttemptSummary {
  id: number;
  status: 'no_results' | 'no_evidence' | 'failed' | 'cancelled';
  stage: 'planning' | 'searching' | 'reading' | 'generating';
  command: string;
  modelSlug: string;
  understanding: string;
  startedAt: string;
  finishedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  eligibleSourceCount: number;
  supplementarySourceCount: number;
  failureCount: number;
  sources: PublicResearchAttemptSource[];
}

export interface PublicResearchAttemptSource {
  attemptId: number;
  sourceId: string;
  sourceOrder: number;
  bucket: 'eligible' | 'supplementary';
  title: string;
  url: string;
  authorOrOrganization: string | null;
  publishedDate: string | null;
  updatedDate: string | null;
  sourceType: PublicReportSource['sourceType'];
  evidenceLevel: PublicReportSource['evidenceLevel'];
  excerpt: string | null;
  readStatus: 'not_attempted' | 'read' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PublicMonitoringRuleInput {
  id: string;
  name: string;
  query: string;
  enabled: boolean;
  intervalHours: number;
  lookbackDays: number;
  maxItems: number;
  autoBrief: boolean;
  digestHourLocal?: number;
}

export interface PublicMonitoringRule extends Omit<PublicMonitoringRuleInput, 'digestHourLocal'> {
  digestHourLocal: number;
  createdAt: string;
  updatedAt: string;
  lastSucceededAt: string | null;
  nextRunAt: string | null;
  lastDigestAt: string | null;
}

export interface PublicMonitoringInboxItem {
  ruleId: string;
  sourceId: string;
  status: 'new' | 'read' | 'dismissed';
  firstSeenAt: string;
  candidate: {
    title: string;
    url: string;
    authorOrOrganization: string | null;
    publishedDate: string | null;
    updatedDate: string | null;
    sourceType: PublicReportSource['sourceType'];
    evidenceLevel: PublicReportSource['evidenceLevel'];
    excerpt: string | null;
  };
  brief: {
    sourceId: string;
    problem: string;
    coreMethod: string;
    workValue: string;
    unverified: string[];
  } | null;
  briefedAt: string | null;
  briefModelSlug: string | null;
  feedback: 'worth_investigating' | 'later' | 'not_relevant' |
    'already_known' | 'not_actionable' | null;
  feedbackAt: string | null;
  linkedReportId: string | null;
  notifiedAt: string | null;
  rankingScore: number;
  rankingReasons: string[];
}

export interface PublicMonitoringRun {
  id: number;
  ruleId: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  discoveredCount: number;
  briefedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PublicMonitoringState {
  status: 'idle' | 'checking' | 'failed';
  message: string;
  rules: PublicMonitoringRule[];
  inbox: PublicMonitoringInboxItem[];
  processedInbox: PublicMonitoringInboxItem[];
  runs: PublicMonitoringRun[];
  error?: PublicError;
}

export interface AppState {
  session: SessionState;
  profiles: LoginProfile[];
  accountBusy: boolean;
  models: ChatGPTModel[];
  modelsStatus: 'idle' | 'loading' | 'ready' | 'error';
  modelsError?: PublicError;
  verification: VerificationState;
  webSearchProbe: WebSearchProbeState;
  research: ResearchRunState;
  preferences: PublicLongTermPreferences;
  reportHistory: PublicReportHistorySummary[];
  attemptHistory: PublicResearchAttemptSummary[];
  monitoring: PublicMonitoringState;
  launchAtLogin: boolean;
  dataDirectory: string;
}

export interface ResearchAssistantBridge {
  getState(): Promise<AppState>;
  signIn(): Promise<void>;
  reconnectSharing(): Promise<void>;
  cancelSignIn(): Promise<void>;
  refreshModels(): Promise<void>;
  verify(modelSlug?: string): Promise<void>;
  cancelVerification(): Promise<void>;
  probeWebSearch(modelSlug?: string): Promise<void>;
  cancelWebSearchProbe(): Promise<void>;
  runResearch(command: string, modelSlug?: string): Promise<void>;
  cancelResearch(): Promise<void>;
  exportResearchReport(): Promise<{ saved: boolean; path?: string }>;
  exportEvaluationWorksheet(): Promise<{ saved: boolean; path?: string }>;
  importEvaluationWorksheet(): Promise<{ imported: boolean; path?: string }>;
  exportPortableData(): Promise<{ saved: boolean; path?: string }>;
  importPortableData(): Promise<{
    imported: boolean;
    path?: string;
    recoveryPath?: string;
  }>;
  clearPreferences(): Promise<void>;
  deletePreference(key: string): Promise<void>;
  loadReport(reportId: string): Promise<void>;
  saveMonitoringRule(rule: PublicMonitoringRuleInput): Promise<void>;
  runMonitoringNow(ruleId: string): Promise<void>;
  setMonitoringItemStatus(
    ruleId: string,
    sourceId: string,
    status: PublicMonitoringInboxItem['status'],
  ): Promise<void>;
  setMonitoringItemFeedback(
    ruleId: string,
    sourceId: string,
    feedback: PublicMonitoringInboxItem['feedback'],
  ): Promise<void>;
  researchMonitoringItem(ruleId: string, sourceId: string, modelSlug?: string): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  openSource(url: string): Promise<void>;
  disconnect(): Promise<void>;
  openUsage(): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
}
