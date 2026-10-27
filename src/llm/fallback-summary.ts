import { GradeProfile, SummaryText } from '../domain/types';

function join(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/**
 * Resumo determinístico, sem LLM e sem custo. Usado quando o LLM está indisponível, o disjuntor está
 * aberto ou o orçamento acabou: o aluno recebe o boletim em vez de nada, marcado como "fallback" no relatório.
 */
export function buildFallbackSummary(profile: GradeProfile): SummaryText {
  const strong = profile.subjects.filter((s) => s.status === 'strong').map((s) => s.subject);
  const weak = profile.subjects.filter((s) => s.status === 'attention').map((s) => s.subject);

  return {
    strengths: strong.length
      ? `Destaque positivo em ${join(strong)}.`
      : `A tua média foi de ${profile.average} valores em ${profile.scale}.`,
    attention: weak.length
      ? `Atenção a ${join(weak)}, com nota abaixo de ${profile.passMark}.`
      : 'Não há pontos críticos neste período.',
    nextSteps: weak.length
      ? 'Marca uma tutoria com a secretaria académica para planear a recuperação.'
      : 'Mantém o ritmo de estudo no próximo período.',
  };
}
