import { ReactNode } from "react";

// Drawn on Steam's settings icon grid (36x36, solid currentColor shapes, ~3 unit lines) so they sit
// next to Steam's own glyphs; Steam's are minified webpack exports with no stable name to look up.
function Glyph({ d }: { d: string }): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={d} />
    </svg>
  );
}

const ring = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

export const ServerIcon = () => (
  <Glyph
    d={
      "M3 4H33V16H3Z M6 7V13H30V7Z M22 9H27V11H22Z " +
      "M3 20H33V32H3Z M6 23V29H30V23Z M22 25H27V27H22Z"
    }
  />
);

export const RemoteInputIcon = () => (
  <Glyph
    d={
      "M10 7H26C30.4 7 33.2 10 34 14.5L35.2 25C35.7 29.6 31.1 31.6 28.4 28.4L25 24H11L7.6 28.4C4.9 31.6 0.3 29.6 0.8 25L2 14.5C2.8 10 5.6 7 10 7Z " +
      "M8.5 11.5V14.5H5.5V17.5H8.5V20.5H11.5V17.5H14.5V14.5H11.5V11.5Z " +
      ring(24.5, 13.5, 1.9) +
      ring(28.5, 17.5, 1.9)
    }
  />
);

export const PairedDevicesIcon = () => (
  <Glyph d="M5 6H31V25H5Z M8 9V22H28V9Z M1 27H35V28C35 29.7 33.7 31 32 31H4C2.3 31 1 29.7 1 28Z" />
);

export const AboutIcon = () => (
  <Glyph d={`${ring(18, 18, 15)} ${ring(18, 18, 12)} ${ring(18, 11, 2.2)} M16 15.5H20V26H16Z`} />
);
