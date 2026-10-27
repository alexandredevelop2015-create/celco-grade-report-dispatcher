import { Notifier, SummaryGenerator } from '../src/domain/ports';
import { NotificationMessage, StudentGrades } from '../src/domain/types';
import { createLogger } from '../src/observability/logger';
import { BudgetGuard } from '../src/llm/cost';
import { FakeSummaryGenerator } from '../src/llm/fake-summary-generator';
import { StudentProcessor, ProcessorDeps } from '../src/pipeline/student-processor';
import { CircuitBreaker } from '../src/resilience/circuit-breaker';
import { RateLimiter } from '../src/resilience/rate-limiter';
import { JsonStateStore } from '../src/store/json-state-store';

export const student = (id = 'A1', grades: [string, number][] = [['Algoritmos', 18], ['Matemática', 7]]): StudentGrades => ({
  studentId: id,
  name: 'Ana Ribeiro',
  email: 'ana@exemplo.pt',
  grades: grades.map(([subject, grade]) => ({ subject, grade })),
});

export class RecordingNotifier implements Notifier {
  sent: NotificationMessage[] = [];
  failWith?: Error;
  failTimes = 0;

  async send(message: NotificationMessage): Promise<void> {
    if (this.failWith && this.failTimes-- > 0) throw this.failWith;
    this.sent.push(message);
  }
}

export function buildProcessor(overrides: Partial<ProcessorDeps> = {}) {
  const store = JsonStateStore.inMemory();
  const notifier = new RecordingNotifier();
  const generator: SummaryGenerator = new FakeSummaryGenerator();
  const noSleep = async () => undefined;
  const deps: ProcessorDeps = {
    store,
    cache: store.asCache(),
    generator,
    notifier,
    llmBreaker: new CircuitBreaker({ name: 'llm', failureThreshold: 3, cooldownMs: 1000 }),
    notifyBreaker: new CircuitBreaker({ name: 'notifier', failureThreshold: 3, cooldownMs: 1000 }),
    llmLimiter: new RateLimiter({ ratePerSec: 0 }),
    notifyLimiter: new RateLimiter({ ratePerSec: 0 }),
    budget: new BudgetGuard(100),
    logger: createLogger('silent'),
    rules: { scaleMax: 20, passMark: 10 },
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    maxOutputTokens: 300,
    fallbackOnLlmFailure: true,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: noSleep, random: () => 0.5 },
    ...overrides,
  };
  return { processor: new StudentProcessor(deps), deps, store, notifier };
}

export const ctx = { runId: 'run-1', period: '2026-1S', traceId: 'trace' };
