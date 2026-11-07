const v = (name: string, fallback: string) => `var(--${name}, ${fallback})`;

const TEXT_SIZES = ["11px", "12px", "13px", "15px", "18px", "22px", "24px", "28px", "36px"] as const;

export const theme = {
  accent: v("color-accent-8", "#1a9fff"),
  accentBright: v("color-accent-10", "#56abff"),
  accentDim: v("color-accent-6", "#104d87"),
  positive: v("color-grass-9", "#46a758"),
  textTitle: v("color-text-body-title", "#f1f2f3"),
  textSubtitle: v("color-text-body-subtitle", "#d6d9dc"),
  textMuted: v("color-dull-11", "#8b929a"),
  radius: v("radius-md", "4px"),
  textSize: (step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) => v(`text-size-${step}`, TEXT_SIZES[step - 1]),
  focusBackground: "#fff",
  focusText: "#000",
  focusRing: "rgba(255,255,255,0.45)",
  surface: "rgba(255,255,255,0.04)",
  surfaceRaised: "rgba(255,255,255,0.06)",
  surfaceFocus: "rgba(255,255,255,0.2)",
} as const;
