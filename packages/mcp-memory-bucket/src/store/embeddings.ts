import type Database from 'better-sqlite3';
import { bumpChunksVersion, embedTextFor, setChunksChangedListener } from './chunks.js';

/** Turns text into unit-length vectors. `kind` matters for asymmetric models (bge), which prefix queries but not passages. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

export const DEFAULT_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/**
 * A local sentence-embedding model run in-process through transformers.js (ONNX, CPU) — no LLM and
 * no network after the one-time model download into `cacheDir`. The package is an optional
 * dependency loaded on first use, so a machine where it failed to install only loses the semantic
 * half of bucket_recall rather than failing to start.
 */
export function createTransformersEmbedder(opts: { cacheDir: string; model?: string }): Embedder {
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  const isBge = /bge/i.test(model);
  let extractor: Promise<(texts: string[], options: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>> | undefined;

  const load = () => {
    extractor ??= (async () => {
      const transformers = (await import('@huggingface/transformers')) as any;
      // The default cache sits inside node_modules, which an `npx` run throws away with the package.
      transformers.env.cacheDir = opts.cacheDir;
      return transformers.pipeline('feature-extraction', model, { dtype: 'q8' });
    })();
    // A failed load (offline first run) must not be cached forever — let the next call retry.
    extractor.catch(() => (extractor = undefined));
    return extractor;
  };

  return {
    model,
    async embed(texts, kind) {
      const run = await load();
      const inputs = kind === 'query' && isBge ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
      const output = await run(inputs, { pooling: isBge ? 'cls' : 'mean', normalize: true });
      const dim = output.dims[output.dims.length - 1]!;
      return texts.map((_, i) => output.data.slice(i * dim, (i + 1) * dim));
    },
  };
}

export function vectorToBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function blobToVector(blob: Buffer): Float32Array {
  // Copy: a Buffer's byteOffset into its pool is not guaranteed to be 4-byte aligned.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

const BATCH_SIZE = 16;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

/**
 * Embeds every chunk that has no vector for the current model, in the background, a batch at a
 * time. Indexing never waits on it: upsertFile writes chunks synchronously with embedding NULL and
 * this catches up, so lexical search works immediately and semantic search fills in behind it.
 */
export class EmbeddingIndexer {
  private running = false;
  private rerun = false;
  private modelLoaded = false;
  private lastError: string | undefined;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private db: Database.Database,
    readonly embedder: Embedder
  ) {}

  /** Subscribes to chunk writes and embeds whatever is already pending. */
  start(): void {
    setChunksChangedListener(() => this.kick());
    this.kick();
  }

  stop(): void {
    setChunksChangedListener(undefined);
    clearTimeout(this.retryTimer);
  }

  /** True once the model has produced output — i.e. a query can be embedded without a cold load or a download. */
  isReady(): boolean {
    return this.modelLoaded;
  }

  status(): { model: string; embedded: number; total: number; error?: string } {
    const { total, embedded } = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(embedding IS NOT NULL AND embed_model = ?), 0) AS embedded FROM chunks`)
      .get(this.embedder.model) as { total: number; embedded: number };
    return { model: this.embedder.model, embedded, total, error: this.lastError };
  }

  kick(): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.run()
      .then(() => {
        this.lastError = undefined;
      })
      .catch((err) => {
        this.lastError = (err as Error).message;
        console.error(`[memory-bucket] embedding indexer stopped (semantic search unavailable, lexical still works): ${this.lastError}`);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.kick(), RETRY_AFTER_FAILURE_MS);
        this.retryTimer.unref();
      })
      .finally(() => {
        this.running = false;
        if (this.rerun) {
          this.rerun = false;
          if (!this.lastError) this.kick();
        }
      });
  }

  /** Resolves once nothing is pending — for tests and one-shot scripts; the server itself never awaits this. */
  async drain(): Promise<void> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.lastError) throw new Error(this.lastError);
  }

  private async run(): Promise<void> {
    const pending = this.db.prepare(
      `SELECT id, hash, context, heading, text FROM chunks WHERE embedding IS NULL OR embed_model IS NOT ? LIMIT ${BATCH_SIZE}`
    );
    // Guarded by hash: a chunk rewritten while its batch was in flight must not receive the old text's vector.
    const store = this.db.prepare(`UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ? AND hash = ?`);
    for (;;) {
      const batch = pending.all(this.embedder.model) as Array<{ id: number; hash: string; context: string; heading: string; text: string }>;
      if (batch.length === 0) {
        // Everything was embedded by an earlier process: load the model anyway, or isReady() stays
        // false and every query falls back to lexical despite a complete index.
        if (!this.modelLoaded) {
          await this.embedder.embed(['warm up'], 'query');
          this.modelLoaded = true;
        }
        return;
      }
      const vectors = await this.embedder.embed(batch.map(embedTextFor), 'passage');
      this.modelLoaded = true;
      this.db.transaction(() => {
        batch.forEach((row, i) => store.run(vectorToBlob(vectors[i]!), this.embedder.model, row.id, row.hash));
      })();
      bumpChunksVersion();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
