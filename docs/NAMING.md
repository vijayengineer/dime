# Naming

CHALK is a placeholder. All user-facing names come from `src/config/brand.ts`
(`name`, `rightsName`, `houseName`, tab labels, org line), so renaming the app takes
one file edit. The EIP-712 domain name is the one exception: it is fixed at contract
deployment (read via `eip712Domain()`), so pick it before the testnet deploy.

**Availability status for every name below: domain, social handles and trademark are
UNCHECKED.** Where I know of a likely conflict I've noted it, but that is not a search.

## Criteria

- Short, easy to say, easy to spell after hearing it once.
- Works for a playful trading app *and* a credible financial product.
- Does not imply guaranteed returns, safety, or getting losses back.
- Stretches across three surfaces: the trading app, the House and its revenue rights,
  and future markets and integrations.

## Candidates

| # | Name | Rationale | Risks / notes |
|---|------|-----------|---------------|
| 1 | **CHALK** | Chalkboard scoreboard: results get written up and wiped clean. "Chalk it up" works for wins *and* losses, so it doesn't cheerlead. Lends itself to a hand-drawn visual identity (the current design). "CHALK rights" reads naturally. | In US sports betting, "chalk" means the favourite, which is a mild gambling connotation. Generic word, so trademark scope may be narrow. |
| 2 | **ODDLOT** | An odd lot is the finance term for an order smaller than the standard size, which describes $0.10 tickets exactly. Insider-credible and a little playful. "Oddlot House" works. | Ties the brand to small size; it may feel limiting as tickets grow. "Odd" can read as unserious. |
| 3 | **FLINT** | Small strike, big spark: a fit for small capital and high leverage without promising a win. Hard, durable word, so it reads credibly. "Flint rights" and "Flint House" both work. | No finance meaning to lean on. Several unrelated companies use it. |
| 4 | **TALLY** | Accounting and transparency: the House "keeps the tally". | **Known conflict:** Tally is an established crypto governance product. Avoid. |
| 5 | **LEDGE** | Edge + ledger, and honest about risk ("on the ledge"). | Easily confused with Ledger, the hardware wallet company, in the same crypto audience. Avoid. |
| 6 | **TICKHOUSE** | A tick is the smallest price move; "house" names the counterparty. Describes both halves of the product. | Long, and literal. Might work better as a product line than as the brand. |
| 7 | **PIP** | Tiny, friendly, and a real trading unit. | Very common word, hard to own, and FX connotations. |
| 8 | **SLATE** | The chalkboard metaphor with a cleaner, more institutional feel. "Slate rights". | Slate is a well-known media brand, so there may be trademark friction. |

## Recommendation (top three)

1. **CHALK** (provisional default, already wired in). It has the strongest visual
   identity, it's neutral on win/loss, and it works across the app, the House and rights.
   The betting slang ("chalk" = the favourite) is the main thing to clear.
2. **ODDLOT.** The most distinctive and the most "credible finance" of the set. Choose
   it if the brand should signal small-ticket trading for the long term.
3. **FLINT.** The safest general-purpose option if CHALK and ODDLOT fail clearance;
   it scales to multiple markets without baggage.

Before committing, run domain, handle and trademark searches (US, UK, EU, plus a
crypto-specific search for name collisions), and decide the EIP-712 domain name.

## Round 2: short, generic and acronym-style names

Requested direction: something like PAPER, or an acronym like MIM (Magic Internet
Money). Availability is UNCHECKED for every name; known conflicts are noted.

| Name | Acronym / backronym | Why it works | Risks |
|---|---|---|---|
| **DIME** | Digital Instant Margin Exchange | A dime is $0.10, the illustrative ticket size. Small, honest, and unmistakably money. "Dime rights" and "the Dime House" both work. | Existing US brands (Dime Community Bank, possibly others) need clearing. |
| **BLIP** | BTC Leveraged Instant Positions | A short, small move on a screen, which suits quick, tiny positions. Neutral on winning. | Weak meaning on its own; needs the visual identity to carry it. |
| **TAB** | Trade Against Bitcoin, or simply "the House tab" | "Open a tab with the House", a tally of what's owed. Three letters and easy to say. | "Running a tab" suggests credit or debt; users can never owe more than their margin. |
| **PAPER** | Peer And Pool Exchange Rails (matched + house) | Strong crypto meme ("paper hands"). The backronym describes both routes. | "Paper trading" means simulated money, which is confusing on a real-money app and may read as a demo. |
| **MIM** | Magic Internet Money | Instant BTC-culture recognition. | **Known conflict:** MIM is Abracadabra's long-running stablecoin. Also has the "money from nothing" problem. Avoid. |
| **FLIP** | Fast Leveraged Instant Positions | Flip long or short; playful. | Common in crypto-gambling naming, which is the wrong neighbourhood. |
| **KITE** | Keep It Tiny, Elevated | Small thing flying high on a string (leverage) that can be cut. | **Known conflict:** Kite is Zerodha's trading platform. Avoid. |

**Round 2 pick: DIME.** It's the only one that encodes the product's real constraint
(tiny tickets) rather than a promise. BLIP is the runner-up. Overall shortlist:
CHALK, DIME, ODDLOT.

## Decision (2026-10-12): FLIP, provisional

The user chose **FLIP**; `src/config/brand.ts` is updated. Suggested backronym, if one
is wanted: **Fixed-Loss Isolated Positions** (your loss is capped at your margin, and
margin is isolated). Avoid "Fast/Instant", which overclaims.

Risks to clear: "flip" evokes a coin flip, which invites a gambling reading of a
leveraged product (wording around Play, loss screens and marketing should stay sober).
The name is common in crypto-casino and consumer-app naming. Domain, handle and
trademark checks are still UNCHECKED, and the EIP-712 domain name must be set before
the testnet deploy.

## Decision (2026-10-12, supersedes FLIP): DIME, provisional

**DIME**: a dime is $0.10, the illustrative ticket. Positioning: the opposite of
paper trading, with real money at dime-sized stakes. Tagline: "Not paper. Real trades,
dime-sized."

- Formal expansion (app footer, docs, pitch): **Directional Isolated Monad Exposure**.
- Playful expansion (social and marketing only): **Degens Inside Monad Exposure** (user preference, 2026-10-12).
- Considered: "Degens In Monad Exchange". Not used because "Exchange" is a regulated
  term in many jurisdictions and implies a licence.
- Marketing guardrail: "real money" plus "1000×" must never become "real wins". Keep
  max loss = your dime visible next to any leverage claim.
- Still UNCHECKED: domains, handles, trademark (e.g. Dime Community Bank, other "Dime"
  fintechs), Monad Foundation's view on "Monad" in the expansion, and the EIP-712 domain name.
