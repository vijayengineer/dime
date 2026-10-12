import type { Feed, Listener, Unsubscribe } from "./types";

/** Minimal multicast holder used by both demo and live adapters. */
export class FeedHub<T> {
  private listeners = new Set<Listener<Feed<T>>>();
  private current: Feed<T> = { status: "loading" };

  get value(): Feed<T> { return this.current; }

  subscribe(cb: Listener<Feed<T>>, onFirst?: () => void): Unsubscribe {
    const first = this.listeners.size === 0;
    this.listeners.add(cb);
    cb(this.current);
    if (first) onFirst?.();
    return () => { this.listeners.delete(cb); };
  }

  ok(value: T) { this.emit({ status: "ok", value, at: Date.now() }); }

  error(error: string) {
    const last = this.current.status === "ok" ? this.current.value : this.current.status === "error" ? this.current.last : undefined;
    this.emit({ status: "error", error, at: Date.now(), last });
  }

  private emit(f: Feed<T>) {
    this.current = f;
    for (const l of this.listeners) l(f);
  }
}

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  subscribe(cb: Listener<T>): Unsubscribe { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  emit(v: T) { for (const l of this.listeners) l(v); }
}
