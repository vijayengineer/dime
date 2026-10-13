/**
 * All user-visible naming lives here so the product can be renamed without touching
 * domain logic, adapters or contracts. "DIME" is the provisional name (chosen 2026-10-12; previously FLIP, CHALK) — see
 * docs/NAMING.md. Domain, handle and trademark availability are UNCHECKED.
 */
export const brand = {
  name: "DIME",
  /** Formal expansion for docs/footer; the playful one is for marketing only. */
  expansion: "Degen Intelligence Monad Exchange",
  tagline: "Trade BTC, dime-sized. Built on Monad.",
  /** Non-transferable earnings rights issued on eligible house-trade losses. */
  rightsName: "DIME rights",
  rightsUnit: "rights",
  houseName: "The House",
  tabs: { play: "Trade", house: "The House", truth: "Truth" },
  orgLine: "by RNDM",
  chainLine: "Built on Monad",
} as const;

export type Brand = typeof brand;
