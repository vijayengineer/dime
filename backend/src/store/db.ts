import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Persistent request lifecycle + transaction reconciliation. Contract state remains
 * authoritative; this store exists so restarts never lose track of a request or a sent tx.
 * SQLite (WAL) is sufficient for the small-scale v1; the schema ports to Postgres.
 */
export type IntentStatus = "MATCHING" | "SUBMITTED" | "OPENED" | "CAPACITY_UNAVAILABLE" | "EXPIRED" | "REJECTED" | "CANCELLED";
export const TERMINAL: IntentStatus[] = ["OPENED", "CAPACITY_UNAVAILABLE", "EXPIRED", "REJECTED", "CANCELLED"];

export interface IntentRow {
  id: string;
  user: string; // lowercase
  nonce: string;
  status: IntentStatus;
  side: 0 | 1;
  collateral: string;
  leverage: number;
  route_mask: number;
  match_deadline: number; // unix s
  expiry: number; // unix s
  price_limit: string;
  config_version: number;
  match_window_ms: number;
  slippage_bps: number;
  message: string; // JSON (bigints as strings)
  signature: string;
  route: "MATCHED" | "HOUSE" | null;
  reason: string | null;
  tx_id: string | null;
  position_id: string | null;
  timeline: string; // JSON [{status, at, note}]
  created_at: number;
  updated_at: number;
}

export interface PositionRow {
  id: string; user: string; route: "MATCHED" | "HOUSE"; side: 0 | 1; collateral: string; leverage: number;
  entry: string; liq: string; reservation: string; pair_id: string | null; opened_block: number; open_tx: string;
}

export type TxStatus = "PREPARED" | "SENT" | "INCLUDED" | "REVERTED" | "FAILED" | "UNKNOWN";
export interface TxRow {
  id: string;
  kind: "OPEN_HOUSE" | "OPEN_MATCHED" | "CLOSE" | "LIQUIDATE" | "PROTECT" | "FUND_EPOCH" | "SET_STATE";
  ref: string; // intent ids / position id
  sender: string;
  nonce: number | null;
  hash: string | null;
  status: TxStatus;
  error: string | null;
  block: number | null;
  sent_at: number | null;
  included_at: number | null;
  created_at: number;
  updated_at: number;
}

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL,
        side INTEGER NOT NULL, collateral TEXT NOT NULL, leverage INTEGER NOT NULL, route_mask INTEGER NOT NULL,
        match_deadline INTEGER NOT NULL, expiry INTEGER NOT NULL, price_limit TEXT NOT NULL, config_version INTEGER NOT NULL,
        match_window_ms INTEGER NOT NULL, slippage_bps INTEGER NOT NULL, message TEXT NOT NULL, signature TEXT NOT NULL,
        route TEXT, reason TEXT, tx_id TEXT, position_id TEXT, timeline TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user, nonce)
      );
      CREATE INDEX IF NOT EXISTS intents_status ON intents(status);
      CREATE INDEX IF NOT EXISTS intents_user ON intents(user, created_at);
      CREATE INDEX IF NOT EXISTS intents_position ON intents(position_id);
      CREATE TABLE IF NOT EXISTS txs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, sender TEXT NOT NULL, nonce INTEGER,
        hash TEXT, status TEXT NOT NULL, error TEXT, block INTEGER, sent_at INTEGER, included_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS txs_status ON txs(status);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, route TEXT NOT NULL, side INTEGER NOT NULL, collateral TEXT NOT NULL,
        leverage INTEGER NOT NULL, entry TEXT NOT NULL, liq TEXT NOT NULL, reservation TEXT NOT NULL, pair_id TEXT,
        opened_block INTEGER NOT NULL, open_tx TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS positions_open ON positions(settled);
      CREATE TABLE IF NOT EXISTS terms (
        address TEXT NOT NULL, version TEXT NOT NULL, signature TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        PRIMARY KEY (address, version)
      );
    `);
  }

  /* terms of use: one signed acceptance per wallet and version */
  acceptTerms(address: string, version: string, signature: string) {
    this.db.prepare("INSERT OR IGNORE INTO terms VALUES (?, ?, ?, ?)").run(address.toLowerCase(), version, signature, Date.now());
  }
  hasAcceptedTerms(address: string, version: string) {
    return !!this.db.prepare("SELECT 1 FROM terms WHERE address = ? AND version = ?").get(address.toLowerCase(), version);
  }

  /* intents */
  insertIntent(r: IntentRow) {
    this.db.prepare(`INSERT INTO intents VALUES (@id,@user,@nonce,@status,@side,@collateral,@leverage,@route_mask,
      @match_deadline,@expiry,@price_limit,@config_version,@match_window_ms,@slippage_bps,@message,@signature,
      @route,@reason,@tx_id,@position_id,@timeline,@created_at,@updated_at)`).run(r);
  }
  getIntent(id: string) { return this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as IntentRow | undefined; }
  intentByNonce(user: string, nonce: string) {
    return this.db.prepare("SELECT * FROM intents WHERE user = ? AND nonce = ?").get(user.toLowerCase(), nonce) as IntentRow | undefined;
  }
  intentByPosition(positionId: string) {
    return this.db.prepare("SELECT * FROM intents WHERE position_id = ?").get(positionId.toLowerCase()) as IntentRow | undefined;
  }
  liveIntentForUser(user: string) {
    return this.db.prepare("SELECT * FROM intents WHERE user = ? AND status IN ('MATCHING','SUBMITTED') LIMIT 1").get(user.toLowerCase()) as IntentRow | undefined;
  }
  latestIntentForUser(user: string) {
    return this.db.prepare("SELECT * FROM intents WHERE user = ? ORDER BY created_at DESC LIMIT 1").get(user.toLowerCase()) as IntentRow | undefined;
  }
  intentsByStatus(status: IntentStatus) { return this.db.prepare("SELECT * FROM intents WHERE status = ? ORDER BY created_at").all(status) as IntentRow[]; }

  /** Compare-and-set status transition; returns false if the intent was not in `from`. */
  transition(id: string, from: IntentStatus[], to: IntentStatus, patch: Partial<IntentRow> = {}, note?: string): boolean {
    const tx = this.db.transaction(() => {
      const cur = this.getIntent(id);
      if (!cur || !from.includes(cur.status)) return false;
      const now = Date.now();
      const timeline = JSON.parse(cur.timeline) as unknown[];
      timeline.push({ status: to, at: now, note });
      const next = { ...cur, ...patch, status: to, timeline: JSON.stringify(timeline), updated_at: now };
      this.db.prepare(`UPDATE intents SET status=@status, route=@route, reason=@reason, tx_id=@tx_id,
        position_id=@position_id, timeline=@timeline, updated_at=@updated_at WHERE id=@id`).run(next);
      return true;
    });
    return tx();
  }

  /* txs */
  insertTx(r: TxRow) {
    this.db.prepare(`INSERT INTO txs VALUES (@id,@kind,@ref,@sender,@nonce,@hash,@status,@error,@block,@sent_at,@included_at,@created_at,@updated_at)`).run(r);
  }
  updateTx(id: string, patch: Partial<TxRow>) {
    const cur = this.db.prepare("SELECT * FROM txs WHERE id = ?").get(id) as TxRow;
    const next = { ...cur, ...patch, updated_at: Date.now() };
    this.db.prepare(`UPDATE txs SET nonce=@nonce, hash=@hash, status=@status, error=@error, block=@block,
      sent_at=@sent_at, included_at=@included_at, updated_at=@updated_at WHERE id=@id`).run(next);
    return next;
  }
  getTx(id: string) { return this.db.prepare("SELECT * FROM txs WHERE id = ?").get(id) as TxRow | undefined; }
  txsByStatus(...st: TxStatus[]) {
    return this.db.prepare(`SELECT * FROM txs WHERE status IN (${st.map(() => "?").join(",")}) ORDER BY created_at`).all(...st) as TxRow[];
  }

  /* idempotency */
  idem(key: string) { return (this.db.prepare("SELECT response FROM idempotency WHERE key = ?").get(key) as { response: string } | undefined)?.response; }
  saveIdem(key: string, response: string) {
    this.db.prepare("INSERT OR IGNORE INTO idempotency VALUES (?, ?, ?)").run(key, response, Date.now());
  }

  /* positions (index of PositionOpened events; contract state is authoritative) */
  upsertPosition(p: PositionRow) {
    this.db.prepare(`INSERT INTO positions VALUES (@id,@user,@route,@side,@collateral,@leverage,@entry,@liq,@reservation,@pair_id,@opened_block,@open_tx,0)
      ON CONFLICT(id) DO NOTHING`).run(p);
  }
  getPosition(id: string) { return this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id.toLowerCase()) as (PositionRow & { settled: number }) | undefined; }
  openPositions() { return this.db.prepare("SELECT * FROM positions WHERE settled = 0").all() as PositionRow[]; }
  markSettled(id: string) { this.db.prepare("UPDATE positions SET settled = 1 WHERE id = ?").run(id.toLowerCase()); }
  setReservation(id: string, r: string) { this.db.prepare("UPDATE positions SET reservation = ? WHERE id = ?").run(r, id.toLowerCase()); }

  /* meta */
  getMeta(key: string) { return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string) { this.db.prepare("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }
}
