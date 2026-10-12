import { parseAbi } from "viem";

/** Generated from the compiled contracts (scripts/export-abis.mjs). */
export { dimeAbi as chalkAbi, dimeTokenAbi } from "@shared/abi";

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
