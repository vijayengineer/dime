import { keccak256, toHex } from "viem";
import type { Address, OrderIntentMessage } from "./types";

/** Must match contracts/src/interfaces/IChalk.sol. */
export const ORDER_INTENT_TYPES = {
  OrderIntent: [
    { name: "user", type: "address" },
    { name: "market", type: "bytes32" },
    { name: "side", type: "uint8" },
    { name: "collateral", type: "uint128" },
    { name: "leverage", type: "uint16" },
    { name: "routeMask", type: "uint8" },
    { name: "matchDeadline", type: "uint64" },
    { name: "priceLimit", type: "uint128" },
    { name: "configVersion", type: "uint32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const CLOSE_REQUEST_TYPES = {
  CloseRequest: [
    { name: "user", type: "address" },
    { name: "positionId", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const BTC_MARKET_ID = keccak256(toHex("BTC-USD"));

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export const ROUTE_MATCHED = 1;
export const ROUTE_HOUSE = 2;

export function routeMask(r: { matched: boolean; houseFallback: boolean }): number {
  return (r.matched ? ROUTE_MATCHED : 0) | (r.houseFallback ? ROUTE_HOUSE : 0);
}

/** Random 256-bit nonce: unordered nonces avoid races between concurrent tabs/devices. */
export function randomNonce(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return BigInt(toHex(b));
}

export function orderIntentTypedData(domain: Eip712Domain, message: OrderIntentMessage) {
  return { domain, types: ORDER_INTENT_TYPES, primaryType: "OrderIntent" as const, message };
}
