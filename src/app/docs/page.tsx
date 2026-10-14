import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { MAINNET } from "@/config/mainnet";

export const metadata: Metadata = {
  title: "How DIME works",
  description: "How DIME works: trading from ten cents at up to 1000×, the verifiable price, the house, DIME and staking, and the risks.",
};

const SECTIONS = [
  { id: "intro", title: "Introduction" },
  { id: "steps", title: "Step by step" },
  { id: "trade", title: "How a trade works" },
  { id: "prices", title: "The price" },
  { id: "dime", title: "DIME and staking" },
  { id: "risks", title: "Risks" },
  { id: "limits", title: "Live-test limits" },
  { id: "contracts", title: "Contracts" },
];

/** Phone screens: public pages from the live site, signed-in states from a paper-mode run (wallet blurred). */
const STEPS: { n: number; title: string; img?: string; alt?: string; text: ReactNode }[] = [
  { n: 1, title: "Open DIME", img: "/docs/01-trade.jpg", alt: "The Trade page with the live BTC price and chart",
    text: <>Go to dime.rndm.io. The live BTC price and chart are there before you sign in.</> },
  { n: 2, title: "Sign in", img: "/docs/02-signin.jpg", alt: "Sign in to DIME: email, Google or a wallet",
    text: <>Tap Sign in and use email, Google or your own wallet. Email and Google create a wallet for you, so no extension or seed phrase is needed.</> },
  { n: 3, title: "Join the live test",
    text: <>Tap Join, enter your invite code, tick the two boxes and sign the Terms. It&apos;s a free signature, not a transaction. New wallets get a little MON for gas.</> },
  { n: 4, title: "Deposit USDC",
    text: <>Tap your balance in the header, enter an amount and Deposit. During the live test each wallet can deposit up to $1 of USDC on Monad.</> },
  { n: 5, title: "Pick your trade", img: "/docs/04-ticket.jpg", alt: "New position: Long, $0.10 margin, 1000× leverage",
    text: <>Long if you think BTC goes up, Short if down. Choose a margin and a leverage. Margins the house can&apos;t take right now are greyed out.</> },
  { n: 6, title: "Review and sign", img: "/docs/05-review.jpg", alt: "Review sheet with liquidation price, fee and max loss",
    text: <>Check the liquidation price, the fee and your max loss, tick the box and sign. One signature; DIME pays the gas.</> },
  { n: 7, title: "Watch it live", img: "/docs/06-open.jpg", alt: "Open position with live profit and loss",
    text: <>The house fills you straight away. Your P&amp;L updates with every verified price, along with your distance to liquidation.</> },
  { n: 8, title: "Close", img: "/docs/07-result.jpg", alt: "Closed with a loss, and the DIME it earned",
    text: <>Close any time at the verified price. Winnings, less the fee, land in your free balance. A loss against the house earns you DIME.</> },
  { n: 9, title: "Check the price", img: "/docs/09-truth.jpg", alt: "Truth page: the price network and verified prices",
    text: <>The Truth tab shows where the price comes from, each signed price accepted by the contract on Monad, live blocks and the Envio indexer.</> },
  { n: 10, title: "Stake DIME", img: "/docs/10-house.jpg", alt: "The House page: stake DIME, earn USDC",
    text: <>The House tab shows your DIME, when it starts earning, and the house&apos;s reserve and results.</> },
];

const RISKS: [string, string, ReactNode][] = [
  ["Leverage", "At 1000×, a move of about 0.09% against you liquidates the position and you lose your whole margin. It can happen within seconds.", "Your margin is your maximum loss on each trade (isolated margin). The liquidation price is shown before you sign."],
  ["The price", "Prices are signed by DIME's own pricing service. A wrong or delayed price could open, close or liquidate at the wrong level.", "Six exchanges, liquidity-weighted, stale and outlying quotes dropped; every signature checked on-chain; every price published with its inputs; new trades pause if the feed degrades. It is not yet an independent oracle."],
  ["Smart contracts", "The contracts are new, unaudited hackathon code. A bug could lose deposited funds.", "Source verified on MonadVision; deposits capped at $1 per wallet during the test."],
  ["The house", "The house reserve is small. It may close a position early if your gain nears what it reserved for you, and it can be full.", "It reserves 20× your margin per trade and only offers sizes it can cover. Its reserve and results are on the House page."],
  ["Operator control", "The admin can change settings and pause trading. DIME's relayer submits trades and the keeper liquidates.", "Each order is signed against a specific settings version. The guardian can only reduce risk; reopening needs the admin."],
  ["Outages", "If DIME's servers or Monad are down, you may be unable to open or close a position in the app.", "Funds stay in the contract, and your free balance can be withdrawn straight from your wallet."],
  ["DIME", "DIME may earn nothing, and new issuance dilutes existing holders. It is not a refund and has no guaranteed value.", "Issuance is capped per epoch; payouts only come from new house earnings after earlier house losses are recovered."],
  ["Stablecoin and network", "USDC could lose its peg; Monad could halt or reorganise.", "Outside DIME's control."],
  ["Your wallet", "Whoever controls your wallet controls your funds.", "Email and Google wallets are run by Privy; external wallets stay under your keys."],
  ["Eligibility", "DIME is not available in some places, including the United States.", <>See the <Link href="/terms">Terms of Use</Link>.</>],
];

const addr = (a: string) => <a className="addr" href={`${MAINNET.explorer}/address/${a}`} target="_blank" rel="noreferrer">{a} ↗</a>;

export default function DocsPage() {
  return (
    <div className="docs-page">
      <section className="docs-hero">
        <h1 className="display">How DIME works</h1>
        <p>
          Trade BTC with up to 1000× leverage from ten cents, on a price you can check. This page covers how to use DIME, how a trade
          works, where the price comes from, DIME and staking, and the risks. DIME is a hackathon project that uses real money: read the{" "}
          <Link href="/terms">Terms of Use</Link> first.
        </p>
        <video src="/media/dime-teaser.mp4" poster="/media/dime-teaser.jpg" controls playsInline preload="none" aria-label="DIME teaser, 20 seconds">
          Your browser can&apos;t play this video.
        </video>
      </section>

      <div className="docs-layout">
        <nav className="docs-toc" aria-label="On this page">
          <span>On this page</span>
          {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
        </nav>

        <article className="docs">
          <section id="intro">
            <h2>Introduction</h2>
            <p className="lead">DIME lets you go long or short on Bitcoin with up to 1000× leverage from a $0.10 margin, settled in USDC on Monad.</p>
            <p><strong>In 30 seconds</strong></p>
            <ul>
              <li><strong>Pick a side.</strong> Long if you think BTC goes up, Short if you think it goes down.</li>
              <li><strong>Pick a size.</strong> A margin from $0.10 and a leverage up to 1000×. Your margin is the most you can lose.</li>
              <li><strong>Sign once.</strong> The house takes the other side instantly. DIME pays the gas.</li>
              <li><strong>Close any time</strong> at the verified price. If you lose against the house, you earn DIME.</li>
            </ul>
            <p>
              <strong>An example.</strong> A $0.10 long at 1000× controls $100 of BTC. If BTC rises 0.05%, that&apos;s $0.05 gross, about $0.038
              after the 25% fee on profit. If BTC falls about 0.09%, the position is liquidated and you lose the $0.10.
            </p>
            <p>
              <strong>Why the price matters.</strong> At 1000×, a 0.1% move is the whole trade, so DIME builds its price from six exchanges, signs it,
              and has a contract on Monad check it on every open and close. Anyone can recompute it from the public log.
            </p>
            <p><strong>What&apos;s next.</strong> Bitcoin is the first market. ETH and other majors come next, then tokenised stocks.</p>
          </section>

          <section id="steps">
            <h2>Using DIME, step by step</h2>
            <p>From first visit to your first trade takes a couple of minutes. These are phone screens; the desktop layout has the same steps.</p>
            <div className="flow">
              {STEPS.map((s) => (
                <figure key={s.n} className={s.img ? undefined : "text-only"}>
                  {s.img && <img src={s.img} alt={s.alt ?? ""} width={390} height={844} loading="lazy" />}
                  <figcaption><b>{s.n}. {s.title}</b>{s.text}</figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section id="trade">
            <h2>How a trade works</h2>
            <ul>
              <li><strong>Margin</strong> is what you put in and the most you can lose. <strong>Leverage</strong> multiplies it into your position size: $0.10 at 1000× is $100 of BTC.</li>
              <li><strong>Liquidation.</strong> If the price moves against you by about 90% ÷ leverage (about 0.09% at 1000×), the position closes and the margin goes to the house.</li>
              <li><strong>The house</strong> takes the other side of every trade, instantly. For each trade it sets aside 20× your margin to cover your winnings, so the largest margin on offer depends on how much of its reserve is free.</li>
              <li><strong>Fee.</strong> 25% of the profit on a winning trade. Losing or flat trades pay no fee, and DIME pays the gas for opening and closing.</li>
              <li><strong>Price tolerance.</strong> Set for you and shown before you sign. If the price moves past it before your trade lands, nothing opens and your margin stays free.</li>
              <li>Your free balance can always be withdrawn back to your wallet.</li>
            </ul>
          </section>

          <section id="prices">
            <h2>The price</h2>
            <ul>
              <li>DIME reads live order books from six exchanges: Binance, OKX, Bybit, Hyperliquid, Coinbase and Kraken.</li>
              <li>It takes a liquidity-weighted median, capped at 40% per venue, adjusts USDT quotes for their basis, and ignores stale or outlying quotes. If too few venues are fresh, the price is marked degraded and new trades pause.</li>
              <li>The price is signed every 250 ms. The verifier contract on Monad checks that signature whenever a trade opens or closes.</li>
              <li>Every signed price is published with all of its inputs at <a href="https://api-dime.rndm.io/feed/audit" target="_blank" rel="noreferrer">api-dime.rndm.io/feed/audit</a>, so anyone can recompute it. Watch it live on <Link href="/truth">Truth</Link>.</li>
            </ul>
          </section>

          <section id="dime">
            <h2>DIME and staking</h2>
            <ul>
              <li>A trade that loses against the house earns <strong>DIME</strong>, an on-chain token, on net losses only. While the house is small, each $1 lost earns 1,000 DIME, and issuance is capped each daily epoch.</li>
              <li>Earned DIME is staked for you and held by the protocol contract, so it doesn&apos;t show in your wallet. See it on <Link href="/house">The House</Link>.</li>
              <li>Staked DIME starts earning at the next epoch. It shares part of new house earnings, paid in USDC, once earlier house losses are recovered. Some epochs pay nothing.</li>
              <li>DIME can&apos;t be transferred until a publicly scheduled date. It is not a refund and has no guaranteed value.</li>
            </ul>
          </section>

          <section id="risks">
            <h2>Risks</h2>
            <p>DIME is experimental software that uses real money. You can lose your margin on every trade, and everything you deposit.</p>
            <div className="tbl">
              <table>
                <thead><tr><th>Risk</th><th>What can happen</th><th>What limits it</th></tr></thead>
                <tbody>
                  {RISKS.map(([risk, what, limit]) => <tr key={risk}><td>{risk}</td><td>{what}</td><td>{limit}</td></tr>)}
                </tbody>
              </table>
            </div>
          </section>

          <section id="limits">
            <h2>Live-test limits</h2>
            <ul>
              <li>Invite-only, up to 20 wallets.</li>
              <li>Deposits up to $1 per wallet. Margin $0.10–$0.50. Leverage up to 1000×.</li>
              <li>The house reserve is small: it takes up to three trades at a time, and the largest margin depends on its free reserve.</li>
            </ul>
          </section>

          <section id="contracts">
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
      </div>
    </div>
  );
}
