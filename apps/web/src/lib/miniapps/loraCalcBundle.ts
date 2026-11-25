/**
 * Reference standalone offline utility mini-app (`ommesh.lora-calc`, appId = 0):
 * calculates LoRa airtime, 16-byte AES block count, and Fresnel zone radius
 * with zero radio or contact permissions.
 */

import type { MiniAppPackage } from "@ommesh/miniapp-sdk";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>`;

const HTML = `
<style>
  .wrap { max-width: 560px; margin: 0 auto; padding: 20px calc(18px + var(--safe-right, 0px)) calc(32px + var(--safe-bottom, 0px)) calc(18px + var(--safe-left, 0px)); display: flex; flex-direction: column; gap: 16px; }
  h2 { margin: 0; font-size: 18px; }
  .sub { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 420px) { .grid { grid-template-columns: 1fr; } .stats { grid-template-columns: 1fr; } }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
  input, select { background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 10px; font-size: 14px; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat b { display: block; font-size: 18px; color: var(--accent); margin-top: 2px; }
  .stat span { font-size: 11px; color: var(--text-muted); }
</style>
<div class="wrap">
  <div>
    <h2 id="title">LoRa Calculator</h2>
    <p class="sub" id="sub">Offline airtime &amp; Fresnel zone utility (no radio or contact permissions)</p>
  </div>
  <div class="card">
    <div class="grid">
      <label><span id="lSf">Spreading Factor</span>
        <select id="sf"><option value="7">SF7</option><option value="8">SF8</option><option value="9">SF9</option><option value="10" selected>SF10</option><option value="11">SF11</option><option value="12">SF12</option></select>
      </label>
      <label><span id="lBw">Bandwidth</span>
        <select id="bw"><option value="62500" selected>62.5 kHz</option><option value="125000">125 kHz</option><option value="250000">250 kHz</option></select>
      </label>
      <label><span id="lCr">Coding Rate</span>
        <select id="cr"><option value="5" selected>4/5</option><option value="6">4/6</option><option value="7">4/7</option><option value="8">4/8</option></select>
      </label>
      <label><span id="lBytes">Payload (bytes)</span>
        <input id="bytes" type="number" min="1" max="184" value="20" />
      </label>
      <label><span id="lFreq">Frequency (MHz)</span>
        <input id="freq" type="number" step="0.1" value="869.5" />
      </label>
      <label><span id="lDist">Distance (km)</span>
        <input id="dist" type="number" step="0.5" min="0.1" value="5" />
      </label>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><span id="sAir">Airtime</span><b id="vAir">—</b></div>
    <div class="stat"><span id="sF1">Fresnel F1 (mid)</span><b id="vF1">—</b></div>
    <div class="stat"><span id="sF60">60% clearance</span><b id="vF60">—</b></div>
  </div>
</div>
<script>
window.ommeshReady.then(function (app) {
  var ru = app.context.locale === "ru";
  if (ru) {
    document.getElementById("title").textContent = "Калькулятор LoRa";
    document.getElementById("sub").textContent = "Офлайн-расчёт эфирного времени и зоны Френеля (без доступа к радио и контактам)";
    document.getElementById("lSf").textContent = "Spreading Factor (SF)";
    document.getElementById("lBw").textContent = "Полоса (BW)";
    document.getElementById("lCr").textContent = "Кодирование (CR)";
    document.getElementById("lBytes").textContent = "Пакет (байт)";
    document.getElementById("lFreq").textContent = "Частота (МГц)";
    document.getElementById("lDist").textContent = "Дистанция (км)";
    document.getElementById("sAir").textContent = "Время в эфире";
    document.getElementById("sF1").textContent = "Зона Френеля F1";
    document.getElementById("sF60").textContent = "60% просвета";
  }
  if (app.context.radio && app.context.radio.sf) {
    document.getElementById("sf").value = String(app.context.radio.sf);
    if (app.context.radio.bwHz) document.getElementById("bw").value = String(app.context.radio.bwHz);
    if (app.context.radio.cr) document.getElementById("cr").value = String(app.context.radio.cr);
  }
  function calc() {
    var sf = Number(document.getElementById("sf").value);
    var bw = Number(document.getElementById("bw").value);
    var cr = Number(document.getElementById("cr").value) - 4;
    var pl = Math.max(1, Number(document.getElementById("bytes").value) || 20);
    var freqGHz = (Number(document.getElementById("freq").value) || 869.5) / 1000;
    var dKm = Math.max(0.1, Number(document.getElementById("dist").value) || 5);
    var tSym = Math.pow(2, sf) / bw * 1000;
    var de = tSym >= 16 ? 1 : 0;
    var tPre = (16 + 4.25) * tSym;
    var num = Math.max(8 * pl - 4 * sf + 28 + 16, 0);
    var den = 4 * (sf - 2 * de);
    var nPay = 8 + Math.ceil(num / den) * (cr + 4);
    var airMs = Math.round(tPre + nPay * tSym);
    var f1 = 8.656 * Math.sqrt(dKm / freqGHz);
    document.getElementById("vAir").textContent = airMs + (ru ? " мс" : " ms");
    document.getElementById("vF1").textContent = f1.toFixed(1) + (ru ? " м" : " m");
    document.getElementById("vF60").textContent = (f1 * 0.6).toFixed(1) + (ru ? " м" : " m");
  }
  ["sf", "bw", "cr", "bytes", "freq", "dist"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", calc);
  });
  calc();
});
</script>
`;

export const loraCalcPackage: MiniAppPackage = {
  format: "omapp-v1",
  manifest: {
    schema: 1,
    id: "ommesh.lora-calc",
    appId: 0,
    version: "1.0.1",
    name: { ru: "Калькулятор LoRa", en: "LoRa Calculator" },
    description: {
      ru: "Офлайн-расчёт эфирного времени и зоны Френеля без доступа к радио и контактам",
      en: "Offline LoRa airtime and Fresnel zone calculator with zero permissions",
    },
    author: "Ommesh",
    scope: "standalone",
    permissions: [],
  },
  iconSvg: ICON_SVG,
  html: HTML,
};
