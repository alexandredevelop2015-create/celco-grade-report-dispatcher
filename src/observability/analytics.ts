import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnalyticsSink } from '../domain/ports';
import { AnalyticsEvent } from '../domain/types';

/** Eventos de produto em NDJSON (`out/events.ndjson`), prontos para ir a um warehouse/Segment/Mixpanel. */
export class FileAnalyticsSink implements AnalyticsSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  track(event: AnalyticsEvent): void {
    appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  }
}

export class InMemoryAnalyticsSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];

  track(event: AnalyticsEvent): void {
    this.events.push(event);
  }
}
