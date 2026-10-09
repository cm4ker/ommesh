import { test } from "node:test";
import assert from "node:assert/strict";
import { durationLabel, linkAllowed } from "./linkPreviewParse.js";

test("a preview is asked only for the open web, on its own ports", () => {
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

test("a video's length reads as a clock", () => {
  assert.equal(durationLabel(767), "12:47");
  assert.equal(durationLabel(3723), "1:02:03");
});
