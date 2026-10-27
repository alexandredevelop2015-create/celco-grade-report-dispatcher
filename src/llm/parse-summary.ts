import { z } from 'zod';
import { RetriableError } from '../domain/errors';
import { SummaryText } from '../domain/types';

const summarySchema = z.object({
  strengths: z.string().min(1).max(400),
  attention: z.string().min(1).max(400),
  nextSteps: z.string().min(1).max(400),
});

/**
 * Valida a saída do modelo. Resposta fora do contrato é tratada como falha *transitória*:
 * LLMs são não determinísticos e uma nova tentativa costuma resolver.
 */
export function parseSummary(raw: string): SummaryText {
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new RetriableError('LLM devolveu texto que não é JSON');
  }
  const result = summarySchema.safeParse(data);
  if (!result.success) throw new RetriableError('LLM devolveu JSON fora do contrato');
  return result.data;
}
