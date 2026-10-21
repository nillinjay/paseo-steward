import type { PluginTheme } from "@getpaseo/plugin";

/**
 * The plugin's two scales. Every padding, gap, font size, line height and dot size in `client/` comes
 * from here, and every one of them is chosen by `layout.compact`. See DESIGN.md for the reasoning.
 *
 * Spacing is 4-based. Type has four steps, each with a CJK line height of 1.5. Compact (mobile, narrow
 * windows) gets one step more type and slightly tighter outer padding, because touch targets need
 * height and narrow screens need width.
 */
export function tokens(compact: boolean) {
  const type = {
    caption: compact ? 12 : 11,
    body: compact ? 14 : 13,
    title: compact ? 16 : 15,
    display: compact ? 20 : 22,
  } as const;
  return {
    space: {
      xxs: 2,
      xs: 4,
      sm: 8,
      md: 12,
      lg: 16,
      xl: compact ? 16 : 24,
    },
    type,
    /** 1.5x the type size: the CJK reading rhythm. Numbers keep tabular figures separately. */
    line: {
      caption: Math.round(type.caption * 1.5),
      body: Math.round(type.body * 1.5),
      title: Math.round(type.title * 1.5),
      display: Math.round(type.display * 1.5),
    },
    /** Diameter of the status dot outside the pill (the pill's dot follows the host's icon size). */
    dot: compact ? 10 : 8,
    /** Width of the label column in a fact row; compact stacks narrower. */
    labelWidth: compact ? 88 : 112,
    radius: compact ? 8 : 6,
  } as const;
}

export type Tokens = ReturnType<typeof tokens>;

/** The four tones a status can take. Each maps to exactly one theme colour. */
export type Tone = "success" | "warning" | "danger" | "muted";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}
