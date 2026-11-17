import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../i18n/index.js";
import { ATTACH_DEFAULTS, attachmentsReady, keyFor, linkFor, parseServer, presignPut, publicBase, regionFor, regionFrom, regionFromServer, sizeText, type AttachmentsSettings } from "./attachments.js";

const SETTINGS: AttachmentsSettings = {
  ...ATTACH_DEFAULTS,
  server: "https://s3.example.ru/ommesh",
  accessKey: "OMSHK7Q2XW4",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const AT = new Date("2026-11-17T05:10:00Z");

test("one address names the endpoint and the bucket, and nothing else is asked", () => {
  assert.deepEqual(parseServer("https://s3.example.ru/ommesh"), { endpoint: "https://s3.example.ru", bucket: "ommesh" });
  // A trailing slash, a path below the bucket or a port change nothing.
  assert.deepEqual(parseServer(" http://localhost:9000/files/ "), { endpoint: "http://localhost:9000", bucket: "files" });
  assert.deepEqual(parseServer("https://preview.example.ru/files/p/6f3a91c2.jpg"), { endpoint: "https://preview.example.ru", bucket: "files" });
  // An address without a bucket is not an address for a photo.
  assert.equal(parseServer("https://s3.example.ru"), null);
  assert.equal(parseServer("https://s3.example.ru/AB"), null);
  assert.equal(parseServer("s3.example.ru/ommesh"), null);
  assert.equal(parseServer(""), null);
});

test("attachments wait for the address and both keys", () => {
  assert.equal(attachmentsReady(), false);
  assert.equal(attachmentsReady(SETTINGS), true);
  assert.equal(attachmentsReady({ ...SETTINGS, server: "https://s3.example.ru" }), false);
  assert.equal(attachmentsReady({ ...SETTINGS, secretKey: "" }), false);
});

test("the link is the endpoint's bucket path and a two-part key, short enough for a message", () => {
  assert.equal(publicBase(SETTINGS), "https://s3.example.ru/ommesh");
  assert.equal(linkFor("p/6f3a91c2.jpg", SETTINGS), "https://s3.example.ru/ommesh/p/6f3a91c2.jpg");
  // 158 bytes is what a direct message may carry: the link leaves room for a word or two.
  assert.ok(linkFor("p/6f3a91c2.jpg", { ...SETTINGS, server: "https://i.example.ru/photos" }).length < 60);
});

test("a key says what kind of thing it is and carries no name of the reader's", () => {
  assert.match(keyFor("photo", "тропа.jpg", "image/jpeg"), /^p\/[0-9a-f]{8}\.jpg$/);
  assert.match(keyFor("photo", "снимок.png", "image/png"), /^p\/[0-9a-f]{8}\.png$/);
  assert.match(keyFor("file", "Договор аренды.pdf", "application/pdf"), /^f\/[0-9a-f]{8}\.pdf$/);
  assert.match(keyFor("file", "archive", ""), /^f\/[0-9a-f]{8}\.bin$/);
  // Two uploads of the same name never share a key.
  assert.notEqual(keyFor("photo", "тропа.jpg"), keyFor("photo", "тропа.jpg"));
});

test("a presigned put names the bucket in the path and signs the host, and never the secret", async () => {
  const url = await presignPut(SETTINGS, "p/6f3a91c2.jpg", AT);
  assert.match(url, /^https:\/\/s3\.example\.ru\/ommesh\/p\/6f3a91c2\.jpg\?/);
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Credential=OMSHK7Q2XW4%2F20261117%2Fus-east-1%2Fs3%2Faws4_request/);
  assert.match(url, /X-Amz-Date=20261117T051000Z/);
  assert.match(url, /X-Amz-Expires=900/);
  assert.match(url, /X-Amz-SignedHeaders=host/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}$/);
  // The secret signs and stays home: nothing in the address says it.
  assert.equal(url.includes(SETTINGS.secretKey), false);
});

test("a region the storage named is the one signed for, and the same moment and key sign the same", async () => {
  const other = await presignPut({ ...SETTINGS, region: "eu-central-1" }, "p/1.jpg", AT);
  assert.match(other, /X-Amz-Credential=[^&]*%2Feu-central-1%2Fs3%2Faws4_request/);
  assert.equal(await presignPut(SETTINGS, "p/1.jpg", AT), await presignPut(SETTINGS, "p/1.jpg", AT));
  assert.notEqual(await presignPut(SETTINGS, "p/1.jpg", AT), await presignPut(SETTINGS, "p/2.jpg", AT));
});

test("the region a regional address names is the one signed for", async () => {
  // Selectel puts its region in the host, and refusing a signature for another one is how it answers.
  assert.equal(regionFromServer("https://s3.ru-6.storage.selcloud.ru/ommesh"), "ru-6");
  assert.equal(regionFromServer("https://s3.eu-central-1.amazonaws.com/photos"), "eu-central-1");
  assert.equal(regionFromServer("https://bucket.r2.cloudflarestorage.com/photos"), "auto");
  assert.equal(regionFromServer("https://storage.yandexcloud.net/photos"), "ru-central1");
  assert.equal(regionFromServer("https://s3.example.ru/photos"), null);
  const signed = await presignPut({ ...SETTINGS, server: "https://s3.ru-6.storage.selcloud.ru/ommesh" }, "p/1.jpg", AT);
  assert.match(signed, /X-Amz-Credential=[^&]*%2Fru-6%2Fs3%2Faws4_request/);
  // What a storage told once wins over what its address says.
  assert.equal(regionFor({ server: "https://s3.ru-6.storage.selcloud.ru/ommesh", accessKey: "k", secretKey: "s", region: "us-east-1" }), "us-east-1");
});

test("a refusal names the region it wants, and only a plain name is taken", () => {
  assert.equal(regionFrom("<Error><Code>AuthorizationHeaderMalformed</Code><Region>eu-central-1</Region></Error>", null), "eu-central-1");
  assert.equal(regionFrom("", "auto"), "auto");
  assert.equal(regionFrom("no region here", null), null);
  assert.equal(regionFrom("<Region>two words</Region>", null), null);
});

test("a size follows the app's language and the reader's decimal mark", () => {
  // Both halves are read while drawing: the number ours, the words i18n's.
  assert.equal(sizeText(900), t("chats.preview.kb", { size: "1" }));
  assert.equal(sizeText(2_400_000), t("chats.preview.mb", { size: "2.3" }));
});

