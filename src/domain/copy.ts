import type { CloseReason } from "./types";

export function reasonText(r: CloseReason): string {
  switch (r) {
    case "USER": return "you closed";
    case "COUNTERPARTY": return "counterparty closed";
    case "LIQUIDATION": return "liquidated";
    case "COUNTERPARTY_LIQUIDATED": return "counterparty liquidated";
    case "RESERVE_PROTECTION": return "reserve protection";
    case "EMERGENCY": return "emergency settlement";
  }
}
