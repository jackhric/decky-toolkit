import { CSSProperties } from "react";

// Source: extension/media/mark-flat.svg. Mask ids are prefixed because they are document-global.
export function Mark({ size = 96, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg viewBox="140 140 480 470" width={size} height={(size * 470) / 480} fill="currentColor" style={style} aria-label="Decky Toolkit">
      <defs>
        <mask id="dtk-mark-cup" maskUnits="userSpaceOnUse" x="0" y="0" width="751" height="751">
          <rect width="751" height="751" fill="#fff" />
          <rect x="387" y="428" width="218" height="176" rx="47" fill="#000" />
          <path fill="#000" d="M278.5 212.5A109.5 109.5 0 0 1 278.5 431.5V392.5A70.5 70.5 0 0 0 278.5 251.5Z" />
          <circle cx="277.5" cy="321.5" r="55" fill="#000" />
        </mask>
        <mask id="dtk-mark-badge" maskUnits="userSpaceOnUse" x="0" y="0" width="751" height="751">
          <rect width="751" height="751" fill="#fff" />
          <path
            fill="none"
            stroke="#000"
            strokeWidth="17.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M431.2 478.7L471.7 516L431.2 553.3M502.5 553.3H560.8"
          />
        </mask>
      </defs>
      <g mask="url(#dtk-mark-cup)">
        <path
          fillRule="evenodd"
          d="M440 175H497A66 66 0 0 1 563 241V368.5A66 66 0 0 1 497 434.5H440Z M440 229.5H499A10 10 0 0 1 509 239.5V369.5A10 10 0 0 1 499 379.5H440Z"
        />
        <path d="M155 153H457V442A75 75 0 0 1 382 517H230A75 75 0 0 1 155 442Z" />
      </g>
      <rect x="398" y="439" width="196" height="154" rx="36" mask="url(#dtk-mark-badge)" />
    </svg>
  );
}
