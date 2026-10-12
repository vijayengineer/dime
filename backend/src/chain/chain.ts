import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, encodeAbiParameters,
  http, keccak256, toHex, verifyTypedData, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dimeAbi } from "../../../shared/abi";
import type { Config } from "../config";

export const BTC_MARKET = keccak256(toHex("BTC-USD"));

export const ORDER_TYPES = {
  OrderIntent: [
    { name: "user", type: "address" }, { name: "market", type: "bytes32" }, { name: "side", type: "uint8" },
    { name: "collateral", type: "uint128" }, { name: "leverage", type: "uint16" }, { name: "routeMask", type: "uint8" },
    { name: "matchDeadline", type: "uint64" }, { name: "priceLimit", type: "uint128" }, { name: "configVersion", type: "uint32" },
    { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" },
  ],
} as const;
export const CLOSE_TYPES = {
  CloseRequest: [
    { name: "user", type: "address" }, { name: "positionId", type: "bytes32" }, { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" },
  ],
} as const;

export interface OrderIntent {
  user: Address; market: Hex; side: number; collateral: bigint; leverage: number; routeMask: number;
  matchDeadline: bigint; priceLimit: bigint; configVersion: number; expiry: bigint; nonce: bigint;
}
export interface CloseRequest { user: Address; positionId: Hex; expiry: bigint; nonce: bigint }

export function makeChain(cfg: Config) {
  const chain = defineChain({
    id: cfg.CHAIN_ID,
    name: cfg.CHAIN_ID === 143 ? "Monad" : cfg.CHAIN_ID === 10143 ? "Monad Testnet" : `chain-${cfg.CHAIN_ID}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.RPC_URL] } },
  });
  const pub = createPublicClient({ chain, transport: http(cfg.RPC_URL, { batch: true }) }) as PublicClient;
  const protocol = { address: cfg.manifest.protocol, abi: dimeAbi } as const;
  const domain = { name: cfg.manifest.eip712Name, version: cfg.manifest.eip712Version, chainId: cfg.CHAIN_ID, verifyingContract: cfg.manifest.protocol };
  const wallet = (key: Hex) => {
    const account = privateKeyToAccount(key);
    return { account, client: createWalletClient({ account, chain, transport: http(cfg.RPC_URL) }) };
  };
  return { chain, pub, protocol, domain, wallet };
}
export type Chain = ReturnType<typeof makeChain>;

export async function verifyOrder(c: Chain, msg: OrderIntent, signature: Hex) {
  return verifyTypedData({ address: msg.user, domain: c.domain, types: ORDER_TYPES, primaryType: "OrderIntent", message: msg, signature });
}
export async function verifyClose(c: Chain, msg: CloseRequest, signature: Hex) {
  return verifyTypedData({ address: msg.user, domain: c.domain, types: CLOSE_TYPES, primaryType: "CloseRequest", message: msg, signature });
}

/** Must match DimeProtocol._store: keccak256(abi.encode(chainid, address(this), user, nonce)). */
export function positionIdFor(chainId: number, protocol: Address, user: Address, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    [BigInt(chainId), protocol, user, nonce],
  ));
}

/** Extracts the custom error name from a viem contract error (e.g. "CapacityUnavailable"). */
export function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "Reverted";
  }
  return null;
}

export const PROTOCOL_STATES = ["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN", "INSOLVENT"] as const;

/** JSON helpers: bigint ⇄ decimal strings on the wire. */
export const toWire = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export function parseOrder(m: Record<string, unknown>): OrderIntent {
  return {
    user: String(m.user) as Address, market: String(m.market) as Hex, side: Number(m.side), collateral: BigInt(m.collateral as string),
    leverage: Number(m.leverage), routeMask: Number(m.routeMask), matchDeadline: BigInt(m.matchDeadline as string),
    priceLimit: BigInt(m.priceLimit as string), configVersion: Number(m.configVersion), expiry: BigInt(m.expiry as string), nonce: BigInt(m.nonce as string),
  };
}
