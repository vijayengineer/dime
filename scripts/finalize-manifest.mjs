// Fills deployments/<chainId>.json with on-chain evidence from Foundry's broadcast receipts
// (the manifest written during `forge script` comes from the simulation pass).
// Usage: node scripts/finalize-manifest.mjs <chainId>
import fs from "node:fs";

const chainId = process.argv[2];
if (!chainId) throw new Error("usage: finalize-manifest.mjs <chainId>");
const manifestPath = `deployments/${chainId}.json`;
const runPath = `broadcast/Deploy.s.sol/${chainId}/run-latest.json`;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const run = JSON.parse(fs.readFileSync(runPath, "utf8"));

const receipts = run.receipts ?? [];
if (!receipts.length) throw new Error("no receipts in broadcast file — was the script run with --broadcast?");
const failed = receipts.filter((r) => r.status !== "0x1");
if (failed.length) throw new Error(`failed deploy transactions: ${failed.map((r) => r.transactionHash).join(", ")}`);

const blocks = receipts.map((r) => Number(BigInt(r.blockNumber)));
const deployTxs = {};
for (const tx of run.transactions) {
  if (tx.transactionType === "CREATE" && tx.contractName) deployTxs[tx.contractName] = { address: tx.contractAddress, txHash: tx.hash };
}
for (const [name, info] of Object.entries(deployTxs)) {
  const want = name === "DimeProtocol" ? manifest.protocol : name === "OperatorPriceVerifier" ? manifest.verifier : name === "TestUSDC" ? manifest.collateral : null;
  if (want && want.toLowerCase() !== info.address.toLowerCase()) throw new Error(`${name} address mismatch: manifest ${want} vs broadcast ${info.address}`);
}
manifest.deploymentBlock = Math.min(...blocks);
manifest.deployTxs = deployTxs;
manifest.libraries = Object.fromEntries(
  run.transactions.filter((t) => /^CREATE2?$/.test(t.transactionType) && /^Dime(Math|Rights)$/.test(t.contractName ?? "")).map((t) => [t.contractName, t.contractAddress]),
);
manifest.finalizedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`finalized ${manifestPath}: deploymentBlock=${manifest.deploymentBlock}, ${Object.keys(deployTxs).length} contracts`);
