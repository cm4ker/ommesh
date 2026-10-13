/**
 * One Dark and One Light are Zed's palettes, and so is the surface hierarchy
 * every theme keeps: in a dark theme the chrome is the lightest surface and
 * the reading surface the darkest. The others tint the ground and colour the
 * bubbles, so the app is not all grey.
 */

import type { Key } from "../i18n/index.js";

export type ThemeToken =
  | "bg"
  | "panel"
  | "chrome"
  | "elevated"
  | "hover"
  | "selected"
  | "border"
  | "borderStrong"
  | "text"
  | "textMuted"
  | "textFaint"
  | "accent"
  | "accentContrast"
  | "danger"
  | "warning"
  | "success"
  | "bubbleOut"
  | "bubbleIn";

export type ThemeTokens = Record<ThemeToken, string>;

/**
 * The colours inside a bubble, where the bubbles are not of the ground's kind:
 * Onyx sets light bubbles on a black ground, so the text in them goes dark.
 */
export interface BubblePalette {
  appearance: "light" | "dark";
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  danger: string;
}

export type BubbleToken = Exclude<keyof BubblePalette, "appearance">;

/** Beyond colour: corners, rules and a face of its own, drawn by the `:root[data-look]` blocks in styles/looks.css. */
export type ThemeLook = "terminal" | "lcd" | "classic";

export interface Theme {
  id: string;
  /** Its name as a key: the picker says it in the reader's language, and One Dark and One Light in every one. */
  name: Key;
  appearance: "light" | "dark";
  tokens: ThemeTokens;
  bubble?: BubblePalette;
  look?: ThemeLook;
}

const oneDark: Theme = {
  id: "one-dark",
  name: "radio.themes.oneDark",
  appearance: "dark",
  tokens: {
    bg: "#282c33",
    panel: "#2f343e",
    chrome: "#3b414d",
    elevated: "#2f343e",
    hover: "#363c46",
    selected: "#454a56",
    border: "#363c46",
    borderStrong: "#464b57",
    text: "#dce0e5",
    textMuted: "#a9afbc",
    textFaint: "#878a98",
    accent: "#74ade8",
    accentContrast: "#282c33",
    danger: "#d07277",
    warning: "#dec184",
    success: "#a1c181",
    bubbleOut: "#3a4a63",
    bubbleIn: "#353a44",
  },
};

const oneLight: Theme = {
  id: "one-light",
  name: "radio.themes.oneLight",
  appearance: "light",
  tokens: {
    bg: "#fafafa",
    panel: "#ebebec",
    chrome: "#dcdcdd",
    elevated: "#fafafa",
    hover: "#dfdfe0",
    selected: "#cacaca",
    border: "#dfdfe0",
    borderStrong: "#c9c9ca",
    text: "#242529",
    textMuted: "#5c5e63",
    textFaint: "#8a8c91",
    accent: "#5c78e2",
    accentContrast: "#fafafa",
    danger: "#d36151",
    warning: "#b48f2c",
    success: "#659f58",
    bubbleOut: "#dfe6f7",
    bubbleIn: "#ececed",
  },
};

/** By name, as the picker shows them in the reader's language, so no kind of theme stands apart from the rest. */
export const themes: Theme[] = [
  {
    id: "amber",
    name: "radio.themes.amber",
    appearance: "dark",
    look: "terminal",
    tokens: {
      bg: "#0c0904",
      panel: "#110c05",
      chrome: "#110c05",
      elevated: "#140e06",
      hover: "#1d150a",
      selected: "#2b1f0c",
      border: "#2a1e0b",
      borderStrong: "#4a3514",
      text: "#ffb54a",
      textMuted: "#cc8f38",
      textFaint: "#8f6427",
      accent: "#ffb000",
      accentContrast: "#0c0904",
      danger: "#ff5a36",
      warning: "#ffd24a",
      success: "#d8c24a",
      bubbleOut: "#22180a",
      bubbleIn: "#140e06",
    },
  },
  {
    id: "apricot",
    name: "radio.themes.apricot",
    appearance: "light",
    tokens: {
      bg: "#fff7f1",
      panel: "#ffece0",
      chrome: "#ffe0cc",
      elevated: "#ffffff",
      hover: "#ffe6d6",
      selected: "#ffd2b8",
      border: "#f7dfcf",
      borderStrong: "#eec3a8",
      text: "#33190e",
      textMuted: "#74503f",
      textFaint: "#a07f70",
      accent: "#d9491a",
      accentContrast: "#ffffff",
      danger: "#c8233b",
      warning: "#b7791f",
      success: "#3f9142",
      bubbleOut: "#ffd9c2",
      bubbleIn: "#ffffff",
    },
  },
  {
    id: "berry",
    name: "radio.themes.berry",
    appearance: "light",
    tokens: {
      bg: "#fff5f9",
      panel: "#ffe8f1",
      chrome: "#ffdbea",
      elevated: "#ffffff",
      hover: "#ffe2ee",
      selected: "#ffc9df",
      border: "#f8dbe7",
      borderStrong: "#efbcd1",
      text: "#3a1027",
      textMuted: "#7a4762",
      textFaint: "#a67a90",
      accent: "#d6246e",
      accentContrast: "#ffffff",
      danger: "#c62828",
      warning: "#b7791f",
      success: "#3f9142",
      bubbleOut: "#ffd1e4",
      bubbleIn: "#ffffff",
    },
  },
  {
    id: "dusk",
    name: "radio.themes.dusk",
    appearance: "dark",
    tokens: {
      bg: "#1f1519",
      panel: "#291c21",
      chrome: "#35242b",
      elevated: "#2c1f25",
      hover: "#36252c",
      selected: "#452f38",
      border: "#33232a",
      borderStrong: "#4a343d",
      text: "#fbeceb",
      textMuted: "#d4b2b3",
      textFaint: "#9e8084",
      accent: "#ff8b5e",
      accentContrast: "#2a130c",
      danger: "#ff6b81",
      warning: "#ffc76b",
      success: "#8bd49a",
      bubbleOut: "#7a2944",
      bubbleIn: "#30222a",
    },
  },
  {
    id: "grape",
    name: "radio.themes.grape",
    appearance: "dark",
    tokens: {
      bg: "#1b1429",
      panel: "#231a35",
      chrome: "#2e2344",
      elevated: "#261d3a",
      hover: "#2f2447",
      selected: "#3b2e58",
      border: "#2c2242",
      borderStrong: "#3e3259",
      text: "#efe9ff",
      textMuted: "#bdb0dc",
      textFaint: "#8a7eaa",
      accent: "#b692ff",
      accentContrast: "#1b1429",
      danger: "#ff7a93",
      warning: "#f5c66b",
      success: "#7fdca0",
      bubbleOut: "#4a2e85",
      bubbleIn: "#2b2140",
    },
  },
  {
    id: "lagoon",
    name: "radio.themes.lagoon",
    appearance: "dark",
    tokens: {
      bg: "#0e1f2b",
      panel: "#132936",
      chrome: "#1a3545",
      elevated: "#16303f",
      hover: "#1b3848",
      selected: "#234656",
      border: "#1d3746",
      borderStrong: "#2a4a5c",
      text: "#e2f2f7",
      textMuted: "#a2c3cf",
      textFaint: "#6f929f",
      accent: "#36c5d9",
      accentContrast: "#06222c",
      danger: "#ff7b7b",
      warning: "#f2c46d",
      success: "#6fd49a",
      bubbleOut: "#125669",
      bubbleIn: "#1b3444",
    },
  },
  {
    id: "mint",
    name: "radio.themes.mint",
    appearance: "light",
    tokens: {
      bg: "#f2faf5",
      panel: "#e4f4ea",
      chrome: "#d5eedf",
      elevated: "#ffffff",
      hover: "#dcf0e3",
      selected: "#c3e6d0",
      border: "#d3eadc",
      borderStrong: "#aad3ba",
      text: "#13291c",
      textMuted: "#46614f",
      textFaint: "#6f8a79",
      accent: "#0a875c",
      accentContrast: "#ffffff",
      danger: "#d64545",
      warning: "#b7791f",
      success: "#3a9d23",
      bubbleOut: "#c6f0d6",
      bubbleIn: "#ffffff",
    },
  },
  {
    id: "olive",
    name: "radio.themes.olive",
    appearance: "light",
    look: "lcd",
    tokens: {
      bg: "#c5cf9a",
      panel: "#bbc68d",
      chrome: "#aeba80",
      elevated: "#cdd6a5",
      hover: "#b7c288",
      selected: "#a3b074",
      border: "#a4b077",
      borderStrong: "#56613a",
      text: "#1d2610",
      textMuted: "#3c4826",
      textFaint: "#5f6b45",
      accent: "#27330f",
      accentContrast: "#c5cf9a",
      danger: "#6b1d10",
      warning: "#5a4a0a",
      success: "#27330f",
      bubbleOut: "#aebb80",
      bubbleIn: "#d0d8aa",
    },
  },
  oneDark,
  oneLight,
  {
    id: "onyx",
    name: "radio.themes.onyx",
    appearance: "dark",
    tokens: {
      bg: "#000000",
      panel: "#0e0e10",
      chrome: "#161618",
      elevated: "#1c1c1e",
      hover: "#1c1c1f",
      selected: "#2a2a2e",
      border: "#1f1f22",
      borderStrong: "#3a3a3f",
      text: "#f2f2f5",
      textMuted: "#a8a8b0",
      textFaint: "#6e6e76",
      accent: "#5aa2ff",
      accentContrast: "#00142e",
      danger: "#ff6b6b",
      warning: "#ffc857",
      success: "#5fd38a",
      bubbleOut: "#cfe3ff",
      bubbleIn: "#e9e9ec",
    },
    bubble: {
      appearance: "light",
      text: "#111114",
      textMuted: "#44444c",
      textFaint: "#66666e",
      accent: "#1f6fd6",
      danger: "#c62828",
    },
  },
  {
    id: "pebble",
    name: "radio.themes.pebble",
    appearance: "light",
    look: "classic",
    tokens: {
      bg: "#d4d0c8",
      panel: "#d4d0c8",
      chrome: "#d4d0c8",
      elevated: "#ffffff",
      hover: "#e0ddd6",
      selected: "#b9c4de",
      border: "#808080",
      borderStrong: "#404040",
      text: "#000000",
      textMuted: "#333333",
      textFaint: "#6b6b6b",
      accent: "#0a246a",
      accentContrast: "#ffffff",
      danger: "#c00000",
      warning: "#806000",
      success: "#008000",
      bubbleOut: "#ffffe1",
      bubbleIn: "#ffffff",
    },
  },
];

export const defaultDark = oneDark;
export const defaultLight = oneLight;

export function findTheme(id: string): Theme | undefined {
  return themes.find((t) => t.id === id);
}

export function cssVariable(token: ThemeToken): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** `--bubble-text`, `--bubble-text-muted`…: set where a theme has a bubble palette, and read only inside bubbles. */
export function bubbleVariable(token: BubbleToken): string {
  return `--bubble-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
