import {
  AnalyticsEvent,
  GeneratedSummary,
  GradeProfile,
  LoadResult,
  NotificationMessage,
  StudentRecord,
  SummaryText,
} from './types';

export interface GradeSource {
  load(): Promise<LoadResult>;
}

export interface SummaryGenerator {
  readonly model: string;
  generate(profile: GradeProfile): Promise<GeneratedSummary>;
}

export interface Notifier {
  send(message: NotificationMessage): Promise<void>;
}

export interface RunStore {
  get(runId: string, studentId: string): Promise<StudentRecord | undefined>;
  put(runId: string, record: StudentRecord): Promise<void>;
  list(runId: string): Promise<StudentRecord[]>;
}

export interface SummaryCache {
  get(key: string): Promise<SummaryText | undefined>;
  set(key: string, summary: SummaryText): Promise<void>;
}

export interface AnalyticsSink {
  track(event: AnalyticsEvent): void;
}

export const TOKENS = {
  CONFIG: Symbol('CONFIG'),
  LOGGER: Symbol('LOGGER'),
  GRADE_SOURCE: Symbol('GRADE_SOURCE'),
  SUMMARY_GENERATOR: Symbol('SUMMARY_GENERATOR'),
  NOTIFIER: Symbol('NOTIFIER'),
  RUN_STORE: Symbol('RUN_STORE'),
  SUMMARY_CACHE: Symbol('SUMMARY_CACHE'),
  ANALYTICS: Symbol('ANALYTICS'),
} as const;
