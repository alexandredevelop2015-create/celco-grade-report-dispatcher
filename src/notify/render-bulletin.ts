import { GradeChange, GradeProfile, NotificationMessage, StudentGrades, SummaryText } from '../domain/types';
import { escapeHtml } from '../grades/sanitize';

const STATUS_LABEL = { strong: 'Muito bom', ok: 'Aprovado', attention: 'Atenção' } as const;

export function renderBulletin(params: {
  runId: string;
  period: string;
  student: StudentGrades;
  profile: GradeProfile;
  summary: SummaryText;
  /** Hash dos dados: entra na chave de idempotência para o reenvio não ser descartado como duplicado. */
  version: string;
  /** true quando é a correção de um boletim já enviado. */
  updated?: boolean;
  /** Disciplinas alteradas desde o último boletim (só usado quando `updated`). */
  changes?: GradeChange[];
}): NotificationMessage {
  const { runId, period, student, profile, summary, version, updated, changes = [] } = params;
  const firstName = student.name.split(' ')[0] ?? student.name;

  const changed = updated ? changes : [];
  const changeLine = (c: GradeChange) =>
    c.after === undefined
      ? `${c.subject}: removida (era ${c.before}/${profile.scale})`
      : c.before === undefined
        ? `${c.subject}: ${c.after}/${profile.scale} (nova)`
        : `${c.subject}: ${c.before} → ${c.after}/${profile.scale}`;
  const lines = profile.subjects.map((s) => `  - ${s.subject}: ${s.grade}/${profile.scale} (${STATUS_LABEL[s.status]})`);
  const text = [
    `Olá, ${firstName}!`,
    '',
    updated
      ? `Atualizámos o teu boletim do período ${period}: houve uma alteração nas tuas notas.`
      : `O teu boletim do período ${period} já está disponível.`,
    '',
    ...(changed.length ? ['Alterações:', ...changed.map((c) => `  - ${changeLine(c)}`), ''] : []),
    ...lines,
    '',
    `Média: ${profile.average}/${profile.scale}`,
    '',
    `Pontos fortes: ${summary.strengths}`,
    `Atenção: ${summary.attention}`,
    `Próximos passos: ${summary.nextSteps}`,
    '',
    'Secretaria Académica',
  ].join('\n');

  const rows = profile.subjects
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.subject)}</td><td>${s.grade}/${profile.scale}</td><td>${STATUS_LABEL[s.status]}</td></tr>`,
    )
    .join('');
  const html = [
    `<p>Olá, ${escapeHtml(firstName)}!</p>`,
    updated
      ? `<p>Atualizámos o teu boletim do período <strong>${escapeHtml(period)}</strong>: houve uma alteração nas tuas notas.</p>`
      : `<p>O teu boletim do período <strong>${escapeHtml(period)}</strong> já está disponível.</p>`,
    changed.length ? `<p><strong>Alterações:</strong></p><ul>${changed.map((c) => `<li>${escapeHtml(changeLine(c))}</li>`).join('')}</ul>` : '',
    `<table border="1" cellpadding="6" cellspacing="0"><tr><th>Disciplina</th><th>Nota</th><th>Estado</th></tr>${rows}</table>`,
    `<p><strong>Média:</strong> ${profile.average}/${profile.scale}</p>`,
    `<p><strong>Pontos fortes:</strong> ${escapeHtml(summary.strengths)}<br>`,
    `<strong>Atenção:</strong> ${escapeHtml(summary.attention)}<br>`,
    `<strong>Próximos passos:</strong> ${escapeHtml(summary.nextSteps)}</p>`,
    '<p>Secretaria Académica</p>',
  ].join('');

  return {
    idempotencyKey: `${runId}:${student.studentId}:${version.slice(0, 8)}`,
    to: student.email,
    toName: student.name,
    subject: updated ? `Boletim ${period} (atualizado)` : `Boletim ${period}`,
    text,
    html,
  };
}

/** Aviso de que o lançamento do aluno foi retirado da planilha: as notas já comunicadas deixam de valer. */
export function renderRemoval(params: {
  runId: string;
  period: string;
  studentId: string;
  name: string;
  email: string;
  previous: { subject: string; grade: number }[];
}): NotificationMessage {
  const { runId, period, studentId, name, email, previous } = params;
  const firstName = name.split(' ')[0] ?? name;
  const lines = previous.map((g) => `  - ${g.subject}: ${g.grade}`);
  const text = [
    `Olá, ${firstName}!`,
    '',
    `O teu lançamento de notas do período ${period} foi removido pela secretaria.`,
    'As notas comunicadas anteriormente deixam de ter efeito.',
    ...(lines.length ? ['', 'Notas anuladas:', ...lines] : []),
    '',
    'Se tiveres dúvidas, contacta a secretaria académica.',
    '',
    'Secretaria Académica',
  ].join('\n');
  const html = [
    `<p>Olá, ${escapeHtml(firstName)}!</p>`,
    `<p>O teu lançamento de notas do período <strong>${escapeHtml(period)}</strong> foi removido pela secretaria.<br>As notas comunicadas anteriormente deixam de ter efeito.</p>`,
    previous.length ? `<p><strong>Notas anuladas:</strong></p><ul>${previous.map((g) => `<li>${escapeHtml(g.subject)}: ${g.grade}</li>`).join('')}</ul>` : '',
    '<p>Se tiveres dúvidas, contacta a secretaria académica.</p>',
    '<p>Secretaria Académica</p>',
  ].join('');
  return {
    idempotencyKey: `${runId}:${studentId}:removido`,
    to: email,
    toName: name,
    subject: `Boletim ${period} (lançamento removido)`,
    text,
    html,
  };
}
