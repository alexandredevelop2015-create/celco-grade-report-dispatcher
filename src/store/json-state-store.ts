import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RunStore, SummaryCache } from '../domain/ports';
import { StudentRecord, SummaryText } from '../domain/types';

interface State {
  records: Record<string, StudentRecord>;
  cache: Record<string, SummaryText>;
}

/**
 * Estado da execução (por aluno) + cache de resumos, em um JSON local. Sem `path` fica só em memória
 * (testes). É deliberadamente simples: o estado já está atrás das portas `RunStore`/`SummaryCache`,
 * trocá-lo por Postgres/Redis não mexe no pipeline (ver docs/SCALING.md).
 * Escrita via arquivo temporário + rename para não deixar JSON corrompido se o processo morrer.
 */
export class JsonStateStore implements RunStore {
  private state: State = { records: {}, cache: {} };
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path?: string) {}

  static inMemory(): JsonStateStore {
    return new JsonStateStore();
  }

  static async open(path: string): Promise<JsonStateStore> {
    const store = new JsonStateStore(path);
    try {
      store.state = JSON.parse(await readFile(path, 'utf8')) as State;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return store;
  }

  async get(runId: string, studentId: string): Promise<StudentRecord | undefined> {
    return this.state.records[`${runId}:${studentId}`];
  }

  async list(runId: string): Promise<StudentRecord[]> {
    const prefix = `${runId}:`;
    return Object.entries(this.state.records)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);
  }

  async put(runId: string, record: StudentRecord): Promise<void> {
    this.state.records[`${runId}:${record.studentId}`] = record;
    await this.persist();
  }

  /** Visão de cache sobre o mesmo arquivo (get/set colidiriam com os do RunStore). */
  asCache(): SummaryCache {
    return {
      get: async (key) => this.state.cache[key],
      set: async (key, summary) => {
        this.state.cache[key] = summary;
        await this.persist();
      },
    };
  }

  private persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    // Serializa as escritas: vários workers concorrentes, um único escritor por vez.
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state));
      await rename(tmp, path);
    });
    return this.writing;
  }
}
