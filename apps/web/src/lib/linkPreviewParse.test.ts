import { test } from "node:test";
import assert from "node:assert/strict";
import { autoAllowed, cleanText, decodePage, durationLabel, fileOf, isoSeconds, linkAllowed, pictureFits, pictureSize, punycodeLabel, readHead, shownHost } from "./linkPreviewParse.js";

test("a preview reaches only the open web, on its own ports", () => {
  for (const ok of ["https://habr.com/ru/articles/812345/", "http://forum-lora.ru/t/4412", "https://youtu.be/xk3B9mWq2Zs", "https://93.184.215.14/", "https://habr.com:443/"]) assert.ok(linkAllowed(ok), ok);
  for (const no of [
    "http://192.168.1.1/reboot",
    "http://10.0.0.1/",
    "http://172.20.0.1/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.1.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::5]/",
    "http://[::ffff:192.168.0.1]/",
    "http://localhost/",
    "http://router/",
    "http://nas.lan/",
    "http://printer.local/",
    "https://habr.com:8443/",
    "http://10.0.0.1:5000/",
    "https://user:secret@habr.com/",
    "ftp://habr.com/",
  ])
    assert.ok(!linkAllowed(no), no);
});

test("only an encrypted link previews by itself", () => {
  assert.ok(autoAllowed("https://habr.com/"));
  assert.ok(!autoAllowed("http://habr.com/"));
  assert.ok(!autoAllowed("https://192.168.1.1/"));
});

test("Open Graph comes first, then Twitter's card, then the page's own title", () => {
  const html = `<html><head>
    <title>Own title</title>
    <meta name="description" content="Own description">
    <meta property="og:title" content="Коллинеарная антенна &laquo;868&raquo;">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="/img/cover.jpg">
    <meta property="og:image" content="/img/second.jpg">
  </head><body></body></html>`;
  const head = readHead(html, "https://habr.com/ru/articles/1/");
  assert.equal(head.title, "Коллинеарная антенна «868»");
  assert.equal(head.description, "Own description");
  assert.equal(head.image, "https://habr.com/img/cover.jpg");
  assert.equal(head.large, true);
  assert.equal(readHead("<title> Just a  title </title>", "https://a.ru/").title, "Just a title");
});

test("a tag inside a script or a comment is not the page's", () => {
  const html = `<script>var s = '<meta property="og:title" content="Fake">';</script><!-- <meta property="og:title" content="Old"> --><meta content="Real" property='og:title'>`;
  assert.equal(readHead(html, "https://a.ru/").title, "Real");
});

test("a video says so and gives its length", () => {
  const html = `<meta property="og:type" content="video.other"><meta itemprop="duration" content="PT12M47S"><meta property="og:title" content="Антенна">`;
  const head = readHead(html, "https://www.youtube.com/watch?v=x");
  assert.equal(head.video, true);
  assert.equal(head.large, true);
  assert.equal(head.duration, 767);
  assert.equal(durationLabel(767), "12:47");
  assert.equal(durationLabel(3723), "1:02:03");
  assert.equal(isoSeconds("PT3M33S"), 213);
  assert.equal(isoSeconds("nonsense"), null);
});

test("a picture address that is not the web's is dropped", () => {
  assert.equal(readHead(`<meta property="og:image" content="javascript:alert(1)">`, "https://a.ru/").image, null);
  assert.equal(readHead(`<meta property="og:image" content="data:image/png;base64,AAAA">`, "https://a.ru/").image, null);
});

test("a stranger's text loses what could reverse or hide it, and is cut", () => {
  assert.equal(cleanText("evil‮gnp.exe", 100), "evil gnp.exe");
  assert.equal(cleanText("a\u0000b\nc\t d", 100), "a b c d");
  assert.equal(cleanText("x".repeat(10), 5), "xxxx…");
  assert.equal(cleanText("&#1055;&#x440;&#x438;вет &amp; &unknown;", 100), "Привет & &unknown;");
});

test("a page in windows-1251 reads right, by its header or by its own meta", () => {
  // "Привет" in windows-1251.
  const body = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  assert.equal(decodePage(body, "text/html; charset=windows-1251"), "Привет");
  const withMeta = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1251"><title>'), ...body]);
  assert.ok(decodePage(withMeta, "text/html").endsWith("Привет"));
  assert.equal(decodePage(new TextEncoder().encode("Привет"), "text/html"), "Привет");
});

test("a host is shown in its own letters unless they could pass for another's", () => {
  assert.equal(punycodeLabel("xn--e1afmkfd"), "пример");
  assert.equal(shownHost("https://xn--e1afmkfd.xn--p1ai/"), "пример.рф");
  assert.equal(shownHost("https://www.habr.com/ru/"), "habr.com");
  // A Cyrillic а in front of Latin letters.
  assert.equal(shownHost("https://xn--pple-43d.com/"), "xn--pple-43d.com");
  // All Cyrillic, every letter one that reads as Latin, under .com.
  assert.equal(shownHost("https://xn--80ak6aa92e.com/"), "xn--80ak6aa92e.com");
  assert.equal(shownHost("https://xn--d1acpjx3f.xn--p1ai/"), "яндекс.рф");
});

test("a picture's size comes from its first bytes", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0x2c]);
  assert.deepEqual(pictureSize(png), { type: "image/png", width: 512, height: 300 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
  assert.deepEqual(pictureSize(gif), { type: "image/gif", width: 320, height: 240 });
  // A JPEG: start, an APP0 of 16 bytes, then a baseline frame of 640×480.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
  assert.deepEqual(pictureSize(jpeg), { type: "image/jpeg", width: 640, height: 480 });
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
  webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24);
  assert.deepEqual(pictureSize(webp), { type: "image/webp", width: 800, height: 600 });
  assert.equal(pictureSize(new TextEncoder().encode("<html>")), null);
  assert.ok(pictureFits({ width: 4096, height: 1000 }));
  assert.ok(!pictureFits({ width: 30000, height: 30000 }));
});

test("a file is named by its server, else by its address", () => {
  assert.deepEqual(fileOf("https://github.com/x/releases/download/v1/companion-ble-v1.17.1.uf2", null, "application/octet-stream", 3_250_000), { name: "companion-ble-v1.17.1.uf2", size: 3_250_000, mark: "UF2" });
  assert.equal(fileOf("https://a.ru/get?id=5", 'attachment; filename="схема.pdf"', "application/pdf", null).name, "схема.pdf");
  assert.equal(fileOf("https://a.ru/get?id=5", "attachment; filename*=UTF-8''%D1%81%D1%85%D0%B5%D0%BC%D0%B0.pdf", "application/pdf", null).name, "схема.pdf");
  assert.equal(fileOf("https://a.ru/get", null, "application/zip", null).mark, "ZIP");
  assert.equal(fileOf("https://a.ru/", 'attachment; filename="../../etc/passwd"', "text/plain", null).name, "passwd");
});
