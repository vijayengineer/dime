import type { Metadata } from "next";
import Link from "next/link";
import { MAINNET } from "@/config/mainnet";

export const metadata: Metadata = { title: "Docs — DIME" };

const SECTIONS = [
  { id: "start", title: "Getting started" },
  { id: "trade", title: "How a trade works" },
  { id: "dime", title: "DIME and staking" },
  { id: "prices", title: "Prices" },
  { id: "limits", title: "Live-test limits" },
  { id: "contracts", title: "Contracts" },
];

const addr = (a: string) => <a className="addr" href={`${MAINNET.explorer}/address/${a}`} target="_blank" rel="noreferrer">{a} ↗</a>;

export default function DocsPage() {
  return (
    <article className="stack docs">
      <header>
        <h1 className="display" style={{ fontSize: 40, margin: "4px 0 0" }}>10¢ docs</h1>
        <p className="dim" style={{ marginTop: 4 }}>
          DIME lets you go long or short on BTC with dime-sized tickets, settled in USDC on Monad. A hackathon project
          trading real money: read the <Link href="/terms">Terms of Use</Link> first.
        </p>
        <nav className="toc" aria-label="Sections">
          {SECTIONS.map((s) => <a key={s.id} className="chip" href={`#${s.id}`}>{s.title}</a>)}
        </nav>
      </header>

      <section className="card" id="start">
        <h2>Getting started</h2>
        <ol>
          <li>Sign in with email, Google or your own wallet.</li>
          <li>Join the live test: enter your invite code, tick the two boxes and sign the terms (free, no transaction).</li>
          <li>Deposit USDC on Monad (up to $1 per wallet during the test). New wallets get a small MON top-up for gas.</li>
          <li>Pick long or short, a margin and a leverage, review, and sign. Close any time.</li>
        </ol>
      </section>

      <section className="card" id="trade">
        <h2>How a trade works</h2>
        <ul>
          <li><strong>Margin</strong> is what you put in, and the most you can lose. <strong>Leverage</strong> multiplies it into your position size.</li>
          <li><strong>The house</strong> takes the other side instantly whenever it has room. If it is full, DIME looks for another trader for a few seconds; if none, nothing opens and your margin stays free.</li>
          <li><strong>Liquidation</strong>: if the price moves against you by about (90% ÷ leverage), the position closes and the margin is lost. At 1000× that is about 0.09%.</li>
          <li><strong>Fee</strong>: 25% of positive profit on a winning trade. Losing or flat trades pay no fee. Trade gas is paid by DIME.</li>
          <li>Your free balance can always be withdrawn back to your wallet.</li>
        </ul>
      </section>

      <section className="card" id="dime">
        <h2>DIME and staking</h2>
        <ul>
          <li>Losing trades against the house issue <strong>DIME</strong>, an on-chain token (<code>{MAINNET.dimeToken.slice(0, 6)}…{MAINNET.dimeToken.slice(-4)}</code>).</li>
          <li>Issued DIME is staked for you automatically and held by the protocol contract, so it does not show in your wallet. See it on <Link href="/house">The House</Link>.</li>
          <li>Stake starts earning at the next epoch (epochs are one day). Staked DIME shares part of new house earnings, paid in USDC, once earlier house losses are recovered. Some epochs pay nothing.</li>
          <li>DIME is non-transferable for now. It is not a refund and has no guaranteed value.</li>
        </ul>
      </section>

      <section className="card" id="prices">
        <h2>Prices</h2>
        <ul>
          <li>The BTC price combines six exchanges (Hyperliquid, Binance, Coinbase, OKX, Bybit, Kraken): a liquidity-weighted median, capped at 40% per venue, ignoring stale or outlying quotes.</li>
          <li>If too few venues are fresh, it falls back to Hyperliquid alone and is labelled <em>Degraded</em>.</li>
          <li>Each reference price is signed by DIME&apos;s pricing service and checked by the verifier contract on Monad when a trade opens or closes. Every signed price and its inputs are published for audit.</li>
          <li>Watch it live on <Link href="/truth">Truth</Link>.</li>
        </ul>
      </section>

      <section className="card" id="limits">
        <h2>Live-test limits</h2>
        <ul>
          <li>Invite-only, up to 20 wallets.</li>
          <li>Deposits up to $1 per wallet. Margin $0.10–$0.50. Leverage up to 1000×.</li>
          <li>The house reserve is small, so house trades are limited to a few at a time.</li>
        </ul>
      </section>

      <section className="card" id="contracts">
        <h2>Contracts (Monad mainnet)</h2>
        <dl className="kv">
          <dt>DIME protocol</dt><dd>{addr(MAINNET.protocol)}</dd>
          <dt>DIME token</dt><dd>{addr(MAINNET.dimeToken)}</dd>
          <dt>Price verifier</dt><dd>{addr(MAINNET.verifier)}</dd>
          <dt>USDC</dt><dd>{addr(MAINNET.usdc)}</dd>
        </dl>
        <p className="note">All contracts are verified on MonadVision (Sourcify).</p>
      </section>
    </article>
  );
}
