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
  close_commit?: number | null; // block.timestamp of a direct close request awaiting settlement
}

/**
 * PREPARED → SIGNED (raw bytes + hash journalled, not yet broadcast) → SENT → INCLUDED | REVERTED.
 * UNKNOWN = broadcast outcome or receipt unknown (reconciled from receipts and the sender nonce).
 * DROPPED = the nonce was used by another transaction. FAILED = provably not sent.
 */
export type TxStatus = "PREPARED" | "SIGNED" | "SENT" | "INCLUDED" | "REVERTED" | "FAILED" | "UNKNOWN" | "DROPPED";
export interface TxRow {
  id: string;
  kind: "OPEN_HOUSE" | "OPEN_MATCHED" | "CLOSE" | "SETTLE_CLOSE" | "LIQUIDATE" | "PROTECT" | "HEARTBEAT" | "FUND_EPOCH" | "SET_STATE";
  ref: string; // intent ids / position id
  sender: string;
  nonce: number | null;
  hash: string | null;
  raw: string | null; // signed transaction bytes, journalled before broadcast
  status: TxStatus;
  error: string | null;
  block: number | null;
  sent_at: number | null;
  included_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GasGrant {
  address: string; status: "PENDING" | "SENT" | "CONFIRMED" | "FAILED"; wei: string; tx: string | null; error: string | null;
  created_at: number; updated_at: number;
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
      CREATE TABLE IF NOT EXISTS invites (
        address TEXT PRIMARY KEY, invited_at INTEGER NOT NULL, drip_tx TEXT
      );
      CREATE TABLE IF NOT EXISTS gas_grants (
        address TEXT PRIMARY KEY, status TEXT NOT NULL, wei TEXT NOT NULL, tx TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terms (
        address TEXT NOT NULL, version TEXT NOT NULL, signature TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        PRIMARY KEY (address, version)
      );
    `);
    this.migrate();
  }

  private migrate() {
    const cols = (this.db.prepare("PRAGMA table_info(txs)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("raw")) this.db.exec("ALTER TABLE txs ADD COLUMN raw TEXT");
    const pcols = (this.db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]).map((c) => c.name);
    if (!pcols.includes("close_commit")) this.db.exec("ALTER TABLE positions ADD COLUMN close_commit INTEGER");
    // Legacy drips (recorded on invites) count as grants, so no wallet gets a second one after upgrade.
    this.db.exec(`INSERT OR IGNORE INTO gas_grants (address, status, wei, tx, error, created_at, updated_at)
      SELECT address, 'CONFIRMED', '0', drip_tx, NULL, invited_at, invited_at FROM invites WHERE drip_tx IS NOT NULL`);
  }

  /* terms of use: one signed acceptance per wallet and version */
  acceptTerms(address: string, version: string, signature: string) {
    this.db.prepare("INSERT OR IGNORE INTO terms VALUES (?, ?, ?, ?)").run(address.toLowerCase(), version, signature, Date.now());
  }
  hasAcceptedTerms(address: string, version: string) {
    return !!this.db.prepare("SELECT 1 FROM terms WHERE address = ? AND version = ?").get(address.toLowerCase(), version);
  }

  /* invite-only live test */
  isInvited(address: string) { return !!this.db.prepare("SELECT 1 FROM invites WHERE address = ?").get(address.toLowerCase()); }
  invitedCount() { return (this.db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n; }
  /** Adds the wallet if there is room; returns true if it is (now) invited. Atomic, so the cap holds under concurrency. */
  invite(address: string, max: number): boolean {
    return this.db.transaction(() => {
      if (this.isInvited(address)) return true;
      if (this.invitedCount() >= max) return false;
      this.db.prepare("INSERT INTO invites (address, invited_at) VALUES (?, ?)").run(address.toLowerCase(), Date.now());
      return true;
    })();
  }
  /* gas grants: an independent ledger keyed by wallet, not tied to invites (audit M-08) */
  gasGrant(address: string) {
    return this.db.prepare("SELECT * FROM gas_grants WHERE address = ?").get(address.toLowerCase()) as GasGrant | undefined;
  }
  /** Reserve the one grant for this wallet. False if it already has one (in any state but FAILED-without-tx). */
  reserveGasGrant(address: string, wei: bigint): boolean {
    return this.db.transaction(() => {
      const cur = this.gasGrant(address);
      if (cur && !(cur.status === "FAILED" && !cur.tx)) return false;
      const now = Date.now();
      this.db.prepare(`INSERT INTO gas_grants VALUES (?, 'PENDING', ?, NULL, NULL, ?, ?)
        ON CONFLICT(address) DO UPDATE SET status = 'PENDING', wei = excluded.wei, error = NULL, updated_at = excluded.updated_at`)
        .run(address.toLowerCase(), wei.toString(), now, now);
      return true;
    })();
  }
  updateGasGrant(address: string, patch: { status: GasGrant["status"]; tx?: string | null; error?: string | null }) {
    this.db.prepare("UPDATE gas_grants SET status = ?, tx = COALESCE(?, tx), error = ?, updated_at = ? WHERE address = ?")
      .run(patch.status, patch.tx ?? null, patch.error ?? null, Date.now(), address.toLowerCase());
  }
  /** Total granted (sent or confirmed) since `sinceMs`, for the global daily budget. */
  gasGrantedSince(sinceMs: number): bigint {
    const rows = this.db.prepare("SELECT wei FROM gas_grants WHERE status IN ('PENDING','SENT','CONFIRMED') AND created_at >= ?").all(sinceMs) as { wei: string }[];
    return rows.reduce((s, r) => s + BigInt(r.wei), 0n);
  }
  gasGrantsByStatus(status: GasGrant["status"]) { return this.db.prepare("SELECT * FROM gas_grants WHERE status = ?").all(status) as GasGrant[]; }

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
    this.db.prepare(`INSERT INTO txs (id, kind, ref, sender, nonce, hash, raw, status, error, block, sent_at, included_at, created_at, updated_at)
      VALUES (@id,@kind,@ref,@sender,@nonce,@hash,@raw,@status,@error,@block,@sent_at,@included_at,@created_at,@updated_at)`).run(r);
  }
  updateTx(id: string, patch: Partial<TxRow>) {
    const cur = this.db.prepare("SELECT * FROM txs WHERE id = ?").get(id) as TxRow;
    const next = { ...cur, ...patch, updated_at: Date.now() };
    this.db.prepare(`UPDATE txs SET nonce=@nonce, hash=@hash, raw=@raw, status=@status, error=@error, block=@block,
      sent_at=@sent_at, included_at=@included_at, updated_at=@updated_at WHERE id=@id`).run(next);
    return next;
  }
  /** Transactions that carried these intents (ref is a comma-separated intent id list for opens). */
  txsForRef(ref: string) { return this.db.prepare("SELECT * FROM txs WHERE ref = ? OR ref LIKE ? OR ref LIKE ? ORDER BY created_at").all(ref, `${ref},%`, `%,${ref}`) as TxRow[]; }
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
    this.db.prepare(`INSERT INTO positions (id, user, route, side, collateral, leverage, entry, liq, reservation, pair_id, opened_block, open_tx, settled)
      VALUES (@id,@user,@route,@side,@collateral,@leverage,@entry,@liq,@reservation,@pair_id,@opened_block,@open_tx,0)
      ON CONFLICT(id) DO NOTHING`).run((({ close_commit: _c, ...row }) => row)(p));
  }
  getPosition(id: string) { return this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id.toLowerCase()) as (PositionRow & { settled: number }) | undefined; }
  openPositions() { return this.db.prepare("SELECT * FROM positions WHERE settled = 0").all() as PositionRow[]; }
  markSettled(id: string) { this.db.prepare("UPDATE positions SET settled = 1 WHERE id = ?").run(id.toLowerCase()); }
  setReservation(id: string, r: string) { this.db.prepare("UPDATE positions SET reservation = ? WHERE id = ?").run(r, id.toLowerCase()); }
  setCloseCommit(id: string, at: number) { this.db.prepare("UPDATE positions SET close_commit = ? WHERE id = ?").run(at, id.toLowerCase()); }

  /* meta */
  getMeta(key: string) { return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string) { this.db.prepare("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }
}
