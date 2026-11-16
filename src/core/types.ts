export type Accuracy = "exact" | "estimated";
export type EvidenceLevel = "local-log" | "local-database" | "official-api" | "browser-capture" | "derived";
export type CollectorAvailability = "ready" | "partial" | "unavailable";

export interface TokenUsageRecord {
  id: string;
  source: string;
  model: string;
  sessionId?: string;
  requestId?: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  accuracy: Accuracy;
  evidenceSource: string;
}

export interface CoverageWindow {
  earliestTimestamp?: number;
  latestTimestamp?: number;
  fileCount: number;
  matchedFileCount: number;
  matchedRecordCount: number;
  notes: string[];
}

export interface CollectorStatus {
  id: string;
  displayName: string;
  availability: CollectorAvailability;
  accuracy: Accuracy | "none";
  detectedRoots: string[];
  evidenceTypes: EvidenceLevel[];
  warnings: string[];
  notes?: string[];
}

export interface CollectorBatch {
  records: TokenUsageRecord[];
  status: CollectorStatus;
  coverage: CoverageWindow;
}

export interface CollectorEnvironment {
  homeDir: string;
  appData?: string;
  localAppData?: string;
}
