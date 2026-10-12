/* eslint-disable @next/next/no-img-element */
import { brand } from "@/config/brand";

/** Chalk-drawn dime: reeded edge, "10¢" face. Decorative; the wordmark carries the name. */
export function DimeMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden className="dime-mark">
      <circle cx="20" cy="20" r="17.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.4 2.2" opacity=".7" />
      <text x="20" y="25.5" textAnchor="middle" fontFamily="var(--font-sketch)" fontWeight="700" fontSize="14" fill="currentColor">10¢</text>
    </svg>
  );
}

/** Official Monad logomark (downloaded from monad.xyz brand kit, see public/brand/monad/SOURCE.md). */
export function MonadMark({ size = 16 }: { size?: number }) {
  return <img src="/brand/monad/Logomark.svg" width={size} height={size} alt="" aria-hidden style={{ display: "block" }} />;
}

export function BuiltOnMonad({ compact = false }: { compact?: boolean }) {
  return (
    <a className="monad-badge" href="https://monad.xyz" target="_blank" rel="noreferrer" aria-label={brand.chainLine}>
      <MonadMark size={compact ? 14 : 16} />
      {!compact && <span>{brand.chainLine}</span>}
    </a>
  );
}

export function MonadLockup({ height = 22 }: { height?: number }) {
  return <img src="/brand/monad/Full-white.svg" height={height} style={{ height, width: "auto", display: "block" }} alt="Monad" />;
}
