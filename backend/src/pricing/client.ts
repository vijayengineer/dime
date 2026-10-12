import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Hex } from "viem";
import { log } from "../log";

export interface ProofWire { price: string; tsMs: number; payload: Hex; signer: string }
export interface SnapshotWire {
  market: string; estimate: string; reference: { price: string; ts: number; verifier: string } | null;
  sources: { id: string; name: string; quote: string; price: string; ts: number; recvAt: number; seq: number; used: boolean }[];
  ageMs: number; disagreementBps: number; referenceDeviationBps: number | null; quality: string; publishedAt: number;
}

/** Subscribes to the pricing service's internal stream. Consumers must check freshness themselves. */
export class PriceClient extends EventEmitter {
  snapshot: SnapshotWire | null = null;
  proof: ProofWire | null = null;
  connected = false;
  receivedAt = 0;
  readonly history: { t: number; price: string }[] = [];
  private ws: WebSocket | null = null;

  constructor(private url: string) {
    super();
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on("open", () => { this.connected = true; log.info("price client connected"); });
    this.ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString()) as { type: string; data: SnapshotWire; proof: ProofWire | null };
      if (m.type !== "snapshot") return;
      this.snapshot = m.data;
      this.proof = m.proof;
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

  /** Latest proof if younger than maxAgeMs and price quality is OK. */
  freshProof(maxAgeMs: number): ProofWire | null {
    if (!this.proof || this.snapshot?.quality !== "OK") return null;
    return Date.now() - this.proof.tsMs <= maxAgeMs ? this.proof : null;
  }

  close() { this.ws?.removeAllListeners("close"); this.ws?.close(); }
}
