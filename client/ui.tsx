import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { toneColor, type Tokens, type Tone } from "./design";
import type { StewardStatus } from "./model";
import { S } from "./strings";

/** The one status mark: a filled dot when a steward works, a ring when it is idle, stale or absent. */
export function StatusDot({ theme, status, size }: { theme: PluginTheme; status: StewardStatus; size: number }) {
  const color = toneColor(theme, status.tone);
  return (
    <View
      accessibilityLabel={S.a11y.status(status.label)}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: Math.max(1.5, size / 5),
        borderColor: color,
        backgroundColor: status.filled ? color : undefined,
      }}
    />
  );
}

/**
 * A section heading. CJK typography: no case transform, no tracking, 1.5 line height.
 * A count belongs in the title itself, in full-width parentheses, not in a separate column.
 */
export function Section({ title, note, theme, t }: { title: string; note?: string; theme: PluginTheme; t: Tokens }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: t.space.sm, marginTop: t.space.xl, marginBottom: t.space.xs }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, fontWeight: "600", lineHeight: t.line.caption }}>
        {title}
      </Text>
      {note ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption, opacity: 0.75 }}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One fact: muted label on the left, value on the right. `lead` sits before the value (a status dot);
 * `detail` is a quieter clause under the value.
 */
export function Fact({
  label,
  value,
  detail,
  tone,
  lead,
  theme,
  t,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
  lead?: ReactNode;
  theme: PluginTheme;
  t: Tokens;
}) {
  return (
    <View style={{ flexDirection: "row", gap: t.space.md, paddingVertical: t.space.xs }}>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: t.type.body,
          lineHeight: t.line.body,
          width: t.labelWidth,
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, gap: t.space.xxs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          {lead}
          <Text
            style={{
              color: tone ? toneColor(theme, tone) : theme.colors.foreground,
              fontSize: t.type.body,
              lineHeight: t.line.body,
              fontVariant: ["tabular-nums"],
              flexShrink: 1,
            }}
            selectable
          >
            {value}
          </Text>
        </View>
        {detail ? (
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption }}
            selectable
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A line of a list: primary text, then a muted trailing clause. Used for legs, merges, questions. */
export function Line({ text, trailing, tone, theme, t }: { text: string; trailing?: string; tone?: Tone; theme: PluginTheme; t: Tokens }) {
  return (
    <View style={{ paddingVertical: t.space.xs, gap: t.space.xxs }}>
      <Text
        style={{ color: tone ? toneColor(theme, tone) : theme.colors.foreground, fontSize: t.type.body, lineHeight: t.line.body }}
        selectable
      >
        {text}
      </Text>
      {trailing ? (
        <Text
          style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption }}
          selectable
          numberOfLines={2}
        >
          {trailing}
        </Text>
      ) : null}
    </View>
  );
}

/** `primary` is the single action that changes something; everything else is `secondary`. */
export function Button({
  label,
  onPress,
  theme,
  t,
  variant = "secondary",
  disabled,
}: {
  label: string;
  onPress: () => void;
  theme: PluginTheme;
  t: Tokens;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        paddingHorizontal: t.space.md,
        paddingVertical: t.space.sm,
        borderRadius: t.radius,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface1,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: t.type.body, lineHeight: t.line.body }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A labelled chip that shows a setting's CURRENT state and toggles it, e.g. the plan and question policies.
 * An accent border marks "on"; the label itself always carries the state, so colour is not the only cue.
 */
export function ChoiceChip({
  label,
  on,
  onPress,
  theme,
  t,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  theme: PluginTheme;
  t: Tokens;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        paddingHorizontal: t.space.md,
        paddingVertical: t.space.sm,
        borderRadius: t.radius,
        borderWidth: 1,
        borderColor: on ? theme.colors.accent : theme.colors.border,
        backgroundColor: on ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          color: on ? theme.colors.foreground : theme.colors.foregroundMuted,
          fontSize: t.type.body,
          lineHeight: t.line.body,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A bordered block on `surface1`, for the "now" summary at the top of the panel and the screen. */
export function Card({ children, theme, t }: { children: ReactNode; theme: PluginTheme; t: Tokens }) {
  return (
    <View
      style={{
        marginTop: t.space.lg,
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.md,
        borderRadius: t.radius,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}
