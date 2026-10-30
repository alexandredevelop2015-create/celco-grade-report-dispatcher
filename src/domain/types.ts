export interface GradeEntry {
  subject: string;
  grade: number;
}

/** Diferença de uma disciplina entre o último boletim enviado e o atual. */
export interface GradeChange {
  subject: string;
  before?: number;
  after?: number;
}

export interface StudentGrades {
  studentId: string;
  name: string;
  email: string;
  /** WhatsApp em formato internacional, só dígitos (ex.: 5511999990000). Opcional. */
  phone?: string;
  grades: GradeEntry[];
}

export type RejectReason =
  | 'MISSING_FIELD'
  | 'INVALID_EMAIL'
  | 'INVALID_GRADE'
  | 'INVALID_FIELD'
  | 'EMAIL_MISMATCH'
  | 'DUPLICATE_CONFLICT';

/** Linha rejeitada. Propositalmente sem PII: só linha, motivo e o nome do campo. */
export interface RejectedRow {
  line: number;
  reason: RejectReason;
  field?: string;
}

export interface LoadResult {
  students: StudentGrades[];
  rejected: RejectedRow[];
  /** Linhas idênticas repetidas (mesma nota para o mesmo aluno/disciplina): ignoradas sem alarde. */
  duplicatesIgnored: number;
  /** Alunos com notas contraditórias: nenhum boletim sai até a secretaria resolver. */
  quarantined: string[];
  /** Todo student_id que apareceu no CSV, mesmo em linha rejeitada: aluno ausente daqui foi REMOVIDO. */
  seenIds: string[];
  totalRows: number;
}

export type SubjectStatus = 'strong' | 'ok' | 'attention';

/** Perfil enviado ao LLM: NÃO contém nome, e-mail nem matrícula (minimização de PII). */
export interface GradeProfile {
  scale: number;
  passMark: number;
  average: number;
  subjects: { subject: string; grade: number; status: SubjectStatus }[];
}

export interface SummaryText {
  strengths: string;
  attention: string;
  nextSteps: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GeneratedSummary {
  summary: SummaryText;
  usage: TokenUsage;
  model: string;
}

export type SummarySource = 'llm' | 'cache' | 'fallback';

export type StudentStatus = 'GENERATED' | 'SENT' | 'FAILED' | 'REMOVED';

export type ErrorKind = 'retriable_exhausted' | 'fatal' | 'unexpected' | 'circuit_open' | 'budget';

export interface StudentRecord {
  studentId: string;
  status: StudentStatus;
  attempts: number;
  /** Impressão digital das notas/e-mail enviados: mudou => o boletim precisa ser reenviado. */
  dataHash?: string;
  /** Guardados para poder avisar o aluno se o lançamento for removido do CSV depois. */
  name?: string;
  email?: string;
  phone?: string;
  /** Notas do último boletim ENTREGUE com sucesso: base para dizer o que mudou no próximo. */
  lastSentGrades?: GradeEntry[];
  summary?: SummaryText;
  summarySource?: SummarySource;
  error?: { kind: ErrorKind; message: string };
  updatedAt: string;
}

export interface NotificationMessage {
  /** `${runId}:${studentId}`: vira Message-ID, permitindo deduplicar do lado do destino. */
  idempotencyKey: string;
  to: string;
  toName: string;
  subject: string;
  text: string;
  html: string;
  /** Destino do canal WhatsApp (só dígitos); sem ele o canal é ignorado. */
  phone?: string;
  /** Versão curta para WhatsApp: o boletim completo vai por e-mail. */
  whatsappText?: string;
}

export type AnalyticsEvent =
  | { name: 'run_started'; runId: string; period: string; students: number }
  | {
      name: 'student_processed';
      runId: string;
      studentId: string;
      outcome: 'sent' | 'skipped' | 'failed';
      source?: SummarySource;
      durationMs: number;
      costUsd: number;
    }
  | { name: 'student_failed'; runId: string; studentId: string; kind: ErrorKind }
  | {
      name: 'run_completed';
      runId: string;
      durationMs: number;
      sent: number;
      failed: number;
      failureRate: number;
      costUsd: number;
    };
