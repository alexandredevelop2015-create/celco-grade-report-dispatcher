import { NotificationMessage } from '../domain/types';
import { escapeHtml } from '../grades/sanitize';

export type AuditAction = 'criado' | 'alterado' | 'removido' | 'execucao';

export interface AuditEvent {
  id: string;
  action: AuditAction;
  period: string;
  at: Date;
  studentId?: string;
  studentName?: string;
  /** Linhas "disciplina: antes → depois" já formatadas. */
  changes: string[];
  /** O que aconteceu com o e-mail do aluno (ou por que não houve). */
  studentNotice: string;
}

const TITLE: Record<AuditAction, string> = {
  criado: 'Aluno incluído',
  alterado: 'Notas/dados alterados',
  removido: 'Aluno excluído',
  execucao: 'Execução de envio',
};

/** E-mail de auditoria para a secretaria: toda alteração feita pela interface gera um. */
export function renderAudit(to: string, e: AuditEvent): NotificationMessage {
  const who = e.studentId ? `${e.studentName ?? ''} (${e.studentId})`.trim() : '';
  const when = e.at.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const text = [
    `${TITLE[e.action]} no período ${e.period}`,
    ...(who ? [`Aluno: ${who}`] : []),
    `Quando: ${when}`,
    '',
    ...(e.changes.length ? ['Detalhes:', ...e.changes.map((c) => `  - ${c}`), ''] : []),
    `Aviso ao aluno: ${e.studentNotice}`,
  ].join('\n');
  const html = [
    `<p><strong>${escapeHtml(TITLE[e.action])}</strong> no período <strong>${escapeHtml(e.period)}</strong></p>`,
    who ? `<p>Aluno: ${escapeHtml(who)}</p>` : '',
    `<p>Quando: ${escapeHtml(when)}</p>`,
    e.changes.length ? `<ul>${e.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '',
    `<p>Aviso ao aluno: ${escapeHtml(e.studentNotice)}</p>`,
  ].join('');
  return {
    idempotencyKey: `audit:${e.id}`,
    to,
    toName: 'Secretaria',
    subject: `[Auditoria] ${TITLE[e.action]}${e.studentId ? ` · ${e.studentId}` : ''} · ${e.period}`,
    text,
    html,
  };
}
