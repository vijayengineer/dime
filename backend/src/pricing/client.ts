import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Hex } from "viem";
import { log } from "../log";

/** A signed price round (see contracts OperatorPriceVerifier v2). */
export interface ProofWire {
  price: string; tsMs: number; round: number; quality: "OK" | "DEGRADED"; sources: number; obsMs: number; payload: Hex; signer: string;
}
export interface SnapshotWire {
  market: string; estimate: string; reference: { price: string; ts: number; verifier: string } | null;
  sources: { id: string; name: string; quote: string; price: string; ts: number; recvAt: number; seq: number; used: boolean }[];
  ageMs: number; disagreementBps: number; referenceDeviationBps: number | null; quality: string; publishedAt: number;
}

/** What a proof is for: opening needs an OK multi-venue round; settlement also accepts DEGRADED (audit H-04). */
export type ProofUse = "open" | "settle";

export const ROUND_MS = 250;
export const roundOf = (ms: number) => Math.floor(ms / ROUND_MS);

/** Subscribes to the pricing service's internal stream. Consumers must check freshness themselves. */
export class PriceClient extends EventEmitter {
  snapshot: SnapshotWire | null = null;
  proof: ProofWire | null = null;
  connected = false;
  receivedAt = 0;
  readonly history: { t: number; price: string }[] = [];
  private rounds = new Map<number, ProofWire>();
  private ws: WebSocket | null = null;
  private readonly httpBase: string;

  constructor(private url: string) {
    super();
    this.httpBase = url.replace(/^ws/, "http").replace("/internal", "");
    this.connect();
  }

  private keep(p: ProofWire | null) {
    if (!p) return;
    this.proof = !this.proof || p.round >= this.proof.round ? p : this.proof;
    this.rounds.set(p.round, p);
    if (this.rounds.size > 2400) this.rounds.delete(this.rounds.keys().next().value!);
  }

  private connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on("open", () => { this.connected = true; log.info("price client connected"); });
    this.ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString()) as { type: string; data?: SnapshotWire; proof?: ProofWire | null };
      if (m.type === "proof") { this.keep(m.proof ?? null); this.emit("proof", m.proof); return; }
      if (m.type !== "snapshot" || !m.data) return;
      this.snapshot = m.data;
      this.keep(m.proof ?? null);
      this.receivedAt = Date.now();
      const t = Math.floor(m.data.publishedAt / 1000) * 1000;
      const last = this.history[this.history.length - 1];
      if (!last || last.t < t) {
        this.history.push({ t, price: m.data.estimate });
        if (this.history.length > 3600) this.history.shift();
      }
      this.emit("snapshot", m.data);
    });
    this.ws.on("close", () => { this.connected = false; setTimeout(() => this.connect(), 1000); });
    this.ws.on("error", (e) => log.warn({ err: e.message }, "price client error"));
  }

  /** Latest proof if younger than maxAgeMs and good enough for `use` (opening needs OK). */
  freshProof(maxAgeMs: number, use: ProofUse = "settle"): ProofWire | null {
    const p = this.proof;
    if (!p) return null;
    if (use === "open" && (p.quality !== "OK" || this.snapshot?.quality !== "OK")) return null;
    return Date.now() - p.tsMs <= maxAgeMs ? p : null;
  }

  /**
   * The first signed round strictly after `round` and at most `round + slack` (the contract's close
   * window). Local copy first, then the pricing service. Null if it doesn't exist (yet).
   */
  async proofAfter(round: number, slack = 8): Promise<ProofWire | null> {
    for (let r = round + 1; r <= round + slack; r++) { const p = this.rounds.get(r); if (p) return p; }
    try {
      const res = await fetch(`${this.httpBase}/proof/after?round=${round}`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return null;
      const p = (await res.json()) as ProofWire;
      return p.round > round && p.round <= round + slack ? p : null;
    } catch { return null; }
  }

  close() { this.ws?.removeAllListeners("close"); this.ws?.close(); }
}
