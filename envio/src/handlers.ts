import { indexer } from "envio";

/**
 * DIME event handlers. Envio mirrors contract events into queryable entities for history and
 * dashboards. The contract remains authoritative for balances; these totals are derived from
 * events (matched-pair rounding dust is not separately evented and is therefore not included).
 */
const ROUTES = ["MATCHED", "HOUSE"] as const;
const SIDES = ["LONG", "SHORT"] as const;
const REASONS = ["USER", "COUNTERPARTY", "LIQUIDATION", "COUNTERPARTY_LIQUIDATED", "RESERVE_PROTECTION", "EMERGENCY"] as const;
const STATES = ["OPEN", "CLOSE_ONLY", "ORACLE_HOLD", "WIND_DOWN", "INSOLVENT"] as const;
const LIMITS = ["NONE", "NO_ACTIVE_RIGHTS", "NO_NEW_EARNINGS", "RESERVE_FLOOR"] as const;

type Ev = { transaction: { hash: string }; logIndex: number; block: { number: number; timestamp: number } };
const base = (e: Ev, suffix = "") => ({
  id: `${e.transaction.hash}-${e.logIndex}${suffix}`,
  txHash: e.transaction.hash,
  blockNumber: BigInt(e.block.number),
  timestamp: BigInt(e.block.timestamp),
});

async function totals(context: any) {
  return (await context.HouseTotals.get("global")) ?? {
    id: "global", reserveFunded: 0n, reserveWithdrawn: 0n, collectedLosses: 0n, netWinningPayouts: 0n, matchedFees: 0n,
    distributionsFunded: 0n, distributionsClaimed: 0n, deposits: 0n, withdrawals: 0n, opens: 0, settlements: 0,
    protocolState: "OPEN", epoch: 1n, totalActiveRights: 0n, dimeIssued: 0n,
  };
}
async function rights(context: any, user: string) {
  return (await context.RightsAccount.get(user)) ?? { id: user, issuedTotal: 0n, stakedNet: 0n, claimedTotal: 0n, netLossHighWater: 0n, lastActivationEpoch: 0n };
}
const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

indexer.onEvent({ contract: "DimeProtocol", event: "Deposited" }, async ({ event, context }) => {
  const user = event.params.user.toLowerCase();
  context.Activity.set({ ...base(event), user, kind: "DEPOSIT", title: `Deposited ${usd(event.params.amount)}`, amount: event.params.amount });
  const t = await totals(context);
  context.HouseTotals.set({ ...t, deposits: t.deposits + event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "Withdrawn" }, async ({ event, context }) => {
  const user = event.params.user.toLowerCase();
  context.Activity.set({ ...base(event), user, kind: "WITHDRAW", title: `Withdrew ${usd(event.params.amount)}`, amount: event.params.amount });
  const t = await totals(context);
  context.HouseTotals.set({ ...t, withdrawals: t.withdrawals + event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "IntentCancelled" }, async ({ event, context }) => {
  context.Activity.set({ ...base(event), user: event.params.user.toLowerCase(), kind: "INTENT_CANCELLED", title: "Request nonce cancelled on-chain", amount: undefined });
});

indexer.onEvent({ contract: "DimeProtocol", event: "PositionOpened" }, async ({ event, context }) => {
  const p = event.params;
  const user = p.user.toLowerCase();
  const route = ROUTES[Number(p.route)];
  const side = SIDES[Number(p.side)];
  context.Position.set({
    id: p.id, user, route, side, collateral: p.collateral, leverage: Number(p.leverage), entryPrice: p.entryPrice,
    liquidationPrice: p.liquidationPrice, houseReservation: p.houseReservation, pairId: route === "MATCHED" ? p.pairId : undefined,
    configVersion: Number(p.configVersion), openedAt: BigInt(event.block.timestamp), openTx: event.transaction.hash, status: "OPEN",
    exitPrice: undefined, grossPnl: undefined, fee: undefined, netPnl: undefined, returned: undefined, closeReason: undefined,
    settledAt: undefined, closeTx: undefined,
  });
  context.Activity.set({ ...base(event), user, kind: "POSITION_OPENED", title: `Opened ${side.toLowerCase()} · ${route === "HOUSE" ? "house" : "matched"} · ${p.leverage}×`, amount: p.collateral });
  const t = await totals(context);
  context.HouseTotals.set({ ...t, opens: t.opens + 1 });
});

indexer.onEvent({ contract: "DimeProtocol", event: "PositionSettled" }, async ({ event, context }) => {
  const p = event.params;
  const user = p.user.toLowerCase();
  const route = ROUTES[Number(p.route)];
  const reason = REASONS[Number(p.reason)];
  const pos = await context.Position.get(p.id);
  if (pos) {
    context.Position.set({
      ...pos, status: "SETTLED", exitPrice: p.exitPrice, grossPnl: p.grossPnl, fee: p.fee, netPnl: p.netPnl, returned: p.returned,
      closeReason: reason, settledAt: BigInt(event.block.timestamp), closeTx: event.transaction.hash,
    });
  }
  const verb = p.netPnl > 0n ? "net gain" : p.netPnl < 0n ? "loss" : "flat";
  context.Activity.set({ ...base(event), user, kind: "POSITION_SETTLED", title: `Settled · ${verb} (${reason.toLowerCase().replaceAll("_", " ")})`, amount: p.netPnl });
  const t = await totals(context);
  const next = { ...t, settlements: t.settlements + 1 };
  if (route === "HOUSE") {
    if (p.netPnl < 0n) next.collectedLosses = t.collectedLosses - p.netPnl;
    else next.netWinningPayouts = t.netWinningPayouts + p.netPnl; // fee reduced the payout; not added as revenue
  } else if (p.fee > 0n) {
    next.matchedFees = t.matchedFees + p.fee;
  }
  context.HouseTotals.set(next);
});

indexer.onEvent({ contract: "DimeProtocol", event: "ReserveFunded" }, async ({ event, context }) => {
  const t = await totals(context);
  context.HouseTotals.set({ ...t, reserveFunded: t.reserveFunded + event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "ReserveWithdrawn" }, async ({ event, context }) => {
  const t = await totals(context);
  context.HouseTotals.set({ ...t, reserveWithdrawn: t.reserveWithdrawn + event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "ProtocolStateChanged" }, async ({ event, context }) => {
  const t = await totals(context);
  context.HouseTotals.set({ ...t, protocolState: STATES[Number(event.params.state)] ?? "UNKNOWN" });
});

const dime = (v: bigint) => (Number(v) / 1e18).toFixed(4);

indexer.onEvent({ contract: "DimeProtocol", event: "DimeIssued" }, async ({ event, context }) => {
  const user = event.params.user.toLowerCase();
  const r = await rights(context, user);
  context.RightsAccount.set({ ...r, issuedTotal: r.issuedTotal + event.params.amount, stakedNet: r.stakedNet + event.params.amount, netLossHighWater: event.params.highWater, lastActivationEpoch: event.params.activationEpoch });
  context.Activity.set({ ...base(event, "-r"), user, kind: "RIGHTS_ISSUED", title: `${dime(event.params.amount)} DIME issued, auto-staked (active epoch ${event.params.activationEpoch})`, amount: event.params.amount });
  const t = await totals(context);
  context.HouseTotals.set({ ...t, dimeIssued: t.dimeIssued + event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "Staked" }, async ({ event, context }) => {
  const user = event.params.user.toLowerCase();
  const r = await rights(context, user);
  context.RightsAccount.set({ ...r, stakedNet: r.stakedNet + event.params.amount });
  context.Activity.set({ ...base(event), user, kind: "STAKE", title: `Staked ${dime(event.params.amount)} DIME (active epoch ${event.params.activationEpoch})`, amount: event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "Unstaked" }, async ({ event, context }) => {
  const user = event.params.user.toLowerCase();
  const r = await rights(context, user);
  context.RightsAccount.set({ ...r, stakedNet: r.stakedNet - event.params.amount });
  context.Activity.set({ ...base(event), user, kind: "UNSTAKE", title: `Unstaked ${dime(event.params.amount)} DIME`, amount: event.params.amount });
});

indexer.onEvent({ contract: "DimeProtocol", event: "EpochFunded" }, async ({ event, context }) => {
  const p = event.params;
  context.EpochFunding.set({
    id: p.epoch.toString(), eligibleNewEarnings: p.eligibleNewEarnings, target: p.target, funded: p.funded,
    limitedBy: LIMITS[Number(p.limitedBy)] ?? "UNKNOWN", totalActiveAfter: undefined, timestamp: BigInt(event.block.timestamp),
  });
  const t = await totals(context);
  context.HouseTotals.set({ ...t, distributionsFunded: t.distributionsFunded + p.funded });
});

indexer.onEvent({ contract: "DimeProtocol", event: "EpochAdvanced" }, async ({ event, context }) => {
  const t = await totals(context);
  context.HouseTotals.set({ ...t, epoch: event.params.epoch, totalActiveRights: event.params.totalActive });
  const prev = await context.EpochFunding.get((event.params.epoch - 1n).toString());
  if (prev) context.EpochFunding.set({ ...prev, totalActiveAfter: event.params.totalActive });
});

indexer.onEvent({ contract: "DimeProtocol", event: "Claimed" }, async ({ event, context }) => {
  const user = event.params.user.toLowerCase();
  const r = await rights(context, user);
  context.RightsAccount.set({ ...r, claimedTotal: r.claimedTotal + event.params.amount });
  context.Activity.set({ ...base(event), user, kind: "CLAIM", title: `Claimed ${usd(event.params.amount)} distribution`, amount: event.params.amount });
  const t = await totals(context);
  context.HouseTotals.set({ ...t, distributionsClaimed: t.distributionsClaimed + event.params.amount });
});
