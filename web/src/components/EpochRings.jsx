// The official True North Atlas mark: halving epochs as rings, the north star
// at true north, and a coin on the outer ring.
//
// Two modes:
//   - height provided  -> the coin sits at the chain's ACTUAL progress through
//     the current halving epoch (the logo is a live instrument, not a sticker)
//   - height unknown   -> the coin orbits slowly (also used as the app's
//     loading spinner)
import { coinXY, epochInfo, epochLabel } from '../epoch.js';

export default function EpochRings({ height = null, size = 30, title }) {
  const info = epochInfo(height);
  const coin = info ? coinXY(info.progress) : null;
  const label = title ?? epochLabel(height);

  return (
    <svg viewBox="0 0 240 240" width={size} height={size} fill="none"
      role="img" aria-label={label} className="epoch-rings">
      <title>{label}</title>
      <defs>
        <linearGradient id="er-aur" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--cold, #58A8FF)" />
          <stop offset="1" stopColor="var(--aurora, #4FE3A9)" />
        </linearGradient>
      </defs>

      {/* Epoch rings — tightening like issuance */}
      <circle cx="120" cy="120" r="34" stroke="var(--ink-line, #1C2B47)" strokeWidth="9" />
      <circle cx="120" cy="120" r="58" stroke="var(--ink-line, #1C2B47)" strokeWidth="8" />
      <circle cx="120" cy="120" r="78" stroke="var(--ink-line, #1C2B47)" strokeWidth="7" />
      <circle cx="120" cy="120" r="94" stroke="url(#er-aur)" strokeWidth="8" />

      {/* Center marker */}
      <path d="M120 106 L126 118 L120 130 L114 118 Z" fill="var(--text, #E8EEF7)" />

      {/* North star at true north */}
      <path d="M120 6 L127 20 L141 24 L127 28 L120 42 L113 28 L99 24 L113 20 Z"
        fill="var(--aurora, #4FE3A9)" />

      {/* The coin: data-positioned when the chain height is known, orbiting otherwise */}
      {coin ? (
        <circle cx={coin.x} cy={coin.y} r="11" fill="var(--btc, #F7931A)">
          <animate attributeName="opacity" values="1;0.75;1" dur="3s" repeatCount="indefinite" />
        </circle>
      ) : (
        <g>
          <circle cx="120" cy="26" r="11" fill="var(--btc, #F7931A)" />
          <animateTransform attributeName="transform" type="rotate"
            from="0 120 120" to="360 120 120" dur="8s" repeatCount="indefinite" />
        </g>
      )}
    </svg>
  );
}
