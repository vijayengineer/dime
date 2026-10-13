import type { Metadata } from "next";
import { TERMS, TERMS_VERSION } from "@shared/terms";

export const metadata: Metadata = { title: "Terms of Use — DIME" };

export default function TermsPage() {
  return (
    <article className="stack terms-doc">
      <header>
        <h1 className="display" style={{ fontSize: 40, margin: "4px 0 0" }}>Terms of Use</h1>
        <p className="dim" style={{ marginTop: 4 }}>Version {TERMS_VERSION}. DIME is a hackathon project that uses real money. Please read this before trading.</p>
      </header>
      <section className="card">
        {TERMS.map((t) => (
          <div key={t.title}>
            <h2>{t.title}</h2>
            {t.body.map((p, i) => <p key={i}>{p}</p>)}
          </div>
        ))}
      </section>
    </article>
  );
}
