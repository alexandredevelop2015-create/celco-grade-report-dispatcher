import { GradeProfile, NotificationMessage, StudentGrades, SummaryText } from '../domain/types';
import { escapeHtml } from '../grades/sanitize';

const STATUS_LABEL = { strong: 'Muito bom', ok: 'Aprovado', attention: 'Atenção' } as const;

export function renderBulletin(params: {
  runId: string;
  period: string;
  student: StudentGrades;
  profile: GradeProfile;
  summary: SummaryText;
}): NotificationMessage {
  const { runId, period, student, profile, summary } = params;
  const firstName = student.name.split(' ')[0] ?? student.name;

  const lines = profile.subjects.map((s) => `  - ${s.subject}: ${s.grade}/${profile.scale} (${STATUS_LABEL[s.status]})`);
  const text = [
    `Olá, ${firstName}!`,
    '',
    `O teu boletim do período ${period} já está disponível.`,
    '',
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
    `<p>O teu boletim do período <strong>${escapeHtml(period)}</strong> já está disponível.</p>`,
    `<table border="1" cellpadding="6" cellspacing="0"><tr><th>Disciplina</th><th>Nota</th><th>Estado</th></tr>${rows}</table>`,
    `<p><strong>Média:</strong> ${profile.average}/${profile.scale}</p>`,
    `<p><strong>Pontos fortes:</strong> ${escapeHtml(summary.strengths)}<br>`,
    `<strong>Atenção:</strong> ${escapeHtml(summary.attention)}<br>`,
    `<strong>Próximos passos:</strong> ${escapeHtml(summary.nextSteps)}</p>`,
    '<p>Secretaria Académica</p>',
  ].join('');

  return {
    idempotencyKey: `${runId}:${student.studentId}`,
    to: student.email,
    toName: student.name,
    subject: `Boletim ${period}`,
    text,
    html,
  };
}
