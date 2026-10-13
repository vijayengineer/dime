import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Address, Hex } from "viem";

/** Deployment manifest written by contracts/script/Deploy.s.sol + scripts/finalize-manifest.mjs. */
export const ManifestSchema = z.object({
  chainId: z.number(),
  stage: z.enum(["testnet", "commissioning", "mainnet"]),
  protocol: z.string(),
  verifier: z.string(),
  oracleKind: z.string(),
  independentOracle: z.boolean(),
  collateral: z.string(),
  collateralSymbol: z.string(),
  collateralDecimals: z.number(),
  collateralIsTestToken: z.boolean(),
  deploymentBlock: z.number(),
  configVersion: z.number(),
  allowlistEnabled: z.boolean(),
  eip712Name: z.string(),
  eip712Version: z.string(),
  relayer: z.string(),
  guardian: z.string(),
  reporter: z.string(),
  dimeToken: z.string().optional(),
});
export type Manifest = z.infer<typeof ManifestSchema> & { protocol: Address; verifier: Address; collateral: Address };

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  CHAIN_ID: z.coerce.number(),
  RPC_URL: z.string().url(),
  MANIFEST_PATH: z.string().optional(),
  DB_PATH: z.string().default("./data/dime.sqlite"),
  RELAYER_KEY_FILE: z.string().optional(),
  REPORTER_KEY_FILE: z.string().optional(),
  KEEPER_KEY_FILE: z.string().optional(),
  GUARDIAN_KEY_FILE: z.string().optional(),
  PRICE_SOURCES: z.string().default("hyperliquid,binance,coinbase,okx,bybit,kraken"),
  PRICING_PORT: z.coerce.number().default(8710),
  PRICING_URL: z.string().default("ws://127.0.0.1:8710/internal"),
  MAX_SOURCE_AGE_MS: z.coerce.number().default(2000),
  MAX_DISAGREEMENT_BPS: z.coerce.number().default(15),
  MIN_SOURCES: z.coerce.number().default(2),
  API_PORT: z.coerce.number().default(8720),
  API_HOST: z.string().default("127.0.0.1"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  AUTH_MODE: z.enum(["privy", "none"]).default("privy"),
  PRIVY_APP_ID: z.string().optional(),
  ENVIO_API_TOKEN: z.string().optional(),
  /** Invite-only live test: wallets join with this code (case-insensitive), up to MAX_INVITED. Unset = open to all. */
  INVITE_CODE: z.string().optional(),
  MAX_INVITED: z.coerce.number().default(20),
  /** One-time MON top-up for joining wallets with too little gas. Unset = no top-ups. */
  FAUCET_KEY_FILE: z.string().optional(),
  FAUCET_DRIP_WEI: z.coerce.bigint().default(100_000_000_000_000_000n),
  FAUCET_MIN_BALANCE_WEI: z.coerce.bigint().default(20_000_000_000_000_000n),
  MAX_QUEUE_PER_BUCKET: z.coerce.number().default(100),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(600),
  KEEPER_INTERVAL_MS: z.coerce.number().default(1000),
  WATCHDOG_INTERVAL_MS: z.coerce.number().default(2000),
  WATCHDOG_STALE_HOLD_MS: z.coerce.number().default(10000),
});
export type Config = z.infer<typeof Env> & { manifest: Manifest };

function parseEnv(env: NodeJS.ProcessEnv) {
  loadDotEnv();
  const e = Env.parse(env);
  if (e.NODE_ENV === "production" && e.AUTH_MODE === "none") throw new Error("AUTH_MODE=none is refused in production");
  if (e.NODE_ENV === "production" && e.PRICE_SOURCES.includes("mock")) throw new Error("mock price sources are refused in production");
  return e;
}

function readManifest(e: z.infer<typeof Env>): Manifest {
  if (!e.MANIFEST_PATH) throw new Error("MANIFEST_PATH is required");
  const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.resolve(e.MANIFEST_PATH), "utf8"))) as Manifest;
  if (manifest.chainId !== e.CHAIN_ID) throw new Error(`manifest chainId ${manifest.chainId} != CHAIN_ID ${e.CHAIN_ID}`);
  if (manifest.stage !== "testnet" && manifest.collateralIsTestToken) throw new Error("test collateral outside testnet stage");
  return manifest;
}

/** API / keeper / watchdog: a real deployment manifest is mandatory. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = parseEnv(env);
  return { ...e, manifest: readManifest(e) };
}

/** Pricing: runs feed-only without a deployment; the manifest is needed only to sign reference proofs. */
export function loadPricingConfig(env: NodeJS.ProcessEnv = process.env): Omit<Config, "manifest"> & { manifest?: Manifest } {
  const e = parseEnv(env);
  const manifest = e.MANIFEST_PATH ? readManifest(e) : undefined;
  if (e.REPORTER_KEY_FILE && !manifest) throw new Error("REPORTER_KEY_FILE set but no MANIFEST_PATH: cannot sign without the verifier address");
  return { ...e, manifest };
}

/** Reads a hex private key from a file. Never logs or returns it in errors. */
export function readKey(file: string | undefined, role: string): Hex {
  if (!file) throw new Error(`${role} key file not configured`);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8").trim(); } catch { throw new Error(`${role} key file unreadable`); }
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${role} key file malformed`);
  return k as Hex;
}

function loadDotEnv() {
  const p = path.resolve(".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#]*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
