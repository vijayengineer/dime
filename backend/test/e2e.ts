/**
 * End-to-end test against a LOCAL anvil chain with the real contracts and services.
 *   anvil --code-size-limit 131072  +  contracts deployed (deployments/31337.json)
 * Uses anvil's well-known dev keys (local only). Spawns pricing (MOCK feed), api and keeper.
 * Run: npm run e2e
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http, keccak256, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dimeAbi, testUsdcAbi } from "../../shared/abi";
import { termsMessage } from "../../shared/terms";

const RPC = "http://127.0.0.1:8545";
const manifest = JSON.parse(fs.readFileSync("../deployments/31337.json", "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const K = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  guardian: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  reporter: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  keeper: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  alice: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  bob: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
} as const;
const API = "http://127.0.0.1:8820";
const PRICING = "http://127.0.0.1:8810";
const dime = { address: manifest.protocol as Address, abi: dimeAbi } as const;
const usdc = { address: manifest.collateral as Address, abi: testUsdcAbi } as const;
const domain = { name: "DIME", version: "1", chainId: 31337, verifyingContract: manifest.protocol as Address };
const ORDER_TYPES = {
  OrderIntent: [
    { name: "user", type: "address" }, { name: "market", type: "bytes32" }, { name: "side", type: "uint8" },
    { name: "collateral", type: "uint128" }, { name: "leverage", type: "uint16" }, { name: "routeMask", type: "uint8" },
    { name: "matchDeadline", type: "uint64" }, { name: "priceLimit", type: "uint128" }, { name: "configVersion", type: "uint32" },
    { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" },
  ],
} as const;
const CLOSE_TYPES = { CloseRequest: [
  { name: "user", type: "address" }, { name: "positionId", type: "bytes32" }, { name: "requestedAtMs", type: "uint64" },
  { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" },
] } as const;
const DIME_PER_LOSS_OF_10C = 10n ** 18n; // 10 DIME per $1 (deploy default) × $0.10 = 1 DIME

const results: { name: string; ok: boolean; detail?: string }[] = [];
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(name: string, ok: boolean, detail?: string) { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); }

function wallet(key: Hex) { const account = privateKeyToAccount(key); return { account, w: createWalletClient({ account, chain, transport: http(RPC) }) }; }
async function send(key: Hex, c: { address: Address; abi: readonly unknown[] }, functionName: string, args: unknown[] = []) {
  const { w } = wallet(key);
  const hash = await w.writeContract({ address: c.address, abi: c.abi as never, functionName: functionName as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

async function startServices() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-e2e-"));
  const keyFile = (n: string, k: string) => { const f = path.join(dir, `${n}.key`); fs.writeFileSync(f, k, { mode: 0o600 }); return f; };
  const env = {
    ...process.env, NODE_ENV: "test", CHAIN_ID: "31337", RPC_URL: RPC, MANIFEST_PATH: "../deployments/31337.json",
    DB_PATH: path.join(dir, "api.sqlite"), KEEPER_DB_PATH: path.join(dir, "keeper.sqlite"),
    RELAYER_KEY_FILE: keyFile("relayer", K.relayer), REPORTER_KEY_FILE: keyFile("reporter", K.reporter),
    KEEPER_KEY_FILE: keyFile("keeper", K.keeper), GUARDIAN_KEY_FILE: keyFile("guardian", K.guardian),
    PRICE_SOURCES: "mock", PRICING_PORT: "8810", PRICING_URL: "ws://127.0.0.1:8810/internal",
    API_PORT: "8820", KEEPER_PORT: "8830", AUTH_MODE: "none", RATE_LIMIT_PER_MIN: "10000", LOG_LEVEL: "warn",
  };
  for (const s of ["pricing", "api", "keeper"]) {
    const tsx = ["node_modules/.bin/tsx", "../node_modules/.bin/tsx"].find((f) => fs.existsSync(f)) ?? "tsx";
    const p = spawn(tsx, [`src/${s}/main.ts`], { env, stdio: ["ignore", "inherit", "inherit"] });
    procs.push(p);
    if (s === "pricing") await sleep(1500);
  }
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error("api did not become healthy");
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body, (_, x) => (typeof x === "bigint" ? x.toString() : x)) });
  return { status: r.status, body: await r.json() as any };
}

let nonceSeq = BigInt(Date.now()) * 1000n;
/** Quote → sign → submit, using the server's auto-execution (house first, matching only when the house is full) like the app. */
async function placeIntent(key: Hex, side: 0 | 1) {
  const { account } = wallet(key);
  const q = await post("/v1/quotes", { side: side === 0 ? "LONG" : "SHORT", collateral: "100000", leverage: 1000 });
  if (q.status !== 200) throw new Error(`quote failed ${JSON.stringify(q.body)}`);
  const auto = q.body.auto as { routes: { matched: boolean; houseFallback: boolean }; matchWindowMs: number; slippageBps: number };
  const routeMask = (auto.routes.matched ? 1 : 0) | (auto.routes.houseFallback ? 2 : 0);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const message = {
    user: account.address, market: keccak256(toHex("BTC-USD")), side, collateral: 100_000n, leverage: 1000, routeMask,
    matchDeadline: now + BigInt(Math.ceil(auto.matchWindowMs / 1000)), priceLimit: BigInt(q.body.priceLimit), configVersion: q.body.configVersion,
    expiry: now + 30n, nonce: ++nonceSeq,
  };
  const signature = await account.signTypedData({ domain, types: ORDER_TYPES, primaryType: "OrderIntent", message });
  const r = await post("/v1/intents", { quoteId: q.body.id, message, signature, matchWindowMs: auto.matchWindowMs, slippageBps: auto.slippageBps }, { "idempotency-key": `${account.address}:${message.nonce}` });
  return { r, message, signature, account, quote: q.body };
}

async function acceptTerms(key: Hex) {
  const { account } = wallet(key);
  const signature = await account.signMessage({ message: termsMessage(account.address) });
  return post("/v1/terms", { address: account.address, signature });
}

async function waitStatus(id: string, want: string[], ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await (await fetch(`${API}/v1/intents/${id}`)).json() as any;
    if (want.includes(r.status)) return r;
    await sleep(150);
  }
  return (await (await fetch(`${API}/v1/intents/${id}`)).json()) as any;
}

async function main() {
  // --- setup: reserve + user deposits (on-chain, direct)
  // The house starts EMPTY so the first trades exercise matching (the overflow path); it is funded at step 5.
  const admin = privateKeyToAccount(K.admin).address;
  await send(K.admin, usdc, "mint", [admin, 10_000_000n]);
  await send(K.admin, usdc, "approve", [dime.address, 10_000_000n]);
  for (const k of [K.alice, K.bob]) {
    await send(k, usdc, "faucet");
    await send(k, usdc, "approve", [dime.address, 10_000_000n]);
    await send(k, dime, "deposit", [2_000_000n]);
  }
  const alice = privateKeyToAccount(K.alice).address, bob = privateKeyToAccount(K.bob).address;
  await startServices();
  await sleep(1500);
  const t1 = await acceptTerms(K.alice), t2 = await acceptTerms(K.bob);
  check("terms accepted with wallet signatures", t1.status === 200 && t2.status === 200, `${t1.status}/${t2.status}`);
  const blocked = await post("/v1/intents", {}, {});
  check("intents still validated", blocked.status === 400 || blocked.status === 401, String(blocked.status));

  // 1. matched pair
  const a = await placeIntent(K.alice, 0);
  const b = await placeIntent(K.bob, 1);
  check("intents admitted", a.r.status === 201 && b.r.status === 201, `${a.r.status}/${b.r.status}`);
  const [ao, bo] = await Promise.all([waitStatus(a.r.body.id, ["OPENED", "REJECTED", "EXPIRED"]), waitStatus(b.r.body.id, ["OPENED", "REJECTED", "EXPIRED"])]);
  check("matched pair opened atomically", ao.status === "OPENED" && bo.status === "OPENED" && ao.route === "MATCHED", `${ao.status}/${bo.status} ${ao.reason ?? ""}`);
  const posA = await pub.readContract({ ...dime, functionName: "positionOf", args: [alice] });
  const posB = await pub.readContract({ ...dime, functionName: "positionOf", args: [bob] });
  check("both legs share a pairId on-chain", posA.pairId === posB.pairId && posA.pairId !== `0x${"0".repeat(64)}`);

  // 2. idempotency + duplicate nonce
  const dup = await post("/v1/intents", { message: a.message, signature: a.signature }, { "idempotency-key": `${a.account.address}:${a.message.nonce}` });
  check("idempotent replay returns original", dup.status === 200 && dup.body.id === a.r.body.id);
  const dup2 = await post("/v1/intents", { message: a.message, signature: a.signature }, { "idempotency-key": "other-key" });
  check("same nonce under new key rejected", dup2.status === 409, String(dup2.status));

  // 3. close by alice settles both
  const freeBobBefore = await pub.readContract({ ...dime, functionName: "freeBalance", args: [bob] });
  const closeMsg = { user: alice, positionId: posA.id, requestedAtMs: BigInt(Date.now()), expiry: BigInt(Math.floor(Date.now() / 1000) + 30), nonce: ++nonceSeq };
  const closeSig = await a.account.signTypedData({ domain, types: CLOSE_TYPES, primaryType: "CloseRequest", message: closeMsg });
  const cl = await post("/v1/close", { message: closeMsg, signature: closeSig }, { "idempotency-key": `close:${closeMsg.nonce}` });
  check("close relayed", cl.status === 200 && cl.body.status === "INCLUDED", JSON.stringify(cl.body));
  const pA = await pub.readContract({ ...dime, functionName: "positionOf", args: [alice] });
  const pB = await pub.readContract({ ...dime, functionName: "positionOf", args: [bob] });
  const freeBobAfter = await pub.readContract({ ...dime, functionName: "freeBalance", args: [bob] });
  check("counterparty leg settled too", pA.collateral === 0n && pB.collateral === 0n && freeBobAfter > freeBobBefore - 1n);

  // 3b. a back-dated close request is refused (it would reach for a historical price round)
  const old = { ...closeMsg, requestedAtMs: BigInt(Date.now() - 60_000), nonce: ++nonceSeq };
  const oldSig = await a.account.signTypedData({ domain, types: CLOSE_TYPES, primaryType: "CloseRequest", message: old });
  const oldR = await post("/v1/close", { message: old, signature: oldSig }, { "idempotency-key": `close:${old.nonce}` });
  check("back-dated close request refused", oldR.status === 400, String(oldR.status));

  // 4. house empty: match-only with no counterparty expires
  const e = await placeIntent(K.bob, 0);
  const eo = await waitStatus(e.r.body.id, ["EXPIRED", "OPENED", "REJECTED"], 10_000);
  check("unmatched match-only request expires (not a position)", eo.status === "EXPIRED", eo.status);

  // 5. fund the house: it now takes the other side instantly; then the keeper liquidates on a price shock
  await send(K.admin, dime, "fundReserve", [10_000_000n]);
  await sleep(1500); // API chain-state refresh
  const h = await placeIntent(K.alice, 0);
  const ho = await waitStatus(h.r.body.id, ["OPENED", "REJECTED", "CAPACITY_UNAVAILABLE", "EXPIRED"], 15_000);
  check("house filled instantly", ho.status === "OPENED" && ho.route === "HOUSE", `${ho.status} ${ho.reason ?? ""}`);
  const housePos = await pub.readContract({ ...dime, functionName: "positionOf", args: [alice] });
  check("house position exists on-chain before shock", housePos.collateral === 100_000n && housePos.route === 1);
  await fetch(`${PRICING}/mock/shock?bps=-30`, { method: "POST" });
  let liquidated = housePos.collateral === 0n ? null : false;
  for (let i = 0; i < 40 && liquidated === false; i++) {
    await sleep(300);
    liquidated = (await pub.readContract({ ...dime, functionName: "positionOf", args: [alice] })).collateral === 0n;
  }
  check("keeper liquidated after −0.3% shock", liquidated === true);
  const rights = await pub.readContract({ ...dime, functionName: "rightsOf", args: [alice] });
  check("house loss issued pending DIME (1 for $0.10)", rights.pending === DIME_PER_LOSS_OF_10C, rights.pending.toString());
  await fetch(`${PRICING}/mock/shock?bps=30`, { method: "POST" });

  // 6. stale reference → quotes refused
  const met = await (await fetch(`${API}/v1/metrics`)).json() as any;

  // 7. epoch funding by keeper (time travel last: chain clock moves ahead of price proofs)
  const epochBefore = await pub.readContract({ ...dime, functionName: "epoch" });
  await testClient.increaseTime({ seconds: 125 });
  await testClient.mine({ blocks: 1 });
  let epochAfter = epochBefore;
  for (let i = 0; i < 30 && epochAfter === epochBefore; i++) { await sleep(300); epochAfter = await pub.readContract({ ...dime, functionName: "epoch" }); }
  check("keeper funded + advanced epoch", epochAfter === epochBefore + 1n, `${epochBefore} → ${epochAfter}`);
  const rights2 = await pub.readContract({ ...dime, functionName: "rightsOf", args: [alice] });
  check("DIME stake activated next epoch", rights2.active === DIME_PER_LOSS_OF_10C && rights2.pending === 0n);

  // invariant
  const hs = await pub.readContract({ ...dime, functionName: "houseStats" });
  const bal = await pub.readContract({ ...usdc, functionName: "balanceOf", args: [dime.address] });
  const tf = await pub.readContract({ ...dime, functionName: "totalFree" });
  const tl = await pub.readContract({ ...dime, functionName: "totalLocked" });
  check("on-chain conservation invariant", bal === tf + tl + hs.reserve + hs.fundedUnclaimed, `${bal} vs ${tf + tl + hs.reserve + hs.fundedUnclaimed}`);

  console.log("\nMEASURED (local anvil + mock feed — not Monad performance):");
  console.log(JSON.stringify({ quote: met.quoteServerMs, admit: met.intentAdmissionMs, matchWait: met.matchWaitMs, admitToOpened: met.admitToOpenedMs, sendToInclusion: met.relayerSendToInclusionMs, outcomes: met.outcomes }, null, 1));
}

main()
  .catch((e) => { check("e2e run", false, e.message); })
  .finally(async () => {
    for (const p of procs) p.kill("SIGTERM");
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
