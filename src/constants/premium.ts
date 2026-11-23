/**
 * Presenti Premium UI tokens
 * ----------------------------------------------------------------------------
 * "Bolt-style" premium mobile feel built on the ArtCraft palette (design.md):
 *  - Navy #142748 is the ink + primary CTA fill
 *  - Electric blue #2d81ff is the single accent (active states, links, live dots)
 *  - Warm paper #f2f1ee is the app canvas; pure white cards float on it
 *  - Mono (uppercase, tracked) labels for actions, badges & metadata
 *
 * Mobile adaptation of design.md (intentional): cards get soft 16px corners and
 * a near-imperceptible shadow so they lift off the paper canvas the way Bolt /
 * Uber cards do. Primary CTAs are full-width, 56px tall, 14px radius.
 */
import {
  Dimensions,
  PixelRatio,
  Platform,
  type TextStyle,
  type ViewStyle,
} from "react-native";

const BASE_WIDTH = 390;

/**
 * Width-responsive font scaler: adapts typography proportionally to any device
 * screen width while clamping scale between 0.85x and 1.12x for readability.
 */
export function rf(size: number): number {
  const { width } = Dimensions.get("window");
  const widthScale = Math.min(1.12, Math.max(0.85, width / BASE_WIDTH));
  const osFontScale = PixelRatio.getFontScale();
  // Cap OS accessibility font zoom impact at 1.08x so cards and buttons never overflow
  const cappedOsScale = Math.min(osFontScale, 1.08) / Math.max(osFontScale, 1);
  return Math.round(PixelRatio.roundToNearestPixel(size * widthScale * cappedOsScale));
}

export const C = {
  ink: "#142748", // primary text / CTA fill
  ink2: "#3b4a66", // secondary text
  muted: "#7a8499", // tertiary text / captions
  faint: "#a9b0bf", // placeholder / disabled
  accent: "#2d81ff",
  accentSoft: "rgba(45,129,255,0.10)",
  accentSoft2: "rgba(45,129,255,0.18)",
  canvas: "#f2f1ee", // app background (paper)
  card: "#ffffff",
  cardAlt: "#f7f6f3", // inset rows inside a white card
  line: "#e9e8e4", // hairline dividers on paper
  lineCard: "#eef0f3", // hairline dividers inside white cards
  success: "#12a150",
  successSoft: "rgba(18,161,80,0.10)",
  warn: "#e08a00",
  warnSoft: "rgba(224,138,0,0.12)",
  danger: "#d92d20",
  dangerSoft: "rgba(217,45,32,0.08)",
  overlay: "rgba(20,39,72,0.45)",
  white: "#ffffff",
} as const;

export const R = {
  xs: 6,
  sm: 10,
  md: 14, // buttons, inputs
  lg: 18, // cards
  xl: 24, // bottom sheets
  pill: 999,
} as const;

export const S = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  screenX: 20, // horizontal screen padding
} as const;

export const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

/** Soft, Bolt-like elevation. Use `shadow.card` on white cards over the canvas. */
export const shadow: Record<"none" | "card" | "raised" | "sheet", ViewStyle> = {
  none: {},
  card: {
    shadowColor: "#142748",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  raised: {
    shadowColor: "#142748",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 20,
    elevation: 8,
  },
  sheet: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 16,
  },
};

/** Typography scale */
export const T: Record<
  | "hero"
  | "display"
  | "title"
  | "heading"
  | "body"
  | "bodyStrong"
  | "caption"
  | "label"
  | "labelSm"
  | "metric",
  TextStyle
> = {
  hero: { fontSize: rf(40), fontWeight: "800", letterSpacing: -1.4, color: C.ink },
  display: { fontSize: rf(28), fontWeight: "800", letterSpacing: -0.8, color: C.ink },
  title: { fontSize: rf(20), fontWeight: "700", letterSpacing: -0.3, color: C.ink },
  heading: { fontSize: rf(16), fontWeight: "700", letterSpacing: -0.1, color: C.ink },
  body: { fontSize: rf(15), fontWeight: "400", lineHeight: rf(22), color: C.ink2 },
  bodyStrong: { fontSize: rf(15), fontWeight: "600", lineHeight: rf(22), color: C.ink },
  caption: { fontSize: rf(13), fontWeight: "400", lineHeight: rf(18), color: C.muted },
  label: {
    fontSize: rf(11),
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    fontFamily: MONO,
    color: C.muted,
  },
  labelSm: {
    fontSize: rf(10),
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: MONO,
    color: C.muted,
  },
  metric: { fontSize: rf(30), fontWeight: "800", letterSpacing: -1, color: C.ink },
};

/** Reusable building blocks */
export const ui = {
  screen: { flex: 1, backgroundColor: C.canvas } as ViewStyle,
  card: {
    backgroundColor: C.card,
    borderRadius: R.lg,
    padding: S.md,
    ...shadow.card,
  } as ViewStyle,
  cardFlat: {
    backgroundColor: C.card,
    borderRadius: R.lg,
    padding: S.md,
    borderWidth: 1,
    borderColor: C.lineCard,
  } as ViewStyle,
  row: { flexDirection: "row", alignItems: "center" } as ViewStyle,
  divider: { height: 1, backgroundColor: C.lineCard } as ViewStyle,
  btnPrimary: {
    height: 54,
    borderRadius: R.md,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: S.md,
  } as ViewStyle,
  btnPrimaryText: {
    color: C.white,
    fontSize: rf(11.5),
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: MONO,
  } as TextStyle,
  btnSecondary: {
    height: 50,
    borderRadius: R.md,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: "rgba(20,39,72,0.14)",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: S.md,
  } as ViewStyle,
  btnSecondaryText: {
    color: C.ink,
    fontSize: rf(11),
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    fontFamily: MONO,
  } as TextStyle,
  input: {
    height: 54,
    borderRadius: R.md,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
    paddingHorizontal: S.md,
    fontSize: rf(15),
    color: C.ink,
  } as TextStyle,
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
    backgroundColor: C.accentSoft,
  } as ViewStyle,
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.accentSoft,
  } as ViewStyle,
  sheet: {
    backgroundColor: C.card,
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    ...shadow.sheet,
  } as ViewStyle,
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#d9dce3",
    marginTop: 8,
    marginBottom: 6,
  } as ViewStyle,
};
