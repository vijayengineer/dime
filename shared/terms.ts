/**
 * DIME Terms of Use. One source for the /terms page, the message users sign, and the API check.
 * Changing the text means bumping TERMS_VERSION, which asks every wallet to sign again.
 * Not legal advice: have a lawyer review before relying on these terms.
 */
export const TERMS_VERSION = "2026-10-13";

export function termsMessage(address: string, version = TERMS_VERSION): string {
  return [
    `DIME Terms of Use (version ${version})`,
    "",
    "I have read and accept the DIME Terms of Use at https://dime.rndm.io/terms.",
    "I understand that DIME is an experimental hackathon project, that I am trading with real money (USDC on Monad mainnet), and that I can lose everything I deposit.",
    "I confirm that I am not a resident of, located in, or acting for anyone in a restricted jurisdiction listed in the terms.",
    "",
    `Wallet: ${address.toLowerCase()}`,
  ].join("\n");
}

export const RESTRICTED_JURISDICTIONS = [
  "the United States",
  "Ontario (Canada)",
  "Cuba", "Iran", "Myanmar", "North Korea", "Syria",
  "the Crimea, Donetsk and Luhansk regions of Ukraine",
  "any country or region subject to comprehensive UN, US, UK or EU sanctions",
];

export interface TermsSection { title: string; body: string[] }

export const TERMS: TermsSection[] = [
  {
    title: "1. What DIME is",
    body: [
      "DIME (Degen Intelligence Monad Exchange) is an experimental project built by RNDM for a hackathon. It lets you open small, leveraged long or short positions on the price of bitcoin, settled in USDC by smart contracts on Monad mainnet.",
      "It is not a regulated exchange, broker or financial institution, and it has not been externally audited. Features, limits and availability can change or stop at any time without notice.",
    ],
  },
  {
    title: "2. This is real money",
    body: [
      "Deposits, positions and payouts use real USDC on Monad mainnet. Transactions are final once confirmed on-chain and cannot be reversed by us.",
      "Leverage of up to 1000× means a very small price move can liquidate your position and you can lose your entire margin within seconds. Only use money you can afford to lose completely.",
    ],
  },
  {
    title: "3. Eligibility",
    body: [
      "You must be at least 18 years old and legally able to enter into these terms.",
      `You may not use DIME if you are a resident of, located in, or acting for anyone in: ${RESTRICTED_JURISDICTIONS.join("; ")}. You may not use VPNs or other tools to get around this restriction.`,
      "You are responsible for complying with the laws that apply to you, including any tax obligations.",
    ],
  },
  {
    title: "4. How prices and settlement work",
    body: [
      "Trades open and settle against a BTC reference price produced by DIME's own pricing service from several exchanges and signed by DIME's operator key. The smart contract checks that signature, not whether the price is fair.",
      "This means you rely on DIME to publish correct prices. Pricing errors, exchange outages, network congestion or delays can affect entries, exits and liquidations.",
    ],
  },
  {
    title: "5. Counterparties and the house",
    body: [
      "Your position may be matched against another trader or taken by the house reserve. A matched position can be closed early when your counterparty closes or is liquidated.",
      "The house reserve is small and finite. When it is exhausted, house-backed trading pauses, and reserve-protection rules can close positions early.",
    ],
  },
  {
    title: "6. Fees and DIME rewards",
    body: [
      "A fee of 25% of positive realised profit is taken on winning trades. Network fees (gas in MON) apply to deposits and withdrawals.",
      "DIME is a non-transferable reward token issued on eligible house-trade losses. It is not a refund, has no guaranteed value, and staked DIME may earn nothing. Any USDC distribution depends on future house earnings.",
    ],
  },
  {
    title: "7. Your wallet and your responsibility",
    body: [
      "You control your wallet and are responsible for keeping it secure. We cannot recover lost keys or reverse transactions.",
      "Withdrawals of your free balance are always available from the contract, subject to the network working normally.",
    ],
  },
  {
    title: "8. No advice, no warranties",
    body: [
      "Nothing on DIME is financial, investment, legal or tax advice.",
      "DIME is provided “as is” and “as available”, without warranties of any kind. Smart contracts, the pricing service, the indexer and the website may contain bugs or fail.",
    ],
  },
  {
    title: "9. Limitation of liability",
    body: [
      "To the fullest extent allowed by law, RNDM and the DIME contributors are not liable for any loss of funds, profits or data arising from your use of DIME, including losses caused by bugs, price errors, outages, liquidations or third-party services.",
    ],
  },
  {
    title: "10. Changes",
    body: [
      "We may update these terms. When we do, the version changes and you will be asked to accept the new version before trading again.",
    ],
  },
];
