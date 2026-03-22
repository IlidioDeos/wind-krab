export type FactCategory =
  | 'scheduling'
  | 'preference'
  | 'contact'
  | 'project'
  | 'task'
  | 'fact';

export interface KnowledgeFact {
  id: string;
  content: string;
  category: FactCategory;
  source: string; // channel name: whatsapp, slack, telegram, discord…
  sessionKey: string;
  timestamp: number; // ms since epoch
  ttl: number; // ms — how long this fact is valid
  confidence: number; // 0–1
  supersedes?: string; // ID of the fact this replaces
  conflictsWith?: string[]; // IDs of contradicting concurrent facts
}

export interface KnowledgeStore {
  version: number;
  lastUpdated: number;
  facts: KnowledgeFact[];
}

export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence: number;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
}

export interface FilterResult {
  isNoise: boolean;
  likelyCategory: FactCategory | 'unknown' | 'noise';
}

export interface PluginConfig {
  storePath: string;
  maxFacts: number;
  ttl: Record<FactCategory, number>;
  /** Time window (ms) in which two contradictory facts are considered a conflict */
  conflictWindowMs: number;
  /** Use a fast LLM call to extract facts (more accurate, small cost). Default: false (heuristic only) */
  extractionEnabled: boolean;
  /** Max number of facts to inject into a session's context per turn */
  injectionMaxFacts: number;
  /** Max age (ms) of facts to inject */
  injectionMaxAge: number;
}
