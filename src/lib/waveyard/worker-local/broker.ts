/**
 * LocalJobBroker — the desktop queue transport (docs/desktop-runtime-plan §5).
 *
 * In desktop mode (ARENA_DESKTOP_MODE=1, no REDIS_URL) `enqueue()` in
 * queue.ts submits here instead of BullMQ. The broker preserves the
 * worker's job semantics: serial execution, real handlers, failures
 * surface on the same DB rows the routes already maintain. No handler
 * for a queue ⇒ submit throws an honest desktop reason (the Python-only
 * stem analyses are the remaining unregistered queues).
 */

export type LocalJobHandler = (payload: Record<string, unknown>) => Promise<void>;

export type BrokerEvent =
  | { kind: "started"; queue: string; jobId: string }
  | { kind: "succeeded"; queue: string; jobId: string; durationMs: number }
  | { kind: "failed"; queue: string; jobId: string; error: string }
  | { kind: "rejected"; queue: string; error: string };

type PendingJob = { queue: string; jobId: string; payload: Record<string, unknown> };

export class LocalJobBroker {
  private readonly handlers = new Map<string, LocalJobHandler>();
  private queue: PendingJob[] = [];
  private running = false;
  /** In-flight jobIds — BullMQ's jobId semantics: no duplicate while active. */
  private readonly activeIds = new Set<string>();
  private draining: Promise<boolean> | null = null;
  private readonly events: BrokerEvent[] = [];
  private readonly listeners = new Set<(event: BrokerEvent) => void>();
  private startedAt: Date | null = null;
  private counts = { submitted: 0, succeeded: 0, failed: 0, rejected: 0 };

  register(queue: string, handler: LocalJobHandler): void {
    this.handlers.set(queue, handler);
  }

  hasHandler(queue: string): boolean {
    return this.handlers.has(queue);
  }

  registeredQueues(): string[] {
    return [...this.handlers.keys()];
  }

  /** Enqueue semantics mirror BullMQ's add(): throws when nobody can run it. */
  submit(queue: string, jobId: string, payload: Record<string, unknown>): Promise<string> {
    const handler = this.handlers.get(queue);
    if (handler === undefined) {
      this.counts.rejected += 1;
      const error = new Error(
        `Desktop runtime has no local executor for the "${queue}" queue. ` +
          `This operation needs the Waveyard Python worker (the stem-analysis engines ` +
          `that are not bundled with the desktop app).`,
      );
      this.record({ kind: "rejected", queue, error: error.message });
      return Promise.reject(error);
    }
    if (this.activeIds.has(jobId)) return Promise.resolve(jobId); // already queued/running
    this.counts.submitted += 1;
    this.activeIds.add(jobId);
    this.queue.push({ queue, jobId, payload });
    void this.pump();
    return Promise.resolve(jobId);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const handler = this.handlers.get(job.queue);
        if (handler === undefined) continue; // registered away meanwhile
        this.record({ kind: "started", queue: job.queue, jobId: job.jobId });
        const started = Date.now();
        try {
          await handler(job.payload);
          this.counts.succeeded += 1;
          this.record({ kind: "succeeded", queue: job.queue, jobId: job.jobId, durationMs: Date.now() - started });
        } catch (error) {
          this.counts.failed += 1;
          this.record({ kind: "failed", queue: job.queue, jobId: job.jobId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          this.activeIds.delete(job.jobId);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Wait for in-flight + queued jobs (shutdown drain). */
  drain(timeoutMs = 15_000): Promise<boolean> {
    if (this.draining === null) {
      this.draining = (async () => {
        const deadline = Date.now() + timeoutMs;
        while ((this.queue.length > 0 || this.running) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return this.queue.length === 0 && !this.running;
      })();
    }
    return this.draining;
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(event: BrokerEvent): void {
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    for (const listener of this.listeners) listener(event);
  }

  stats() {
    return {
      startedAt: this.startedAt,
      queues: this.registeredQueues(),
      pending: this.queue.length,
      running: this.running,
      ...this.counts,
      recentEvents: this.events.slice(-25),
    };
  }

  markStarted(): void {
    if (this.startedAt === null) this.startedAt = new Date();
  }
}

// Turbopack can instantiate this module once for the instrumentation graph
// and once for route graphs — a module-level singleton would split in two.
// Like src/db, the broker lives on globalThis so every graph shares one.
const globalForBroker = globalThis as typeof globalThis & {
  __arenaLocalJobBroker?: LocalJobBroker;
};

/** The process-wide broker. Created lazily; only desktop mode calls this. */
export function getLocalJobBroker(): LocalJobBroker {
  if (globalForBroker.__arenaLocalJobBroker === undefined) {
    const created = new LocalJobBroker();
    created.markStarted();
    globalForBroker.__arenaLocalJobBroker = created;
  }
  return globalForBroker.__arenaLocalJobBroker;
}

export function localWorkerActive(): boolean {
  return process.env.ARENA_DESKTOP_MODE === "1" && !process.env.REDIS_URL;
}

export function resetLocalJobBrokerForTests(): void {
  delete globalForBroker.__arenaLocalJobBroker;
}
