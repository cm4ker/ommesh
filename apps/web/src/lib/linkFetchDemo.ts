/**
 * Answers for the dev server, which has no native fetch: a few made-up pages,
 * a video, a picture and a file, so the cards can be worked on in a browser.
 * Loaded only in development (`linkFetch.ts`), never in a build.
 */

const PAGES: { match: RegExp; html: string }[] = [
  {
    match: /github\.com\/meshcore-dev\/MeshCore\/?$/,
    html: `<title>GitHub</title><meta property="og:title" content="GitHub - meshcore-dev/MeshCore: A new lightweight, hybrid routing mesh protocol for packet radios"><meta property="og:description" content="Contribute to meshcore-dev/MeshCore development by creating an account on GitHub."><meta name="twitter:card" content="summary_large_image"><meta property="og:image" content="https://opengraph.githubassets.com/demo/meshcore.png">`,
  },
  {
    match: /wikipedia\.org\/wiki\/LoRa/,
    html: `<title>LoRa - Wikipedia</title><meta property="og:title" content="LoRa - Wikipedia"><meta name="description" content="LoRa (from &quot;long range&quot;) is a physical proprietary radio communication technique based on spread spectrum modulation.">`,
  },
  {
    match: /youtu\.?be/,
    html: `<meta property="og:type" content="video.other"><meta property="og:title" content="Антенна на 868 МГц за вечер"><meta property="og:description" content="Радиокружок"><meta itemprop="duration" content="PT12M47S"><meta property="og:image" content="https://i.ytimg.com/vi/demo/hqdefault.jpg">`,
  },
  {
    match: /habr\.com/,
    html: `<meta property="og:title" content="Коллинеарная антенна на 868 МГц из коаксиала"><meta property="og:description" content="Собираем за вечер из куска RG-58: расчёт секций, согласование и замер КСВ на NanoVNA."><meta property="og:image" content="https://habrastorage.org/demo/cover.png"><meta property="og:site_name" content="Хабр">`,
  },
];

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

/** A small drawn picture: a mast on a hill under a sky, in PNG. */
async function picture(width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#4f6f91";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#3f5a48";
  g.beginPath();
  g.moveTo(0, height * 0.75);
  g.quadraticCurveTo(width * 0.4, height * 0.5, width, height * 0.65);
  g.lineTo(width, height);
  g.lineTo(0, height);
  g.fill();
  g.strokeStyle = "#dce0e5";
  g.lineWidth = Math.max(2, width / 120);
  g.beginPath();
  g.moveTo(width * 0.4, height * 0.68);
  g.lineTo(width * 0.4, height * 0.15);
  g.stroke();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function demoFetch(url: string, onlyPicture: boolean) {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const answer = (contentType: string, body: Uint8Array, length: number | null = body.length, disposition: string | null = null) => ({ url, status: 200, contentType, length, disposition, body: base64(body), cut: false });
  if (/\.(png|jpe?g|webp|gif)$/i.test(url) || onlyPicture) {
    return answer("image/png", await picture(onlyPicture ? 600 : 800, onlyPicture ? 315 : 600));
  }
  if (/\.(uf2|bin|zip|apk|pdf)$/i.test(url)) return answer("application/octet-stream", new Uint8Array(), 3_250_000);
  const page = PAGES.find((p) => p.match.test(url));
  if (!page) throw new Error("timeout");
  return answer("text/html; charset=utf-8", new TextEncoder().encode(page.html));
}
