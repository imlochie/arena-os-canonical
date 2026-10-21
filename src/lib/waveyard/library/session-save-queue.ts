/** Per-controller acknowledged writes. No disk journal or cross-tab locking claim. */
export type SessionSaveStatus = "saved" | "pending" | "saving" | "error";
export class SessionSaveQueue {
  private pending = new Map<string, string>();
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed = false;
  private write: (url: string, body: string) => Promise<void>;
  private notify: (status: SessionSaveStatus) => void;
  private delay: number;
  constructor(write: (url: string, body: string) => Promise<void>, notify: (status: SessionSaveStatus) => void, delay = 600) {
    this.write = write; this.notify = notify; this.delay = delay;
  }

  enqueue(url: string, body: string) {
    this.pending.set(url, body);
    if (this.timer) clearTimeout(this.timer);
    this.notify(this.failed ? "error" : "pending");
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }

  get unsaved() { return this.pending.size > 0 || this.running !== null; }

  flush(retry = false): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (retry) this.failed = false;
    if (this.running) return this.running;
    if (this.failed) return Promise.resolve(false);
    if (!this.pending.size) return Promise.resolve(true);
    this.notify("saving");
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain() {
    while (this.pending.size) {
      const [url, body] = this.pending.entries().next().value!;
      try { await this.write(url, body); }
      catch {
        // Keep the latest body (which may have changed during the request).
        this.failed = true;
        this.notify("error");
        return false;
      }
      if (this.pending.get(url) === body) this.pending.delete(url);
    }
    this.notify("saved");
    return true;
  }
}
