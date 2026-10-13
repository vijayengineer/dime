/** Monad mainnet (143) commissioning deployment. Source of truth: deployments/143.json. Public addresses only. */
export const MAINNET = {
  chainId: 143,
  rpcUrl: "https://rpc.monad.xyz",
  explorer: "https://monadvision.com",
  api: "https://api-dime.rndm.io",
  protocol: "0x2C3De859ccAa0bfcDeFAa21d348b17F2aA2b746E",
  verifier: "0xC9Af6f42c6962CF327Eb0F5893EdC09F7067263c",
  dimeToken: "0xC64efbA1E151a0914509EC76CAe1b5A827Ce50C9",
  usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  deploymentBlock: 113002354n,
} as const;
