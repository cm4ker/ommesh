import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxDoc } from "./sandbox.js";
import { chessPackage } from "./chessBundle.js";

test("buildSandboxDoc injects mobile keyboard viewport meta, anti-zoom rule and safe-area tokens", () => {
  const html = buildSandboxDoc(
    chessPackage,
    {
      id: "one-dark",
      appearance: "dark",
      textScale: 1,
      tokens: { bg: "#282c33", text: "#abb2bf" },
    },
    {
      width: 390,
      height: 700,
      safeBottom: 34,
      safeLeft: 0,
      safeRight: 0,
      keyboardHeight: 0,
      keyboardOpen: false,
      mobile: true,
    },
  );
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /--safe-bottom:\s*34px/);
  assert.match(html, /--keyboard-height:\s*0px/);
  assert.match(html, /data-mobile="1"/);
  assert.match(html, /font-size:\s*max\(16px/);
});
