"use client";

import { useState } from "react";
import { brand } from "@/config/brand";
import { pct, usd } from "@/components/format";
import { ExposureBars, FundsChart, PnlChart } from "@/components/house/HouseCharts";
import { RewardCurve } from "@/components/house/RewardCurve";
import { DimeStack } from "@/components/house/DimeStack";
import { FeedGate, Prov, Stat } from "@/components/ui";
import { fmtAmount, parseUnits } from "@/domain/fixed";
import type { RightsSnapshot } from "@/domain/types";
import { useApp } from "@/state/app";
import { feedValue, useServices } from "@/state/services";

const dime = (v: bigint, dp = 4) => fmtAmount(v, 18, dp);
const plain = (v: bigint) => fmtAmount(v, 18, 18).replace(/,/g, "").replace(/\.?0+$/, "") || "0";

export default function HousePage() {
  const s = useServices();
  const app = useApp();
  const params = feedValue(app.params);
  const house = feedValue(app.house);
  const demo = s.mode === "demo";

  return (
    <div className="stack">
      <header className="house-head">
        <div>
          <h1 className="display" style={{ fontSize: 40, margin: "4px 0 0" }}>{brand.houseName}</h1>
          <p className="dim" style={{ margin: "4px 0 0", maxWidth: 640 }}>
            Losing house trades fund the reserve and issue DIME. Staked DIME earns a share of new house earnings in USDC.
          </p>
        </div>
        {house && <span className={`tag ${house.state === "OPEN" ? "ok" : house.state === "INSOLVENT" ? "bad" : "warn"}`}>{house.state.replace("_", " ")} · epoch {house.epoch}</span>}
      </header>

      <StakeBand />

      <div>
        <FeedGate feed={app.house} label="House state">
          {(h) => (
            <section className="card house-main" aria-labelledby="reserve-title">
              <div className="card-title"><h2 id="reserve-title">House on Monad</h2><Prov p={h.provenance} demo={demo} /></div>
              <div className="house-charts">
                <div className="hc-main">
                  <FundsChart points={app.houseSeries} />
                  <p className="note" style={{ margin: "6px 0 0" }}>Since this page opened · sampled each second from {demo ? "the demo engine" : "contract state"}.</p>
                </div>
                <dl className="kv house-kv">
                  <dt>House funds</dt><dd className="big">{usd(h.reserve)}</dd>
                  <dt>Open house P&amp;L <Prov p="ESTIMATE" /></dt><dd className={h.unrealisedOwed > 0n ? "down" : ""}>{h.unrealisedOwed > 0n ? `−${usd(h.unrealisedOwed)}` : usd(0n)}</dd>
                  <dt>Reserved for open trades</dt><dd>{usd(h.reservedLiabilities)}</dd>
                  <dt>Free to back new trades</dt><dd>{usd(h.availableCapacity)}</dd>
                  <dt>Matched collateral <span className="note">(not house money)</span></dt><dd>{usd(h.matchedCollateralLocked)}</dd>
                  <dt>Unfunded liabilities</dt><dd className={h.unfundedLiabilities > 0n ? "down" : ""}>{usd(h.unfundedLiabilities)}</dd>
                  <dt>Collected from losses</dt><dd>{usd(h.collectedLosses)}</dd>
                  <dt>Paid to winners (after fee)</dt><dd>−{usd(h.netWinningPayouts)}</dd>
                  <dt>Matched fees</dt><dd>{usd(h.matchedFees)}</dd>
                </dl>
              </div>
              <div className="house-charts-2">
                <PnlChart points={app.houseSeries} />
                <ExposureBars h={h} />
              </div>
            </section>
          )}
        </FeedGate>
      </div>

      <div className="house-grid-3">
        <DimeStats />
        <section className="card" aria-labelledby="curve-title">
          <div className="card-title"><h2 id="curve-title">Reward curve</h2></div>
          {params && house ? (
            <RewardCurve baseE18={params.dimePerUsdE18} decayTvl={params.emissionDecayTvl} reserve={house.reserve} />
          ) : <div className="empty">Loading…</div>}
          <p className="note" style={{ marginBottom: 0 }}>
            {params ? `${dime(params.dimePerUsdE18, 2)} DIME per $1 lost until the house holds ${usd(params.emissionDecayTvl, 0)}; then it halves every time the house doubles. Capped at ${dime(params.maxMintPerEpoch, 0)} DIME per epoch.` : ""}
          </p>
        </section>
        <Distribution />
      </div>

      <details className="explain">
        <summary>What DIME is — and isn&apos;t</summary>
        <ul>
          <li>Auto-staked when issued; stake earns from the epoch after it&apos;s added. Unstaked DIME earns nothing.</li>
          <li>Staked DIME shares up to {pct(params?.distributionShareBps ?? 2000, 0)} of new house earnings each epoch, paid in USDC — only after earlier house losses are recovered and the reserve floor is kept. Many epochs may pay nothing.</li>
          <li>Not a refund, not a claim on house funds, no guaranteed yield. New issuance dilutes everyone.</li>
          <li>{feedValue(app.rights)?.transfersEnabled ? "Transferable." : "Currently non-transferable: it can only be staked, unstaked and held."}</li>
        </ul>
      </details>
    </div>
  );
}

function StakeBand() {
  const s = useServices();
  const app = useApp();
  const params = feedValue(app.params);
  const signedIn = !!feedValue(app.account);
  const r = signedIn ? feedValue(app.rights) : undefined;
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const minStake = params?.minStake ?? 10n ** 17n;

  async function act(kind: "claim" | "stake" | "unstake") {
    setErr(null); setBusy(kind);
    try {
      if (kind === "claim") await s.rights.claim();
      else {
        const v = parseUnits(amt || "0", 18);
        await (kind === "stake" ? s.rights.stake(v) : s.rights.unstake(v));
        setAmt("");
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  const active = r?.active ?? 0n, pending = r?.pending ?? 0n, wallet = r?.wallet ?? 0n;
  const staked = active + pending;
  // Your share of this epoch's pool if it closed now (active stake only).
  const nextDrop = r ? (r.estimatedPool * BigInt(r.participationBps)) / 10_000n : 0n;
  const transferNote = r?.transfersEnabled ? "Transferable"
    : r?.transfersAt ? `Non-transferable until ${new Date(r.transfersAt).toLocaleDateString()}`
    : "Non-transferable — stake, unstake or hold";

  return (
    <section className="card stake-band" aria-labelledby="stake-title">
      <div className="stake-grid">
        <div className="stack-col">
          <DimeStack active={active} pending={pending} minStake={minStake} />
          <div className="stack-caption">
            <div className="num" style={{ fontSize: 20 }}>{dime(staked)} <span className="muted" style={{ fontSize: 13 }}>DIME staked</span></div>
            <div className="note">{r ? `${pct(r.participationBps)} of all stake · ${dime(pending)} activating` : "Your stack grows as you stake"}</div>
          </div>
        </div>

        <div className="earn-col">
          <h2 id="stake-title" className="display" style={{ fontSize: 26, margin: 0 }}>Stake DIME, earn USDC</h2>
          <div className="earn-row">
            <div>
              <div className="muted" style={{ fontSize: 12.5 }}>Claimable</div>
              <div className="hero-num">{usd(r?.claimable ?? 0n, 4)}</div>
              <div className="note">USDC · collected so far {usd(r?.claimed ?? 0n, 4)}</div>
            </div>
            <div className="next-drop">
              <div className="muted" style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>Your next drop <Prov p="ESTIMATE" /></div>
              <div className="num" style={{ fontSize: 22 }}>{usd(nextDrop, 4)}</div>
              <div className="note">if epoch {feedValue(app.house)?.epoch ?? "—"} closed now</div>
            </div>
          </div>
          {signedIn ? (
            <button className="btn primary" disabled={!!busy || !r || r.claimable === 0n} onClick={() => act("claim")}>
              {busy === "claim" ? "Claiming…" : r && r.claimable > 0n ? `Claim ${usd(r.claimable, 4)}` : "Nothing to claim yet"}
            </button>
          ) : (
            <button className="btn primary" onClick={() => s.wallet.login()}>Sign in to stake</button>
          )}
        </div>

        <div className="act-col">
          <div className="stat-row">
            <Stat label="Earning" value={dime(active)} />
            <Stat label="In wallet" value={dime(wallet)} />
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="dime-amt">
              <span>Amount</span>
              <span className="max-links">
                <button type="button" className="link-btn" onClick={() => setAmt(plain(wallet))} disabled={wallet === 0n}>max wallet</button>
                <span className="muted"> · </span>
                <button type="button" className="link-btn" onClick={() => setAmt(plain(staked))} disabled={staked === 0n}>max staked</button>
              </span>
            </label>
            <input id="dime-amt" className="input" inputMode="decimal" placeholder="0.0000 DIME" value={amt} onChange={(e) => setAmt(e.target.value)} disabled={!signedIn} />
            <div className="sides">
              <button className="btn" disabled={!signedIn || !!busy || !amt || wallet === 0n} onClick={() => act("stake")}>{busy === "stake" ? "Staking…" : "Stake"}</button>
              <button className="btn ghost" disabled={!signedIn || !!busy || !amt || staked === 0n} onClick={() => act("unstake")}>{busy === "unstake" ? "Unstaking…" : "Unstake"}</button>
            </div>
          </div>
          <p className="note" style={{ margin: "8px 0 0" }}>
            Minimum stake {dime(minStake, 2)} DIME. New stake earns from next epoch. {transferNote}.
          </p>
          {err && <p className="err-box" role="alert">{err}</p>}
        </div>
      </div>
    </section>
  );
}

function DimeStats() {
  const app = useApp();
  const params = feedValue(app.params);
  return (
    <section className="card" aria-labelledby="dime-stats">
      <div className="card-title"><h2 id="dime-stats">DIME</h2><span className="tag">reward: USDC</span></div>
      <FeedGate feed={app.rights} label="DIME stats">
        {(r: RightsSnapshot) => {
          const ratio = r.totalSupply > 0n ? Number((r.totalActive * 10_000n) / r.totalSupply) : 0;
          return (
            <dl className="kv">
              <dt>Total supply</dt><dd>{dime(r.totalSupply, 2)}</dd>
              <dt>Staked</dt><dd>{dime(r.totalActive, 2)}</dd>
              <dt>Stake ratio</dt><dd>{pct(ratio, 1)}</dd>
              <dt>Activating next epoch</dt><dd>{dime(r.totalPendingNextEpoch, 2)}</dd>
              <dt>Issuing now</dt><dd>{dime(r.emissionRateE18, 3)} / $1 lost</dd>
              <dt>Stakers&apos; share of new earnings</dt><dd>up to {pct(params?.distributionShareBps ?? 2000, 0)}</dd>
            </dl>
          );
        }}
      </FeedGate>
    </section>
  );
}

function Distribution() {
  const s = useServices();
  const app = useApp();
  const house = feedValue(app.house);
  const r = feedValue(app.rights);
  return (
    <section className="card" aria-labelledby="dist-title">
      <div className="card-title"><h2 id="dist-title">Distribution</h2>{house && <span className="tag">epoch {house.epoch}</span>}</div>
      <dl className="kv">
        <dt>If the epoch closed now <Prov p="ESTIMATE" /></dt><dd>{r ? usd(r.estimatedPool, 4) : "—"}</dd>
        <dt>Distributed so far</dt><dd>{house ? usd(house.distributionsFunded, 4) : "—"}</dd>
        <dt>Claimed so far</dt><dd>{house ? usd(house.distributionsClaimed, 4) : "—"}</dd>
        <dt>Waiting to be claimed</dt><dd>{house ? usd(house.fundedUnclaimed, 4) : "—"}</dd>
      </dl>
      <p className="note">The keeper closes each epoch on-chain: it funds stakers from new house earnings, then activates new stake.</p>
      {s.mode === "demo" && (
        <div className="chips" style={{ marginTop: 6 }}>
          <DemoLossButton />
          <button className="btn ghost small" onClick={() => s.demo?.fixtureHouseResult(-500_000n)}>Demo: a fixture wallet loses $0.50</button>
          <button className="btn ghost small" onClick={() => s.demo?.advanceEpoch()}>Demo: close epoch</button>
        </div>
      )}
    </section>
  );
}

function DemoLossButton() {
  const s = useServices();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button className="btn ghost small" onClick={() => { try { setErr(null); s.demo?.demoUserHouseLoss(1_000_000n); } catch (e) { setErr((e as Error).message); } }}>
        Demo: I lose $1 to the house
      </button>
      {err && <span className="note down">{err}</span>}
    </>
  );
}
