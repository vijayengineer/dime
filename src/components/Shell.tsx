"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { TERMS_VERSION } from "@shared/terms";
import { brand } from "@/config/brand";
import { parseUnits } from "@/domain/fixed";
import { AppStateProvider, useApp } from "@/state/app";
import { feedValue, ServicesProvider, useServices } from "@/state/services";
import { BuiltOnMonad, DimeMark, MonadLockup } from "./BrandMark";
import { shortHash, usd } from "./format";
import { StatusRail } from "./StatusRail";
import { FeedGate, Icon, Prov, Sheet } from "./ui";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <ServicesProvider>
      <AppStateProvider>
        <Header />
        <main className="shell" id="main">
          {children}
        </main>
        <Footer />
        <StatusRail />
        <TabBar />
        <TermsGate />
      </AppStateProvider>
    </ServicesProvider>
  );
}

const NAV = [
  { href: "/", label: brand.tabs.play, icon: Icon.play },
  { href: "/house", label: brand.tabs.house, icon: Icon.house },
  { href: "/truth", label: brand.tabs.truth, icon: Icon.activity },
];

function Header() {
  const path = usePathname();
  const s = useServices();
  return (
    <header className="topbar">
      <a href="#main" className="sr-only">Skip to content</a>
      <Link href="/" className="wordmark" aria-label={`${brand.name} home`}>
        <DimeMark />
        <span>{brand.name}</span>
      </Link>
      <nav className="topnav" aria-label="Main">
        {NAV.map((n) => <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>{n.label}</Link>)}
      </nav>
      <span className="spacer" />
      <span className="hide-sm"><BuiltOnMonad /></span>
      <span className={`tape ${s.mode === "live" ? "live" : ""}`}>{s.mode === "demo" ? `${brand.name}: Paper` : s.chain.name}</span>
      <AccountButton />
    </header>
  );
}

function Footer() {
  const s = useServices();
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div>
          <div className="footer-brand"><DimeMark size={22} /> <strong>{brand.name}</strong> <span className="muted">· {brand.expansion}</span></div>
          <p className="note" style={{ margin: "6px 0 0", maxWidth: 520 }}>
            {s.mode === "demo"
              ? `${brand.name}: Paper. Live BTC prices from Hyperliquid, Binance and other venues.`
              : "DIME is a hackathon project trading real USDC on Monad mainnet. Leveraged trading can lose your full margin in seconds."}
          </p>
        </div>
        <Link className="footer-terms" href="/terms">Terms of Use</Link>
        <a className="footer-monad" href="https://monad.xyz" target="_blank" rel="noreferrer">
          <span className="muted" style={{ fontSize: 12 }}>{brand.chainLine}</span>
          <MonadLockup height={20} />
        </a>
      </div>
    </footer>
  );
}

function TabBar() {
  const path = usePathname();
  return (
    <nav className="tabbar" aria-label="Main">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
          <n.icon />{n.label}
        </Link>
      ))}
    </nav>
  );
}

/** Live mode: a signed-in wallet must sign the current Terms of Use before using the app. The API enforces it for trades. */
function TermsGate() {
  const s = useServices();
  const { account } = useApp();
  const acct = feedValue(account);
  const address = acct?.address;
  const [state, setState] = useState<"checking" | "needed" | "ok">("checking");
  const [ticks, setTicks] = useState({ eligible: false, risk: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (s.mode !== "live" || !address) return;
    let alive = true;
    setState("checking");
    s.terms.accepted(address).then((a) => { if (alive) setState(a ? "ok" : "needed"); }).catch(() => { if (alive) setState("needed"); });
    return () => { alive = false; };
  }, [s, address]);

  if (s.mode !== "live" || !address || state !== "needed") return null;

  async function accept() {
    setErr(null);
    setBusy(true);
    try { await s.terms.accept(address!); setState("ok"); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={() => {}} labelledBy="terms-title">
      <h2 id="terms-title">Before you trade</h2>
      <ul className="terms-points">
        <li><strong>This is real money.</strong> You trade with USDC on Monad mainnet. Transactions are final.</li>
        <li><strong>This is a hackathon project.</strong> Experimental, unaudited software that may have bugs or stop working.</li>
        <li><strong>You can lose everything you deposit.</strong> At up to 1000× leverage, a tiny price move can liquidate you in seconds.</li>
        <li><strong>Prices are signed by DIME.</strong> The contract checks our signature, not whether the price is fair.</li>
      </ul>
      <label className="terms-check">
        <input type="checkbox" checked={ticks.eligible} onChange={(e) => setTicks({ ...ticks, eligible: e.target.checked })} />
        <span>I am 18 or older and not a resident of, or located in, a restricted jurisdiction (including the United States).</span>
      </label>
      <label className="terms-check">
        <input type="checkbox" checked={ticks.risk} onChange={(e) => setTicks({ ...ticks, risk: e.target.checked })} />
        <span>I have read the <Link href="/terms" target="_blank">Terms of Use</Link> and accept that I am using real money in a hackathon project at my own risk.</span>
      </label>
      {err && <p className="err-box" role="alert">{err}</p>}
      <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy || !ticks.eligible || !ticks.risk} onClick={accept}>
        {busy ? "Waiting for your wallet…" : "Accept and sign"}
      </button>
      <p className="note">Signing is free: it does not send a transaction. Version {TERMS_VERSION}.</p>
      <button className="btn ghost small" onClick={() => s.wallet.logout()}>Sign out instead</button>
    </Sheet>
  );
}

function AccountButton() {
  const s = useServices();
  const { account, balances } = useApp();
  const [open, setOpen] = useState(false);
  const acct = feedValue(account);
  const bal = feedValue(balances);
  if (!acct) {
    return <button className="btn primary small" onClick={() => s.wallet.login()} disabled={account.status === "loading"}>Sign in</button>;
  }
  return (
    <>
      <button className="btn small" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="num">{bal ? usd(bal.free) : "…"}</span>
        <span className="muted" aria-hidden>·</span>
        <span className="num">{shortHash(acct.address)}</span>
      </button>
      <AccountSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useServices();
  const { account, balances } = useApp();
  const acct = feedValue(account);
  const [amt, setAmt] = useState("2.00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(kind: "deposit" | "withdraw") {
    setErr(null);
    setBusy(true);
    try {
      const v = parseUnits(amt, 6);
      await (kind === "deposit" ? s.account.deposit(v) : s.account.withdraw(v));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} labelledBy="acct-title">
      <h2 id="acct-title">Your account</h2>
      <p className="note num">{acct?.label} · {acct?.address}</p>
      <FeedGate feed={balances} label="Balances">
        {(b) => {
          const room = b.fundingCap - b.depositedTotal;
          return (
            <>
              <dl className="kv" style={{ marginTop: 12 }}>
                <dt>Free to trade or withdraw <Prov p={b.provenance} demo={s.mode === "demo"} /></dt><dd>{usd(b.free)}</dd>
                <dt>Locked in position</dt><dd>{usd(b.positionCollateral)}</dd>
                <dt>Reserved by pending request</dt><dd>{usd(b.pendingCollateral)}</dd>
                <dt>USDC in wallet (not deposited)</dt><dd>{usd(b.wallet)}</dd>
                <dt>Deposit cap used</dt><dd>{usd(b.depositedTotal)} / {usd(b.fundingCap)}</dd>
              </dl>
              <p className="note">The cap limits external deposits only. Winnings can take your balance above it.</p>
              <div className="field">
                <label htmlFor="amt">Amount (USDC)</label>
                <input id="amt" className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
              </div>
              <div className="sides" style={{ marginTop: 12 }}>
                <button className="btn primary" disabled={busy || room <= 0n} onClick={() => run("deposit")}>Deposit</button>
                <button className="btn" disabled={busy || b.free === 0n} onClick={() => run("withdraw")}>Withdraw</button>
              </div>
              {room <= 0n && <p className="note">You have reached the deposit cap.</p>}
            </>
          );
        }}
      </FeedGate>
      {err && <p className="err-box" role="alert" style={{ marginTop: 12 }}>{err}</p>}
      <div className="chalk-rule" />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button className="btn ghost small" onClick={() => { s.wallet.logout(); onClose(); }}>Sign out</button>
        <button className="btn small" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
