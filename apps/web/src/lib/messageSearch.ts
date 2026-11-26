/**
 * Finding words in messages (#42, #137): in every chat from the field over the
 * chat list, in one chat from its own field. Case and ё aside, so "мост" finds
 * "Моста".
 *
 * For histories past `INDEX_THRESHOLD` messages, an in-memory inverted index of
 * 2- and 3-code-unit grams (partitioned by large conversations, with posting
 * lists kept in ascending `placedAt` order) makes lookup time scale with the
 * query's match set rather than the full history size, and eliminates per-query
 * sorting. Incremental updates keep the index current in O(delta) as messages
 * arrive, and idle chunked warming removes the cold-start pause on the first
 * keystroke.
 */

import type { MessageRecord } from "@meshnet/meshcore";
import { placedAt } from "./conversations.js";
import { asCyrillic, TWINS } from "./lookalikes.js";

/** A shorter query finds too much to be of use; two code units still let one emoji through. */
export const MIN_QUERY = 2;

// Russian goes out with its Latin lookalikes (lookalikes.ts), from this app and from others, so
// a Cyrillic letter and its twin are read as the twin: "мост" finds "Mocт". A capital's twin
// counts for its small letter too, as В goes out as B and so в is read as b.
const SAME: Record<string, string> = { ё: "e" };
for (const [cyrillic, latin] of Object.entries(TWINS)) SAME[cyrillic.toLowerCase()] = latin.toLowerCase();

// Flat BMP lookup table covering ASCII, Latin Extended and Cyrillic (0x0000..0x04FF).
// Any character whose `.toLowerCase()` changes UTF-16 length (such as İ) stays untouched so
// indices in the folded text stay 1-to-1 with indices in the original text.
const TABLE_LEN = 0x0500;
const FOLD_TABLE = new Uint16Array(TABLE_LEN);
// Compact 10-bit ids (1..<1024) for every distinct folded code unit < 0x0500, so 3-gram keys
// fit in positive 30-bit V8 SMIs with zero HeapNumber allocations. ASCII and Russian Cyrillic
// get ids 1..127 first so every common 2-gram indexes directly into a flat 128x128 array.
const FLAT_ALPHA = 128;
const FLAT_SIZE = FLAT_ALPHA * FLAT_ALPHA;
const GRAM_ID = new Uint16Array(TABLE_LEN);
{
  const seen = new Map<number, number>();
  let nextId = 1;
  const register = (code: number) => {
    let id = seen.get(code);
    if (id === undefined) {
      id = nextId++;
      seen.set(code, id);
    }
    GRAM_ID[code] = id;
  };
  for (let c = 0; c < TABLE_LEN; c++) {
    const ch = String.fromCharCode(c);
    const low = ch.toLowerCase();
    const mapped = low.length === 1 ? (SAME[low] ?? low) : ch;
    FOLD_TABLE[c] = mapped.charCodeAt(0);
  }
  // Assign ids < 128 to ASCII + standard Russian Cyrillic first.
  for (let c = 0; c < 0x0080; c++) register(FOLD_TABLE[c]!);
  for (let c = 0x0410; c <= 0x0451; c++) register(FOLD_TABLE[c]!);
  for (let c = 0; c < TABLE_LEN; c++) register(FOLD_TABLE[c]!);
}

function flatBigramSlot(c0: number, c1: number): number {
  if (c0 < TABLE_LEN && c1 < TABLE_LEN) {
    const id0 = GRAM_ID[c0]!;
    const id1 = GRAM_ID[c1]!;
    if (id0 < FLAT_ALPHA && id1 < FLAT_ALPHA) return (id0 << 7) | id1;
  }
  return -1;
}

function extraBigramKey(c0: number, c1: number): number {
  return c0 * 65536 + c1;
}

function trigramKey(c0: number, c1: number, c2: number): number {
  if (c0 < TABLE_LEN && c1 < TABLE_LEN && c2 < TABLE_LEN) return (GRAM_ID[c0]! << 20) | (GRAM_ID[c1]! << 10) | GRAM_ID[c2]!;
  return -(c0 * 4294967296 + c1 * 65536 + c2 + 1);
}

const SCRATCH_LEN = 4096;
const FOLD_SCRATCH = new Uint16Array(SCRATCH_LEN);

function codesToString(codes: Uint16Array, len: number): string {
  if (len <= 512) return String.fromCharCode.apply(null, codes.subarray(0, len) as unknown as number[]);
  let out = "";
  for (let i = 0; i < len; i += 512) {
    out += String.fromCharCode.apply(null, codes.subarray(i, Math.min(len, i + 512)) as unknown as number[]);
  }
  return out;
}

/**
 * Every EXACT and NEAR Latin twin already maps to the same folded ASCII letter as its Cyrillic
 * counterpart; only the three CURSIVE twins (`m`->`т`->`t`, `n`->`п`, `u`->`и`) can change `fold()`
 * output after `asCyrillic()`, and only when Cyrillic is also present in the string.
 */
function needsCyrillicReadback(text: string): boolean {
  let hasCyr = false;
  let hasCursive = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x6d || c === 0x6e || c === 0x75) hasCursive = true;
    else if (c >= 0x0400 && ((c <= 0x052f) || (c >= 0x1c80 && c <= 0x1c8f) || (c >= 0x2de0 && c <= 0x2dff) || (c >= 0xa640 && c <= 0xa69f))) hasCyr = true;
    if (hasCyr && hasCursive) return true;
  }
  return false;
}

/**
 * Lower case, ё as е, a lookalike as its Latin twin; letter for letter, so a
 * place in the result is the same place in the text. Latin twins among Cyrillic
 * letters are read back first, so "три" finds "mpu" in "чepeз mpu дня".
 */
export function fold(text: string): string {
  const src = needsCyrillicReadback(text) ? asCyrillic(text) : text;
  const len = src.length;
  if (len === 0) return "";
  if (len <= SCRATCH_LEN) {
    let changed = false;
    let i = 0;
    for (; i < len; i++) {
      const code = src.charCodeAt(i);
      if (code >= TABLE_LEN) break;
      const mapped = FOLD_TABLE[code]!;
      FOLD_SCRATCH[i] = mapped;
      if (mapped !== code) changed = true;
    }
    if (i === len) return changed ? codesToString(FOLD_SCRATCH, len) : src;
    // Rare path: text contains characters past 0x04FF (emoji, symbols, other scripts).
    let out = i > 0 ? (changed ? codesToString(FOLD_SCRATCH, i) : src.slice(0, i)) : "";
    for (; i < len; i++) {
      const code = src.charCodeAt(i);
      if (code < TABLE_LEN) {
        out += String.fromCharCode(FOLD_TABLE[code]!);
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        const lowCode = src.charCodeAt(i + 1);
        if (lowCode >= 0xdc00 && lowCode <= 0xdfff) {
          const pair = src.slice(i, i + 2);
          const low = pair.toLowerCase();
          out += low.length === 2 ? low : pair;
          i++;
          continue;
        }
        out += src[i]!;
      } else {
        const ch = src[i]!;
        const low = ch.toLowerCase();
        out += low.length === 1 ? (SAME[low] ?? low) : ch;
      }
    }
    return out;
  }
  let out = "";
  for (const ch of src) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? (SAME[low] ?? low) : ch;
  }
  return out;
}

let cachedQueryRaw: string | null = null;
let cachedQueryTerm: string | null = null;

/** The query as it is matched, or null while it is too short to search. */
export function searchTerm(query: string): string | null {
  if (query === cachedQueryRaw) return cachedQueryTerm;
  const q = fold(query.trim());
  const term = q.length >= MIN_QUERY ? q : null;
  cachedQueryRaw = query;
  cachedQueryTerm = term;
  return term;
}

// A record is replaced, never changed, when anything about the message changes.
const foldedCache = new WeakMap<MessageRecord, string>();
function foldedText(m: MessageRecord): string {
  let text = foldedCache.get(m);
  if (text === undefined) {
    text = fold(m.text);
    foldedCache.set(m, text);
  }
  return text;
}

// ---- sub-linear partitioned n-gram index ----

/** Below this size a direct scan over cached folded texts finishes in under 0.1 ms. */
const INDEX_THRESHOLD = 512;
/** Conversations with at least this many messages get a dedicated bucket so in-chat search stays isolated. */
const BUCKET_SPLIT = 256;
/** Rebuild a bucket once tombstones or out-of-order appends exceed these bounds. */
const MAX_DEAD = 128;
const MAX_OUT_OF_ORDER = 64;
/** Time budget per background idle warming slice, ms. */
const WARM_BUDGET_MS = 6;
const WARM_MIN_BATCH = 128;

const EMPTY_IDS: readonly number[] = [];

interface Bucket {
  /** Conversation id for a dedicated bucket, or null for the shared small-chats bucket. */
  conversation: string | null;
  /** Messages in ascending `placedAt` order (aside from rare `outOfOrder` tail entries). */
  docs: MessageRecord[];
  /** Parallel folded texts for docs `0 .. indexed - 1`. */
  folded: string[];
  /** Number of leading docs already indexed into `bigrams`, `trigrams` and `bySender`. */
  indexed: number;
  /** Largest `placedAt` among in-order docs so far. */
  maxPlacedAt: number;
  /** Flat 128x128 posting table for common ASCII/Cyrillic 2-grams, docIds strictly ascending. */
  bigrams: (number[] | undefined)[];
  /** Overflow posting map for 2-grams containing emoji or characters past the flat table. */
  extraBigrams: Map<number, number[]>;
  /** Posting lists keyed by packed 3-gram SMI/negative key, docIds strictly ascending. */
  trigrams: Map<number, number[]>;
  /** Posting lists keyed by `"in:<sender>"` or `"out:<sender>"`, docIds strictly ascending. */
  bySender: Map<string, number[]>;
  /** Tombstoned docIds (deleted or re-inserted after a retry/text change). */
  dead: Set<number> | null;
  /** Rare docIds appended with `placedAt < maxPlacedAt`. */
  outOfOrder: Set<number> | null;
  /** 1-entry cache for incremental typing (`q` extending `lastQuery.q`). */
  lastQuery: { q: string; ids: readonly number[] } | null;
  /** Cached excluded docIds for a given filter token (used when senders are blocked). */
  hiddenCache: { key: object; ids: Set<number> } | null;
}

interface SearchIndex {
  source: readonly MessageRecord[];
  small: Bucket;
  convBuckets: Map<string, Bucket>;
  allBuckets: Bucket[];
  byId: Map<string, { bucket: Bucket; docId: number }>;
  /** Monotonically incremented whenever a bucket mutates, invalidating per-query caches. */
  version: number;
}

function createBucket(conversation: string | null, docs: MessageRecord[]): Bucket {
  const n = docs.length;
  return {
    conversation,
    docs,
    folded: new Array<string>(n),
    indexed: 0,
    maxPlacedAt: n > 0 ? placedAt(docs[n - 1]!) : -Infinity,
    bigrams: new Array<number[] | undefined>(FLAT_SIZE),
    extraBigrams: new Map(),
    trigrams: new Map(),
    bySender: new Map(),
    dead: null,
    outOfOrder: null,
    lastQuery: null,
    hiddenCache: null,
  };
}

function pushBigram(bucket: Bucket, c0: number, c1: number, docId: number): void {
  const slot = flatBigramSlot(c0, c1);
  if (slot >= 0) {
    const list = bucket.bigrams[slot];
    if (list === undefined) bucket.bigrams[slot] = [docId];
    else if (list[list.length - 1] !== docId) list.push(docId);
    return;
  }
  const key = extraBigramKey(c0, c1);
  const list = bucket.extraBigrams.get(key);
  if (list === undefined) bucket.extraBigrams.set(key, [docId]);
  else if (list[list.length - 1] !== docId) list.push(docId);
}

function getBigram(bucket: Bucket, c0: number, c1: number): number[] | undefined {
  const slot = flatBigramSlot(c0, c1);
  return slot >= 0 ? bucket.bigrams[slot] : bucket.extraBigrams.get(extraBigramKey(c0, c1));
}

function indexDoc(bucket: Bucket, docId: number): void {
  const m = bucket.docs[docId]!;
  const s = foldedText(m);
  bucket.folded[docId] = s;

  if (m.sender !== null) {
    const sk = `${m.direction === "out" ? "out" : "in"}:${m.sender}`;
    const slist = bucket.bySender.get(sk);
    if (slist === undefined) bucket.bySender.set(sk, [docId]);
    else slist.push(docId);
  }

  const len = s.length;
  if (len < 2) return;

  const { trigrams } = bucket;
  let c0 = s.charCodeAt(0);
  let c1 = s.charCodeAt(1);
  pushBigram(bucket, c0, c1, docId);

  for (let i = 2; i < len; i++) {
    const c2 = s.charCodeAt(i);
    pushBigram(bucket, c1, c2, docId);

    const tgKey = trigramKey(c0, c1, c2);
    const list = trigrams.get(tgKey);
    if (list === undefined) trigrams.set(tgKey, [docId]);
    else if (list[list.length - 1] !== docId) list.push(docId);

    c0 = c1;
    c1 = c2;
  }
}

function finishBucket(bucket: Bucket): void {
  const n = bucket.docs.length;
  for (let i = bucket.indexed; i < n; i++) indexDoc(bucket, i);
  bucket.indexed = n;
}

function finishIndex(index: SearchIndex): void {
  for (let i = 0; i < index.allBuckets.length; i++) finishBucket(index.allBuckets[i]!);
}

/** Sorts docs ascending by `placedAt`; equal timestamps keep reverse-input order so reading backwards matches stable descending sort. */
function sortDocsAscending(entries: { m: MessageRecord; order: number }[]): MessageRecord[] {
  // Most real histories are already in chronological order: check in O(N) before invoking sort.
  let sorted = true;
  for (let i = 1; i < entries.length; i++) {
    const prev = placedAt(entries[i - 1]!.m);
    const cur = placedAt(entries[i]!.m);
    if (cur < prev || cur === prev) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    entries.sort((a, b) => placedAt(a.m) - placedAt(b.m) || b.order - a.order);
  }
  const docs = new Array<MessageRecord>(entries.length);
  for (let i = 0; i < entries.length; i++) docs[i] = entries[i]!.m;
  return docs;
}

function buildIndex(messages: readonly MessageRecord[]): SearchIndex {
  const byConv = new Map<string, { m: MessageRecord; order: number }[]>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    let arr = byConv.get(m.conversation);
    if (arr === undefined) {
      arr = [];
      byConv.set(m.conversation, arr);
    }
    arr.push({ m, order: i });
  }

  const smallEntries: { m: MessageRecord; order: number }[] = [];
  const convBuckets = new Map<string, Bucket>();
  const allBuckets: Bucket[] = [];
  const byId = new Map<string, { bucket: Bucket; docId: number }>();

  for (const [conv, entries] of byConv) {
    if (entries.length >= BUCKET_SPLIT) {
      const docs = sortDocsAscending(entries);
      const bucket = createBucket(conv, docs);
      convBuckets.set(conv, bucket);
      allBuckets.push(bucket);
      for (let i = 0; i < docs.length; i++) byId.set(docs[i]!.id, { bucket, docId: i });
    } else {
      for (let i = 0; i < entries.length; i++) smallEntries.push(entries[i]!);
    }
  }

  const smallDocs = sortDocsAscending(smallEntries);
  const small = createBucket(null, smallDocs);
  for (let i = 0; i < smallDocs.length; i++) byId.set(smallDocs[i]!.id, { bucket: small, docId: i });
  if (smallDocs.length > 0 || allBuckets.length === 0) allBuckets.push(small);

  return { source: messages, small, convBuckets, allBuckets, byId, version: 1 };
}

function rebuildBucket(index: SearchIndex, bucket: Bucket): void {
  const live: { m: MessageRecord; order: number }[] = [];
  for (let i = 0; i < bucket.docs.length; i++) {
    if (bucket.dead?.has(i)) continue;
    live.push({ m: bucket.docs[i]!, order: i });
  }
  const docs = sortDocsAscending(live);
  bucket.docs = docs;
  bucket.folded = new Array<string>(docs.length);
  bucket.indexed = 0;
  bucket.maxPlacedAt = docs.length > 0 ? placedAt(docs[docs.length - 1]!) : -Infinity;
  bucket.bigrams = new Array<number[] | undefined>(FLAT_SIZE);
  bucket.extraBigrams.clear();
  bucket.trigrams.clear();
  bucket.bySender.clear();
  bucket.dead = null;
  bucket.outOfOrder = null;
  bucket.lastQuery = null;
  bucket.hiddenCache = null;
  for (let i = 0; i < docs.length; i++) index.byId.set(docs[i]!.id, { bucket, docId: i });
}

function appendToIndex(index: SearchIndex, m: MessageRecord): void {
  const bucket = index.convBuckets.get(m.conversation) ?? index.small;
  if (bucket === index.small && !index.allBuckets.includes(index.small)) index.allBuckets.push(index.small);
  const docId = bucket.docs.length;
  const at = placedAt(m);
  bucket.docs.push(m);
  bucket.folded.push("");
  if (at < bucket.maxPlacedAt) {
    bucket.outOfOrder ??= new Set();
    bucket.outOfOrder.add(docId);
  } else {
    bucket.maxPlacedAt = at;
  }
  index.byId.set(m.id, { bucket, docId });
  if (bucket.indexed === docId) {
    indexDoc(bucket, docId);
    bucket.indexed = docId + 1;
  }
  bucket.lastQuery = null;
  bucket.hiddenCache = null;
  if (bucket.outOfOrder && bucket.outOfOrder.size > MAX_OUT_OF_ORDER) rebuildBucket(index, bucket);
}

function tombstoneInIndex(index: SearchIndex, id: string): void {
  const loc = index.byId.get(id);
  if (!loc) return;
  index.byId.delete(id);
  const { bucket, docId } = loc;
  bucket.dead ??= new Set();
  bucket.dead.add(docId);
  bucket.lastQuery = null;
  bucket.hiddenCache = null;
  if (bucket.dead.size > MAX_DEAD && bucket.dead.size * 6 > bucket.docs.length) rebuildBucket(index, bucket);
}

/**
 * Attempts to evolve `index` in O(delta) when `messages` is an append, small in-place update,
 * or small deletion of `index.source`. Returns true if updated in place.
 */
function trySyncIndex(index: SearchIndex, messages: readonly MessageRecord[]): boolean {
  const prev = index.source;
  const prevLen = prev.length;
  const nextLen = messages.length;

  // Case 1: Pure append (or identical prefix + a few updates) when length grew or stayed equal.
  if (nextLen >= prevLen) {
    const changed: number[] = [];
    for (let i = 0; i < prevLen; i++) {
      if (messages[i] !== prev[i]) {
        changed.push(i);
        if (changed.length > 32) return false;
      }
    }
    // Verify changed positions keep the same id (status/echo/reaction/retry updates).
    for (let k = 0; k < changed.length; k++) {
      const idx = changed[k]!;
      if (messages[idx]!.id !== prev[idx]!.id) return false;
    }
    for (let k = 0; k < changed.length; k++) {
      const idx = changed[k]!;
      const oldM = prev[idx]!;
      const newM = messages[idx]!;
      const loc = index.byId.get(oldM.id);
      if (!loc) return false;
      if (
        oldM.text === newM.text &&
        oldM.conversation === newM.conversation &&
        oldM.sender === newM.sender &&
        oldM.direction === newM.direction &&
        placedAt(oldM) === placedAt(newM)
      ) {
        loc.bucket.docs[loc.docId] = newM;
      } else {
        tombstoneInIndex(index, oldM.id);
        appendToIndex(index, newM);
      }
    }
    for (let i = prevLen; i < nextLen; i++) appendToIndex(index, messages[i]!);
    index.source = messages;
    index.version++;
    return true;
  }

  // Case 2: Small deletion (e.g. deleting a few picked messages).
  const dropped = prevLen - nextLen;
  if (dropped <= 64) {
    const removed: MessageRecord[] = [];
    let j = 0;
    for (let i = 0; i < prevLen; i++) {
      if (j < nextLen && messages[j] === prev[i]) {
        j++;
      } else {
        removed.push(prev[i]!);
        if (removed.length > dropped) return false;
      }
    }
    if (j !== nextLen) return false;
    for (let i = 0; i < removed.length; i++) tombstoneInIndex(index, removed[i]!.id);
    index.source = messages;
    index.version++;
    return true;
  }

  return false;
}

const indexByArray = new WeakMap<readonly MessageRecord[], SearchIndex>();
let activeIndex: SearchIndex | null = null;

function acquireIndex(messages: readonly MessageRecord[]): SearchIndex {
  const hit = indexByArray.get(messages);
  if (hit) return hit;
  if (activeIndex) {
    const oldSource = activeIndex.source;
    if (trySyncIndex(activeIndex, messages)) {
      indexByArray.delete(oldSource);
      indexByArray.set(messages, activeIndex);
      return activeIndex;
    }
  }
  const created = buildIndex(messages);
  indexByArray.set(messages, created);
  // Keep the primary (largest) session index as activeIndex so a query on a smaller
  // derived subset array does not evict incremental tracking for `state.messages`.
  if (!activeIndex || messages.length >= activeIndex.source.length) activeIndex = created;
  return created;
}

// ---- background chunked warming ----

let warmTimer: ReturnType<typeof setTimeout> | null = null;
let warmRaf: number | null = null;
let warmingIndex: SearchIndex | null = null;

function inputPending(): boolean {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }) : undefined;
  return nav?.scheduling?.isInputPending?.() ?? false;
}

function cancelWarm(): void {
  if (warmRaf !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(warmRaf);
    warmRaf = null;
  }
  if (warmTimer !== null) {
    clearTimeout(warmTimer);
    warmTimer = null;
  }
}

function runWarmSlice(): void {
  warmTimer = null;
  const idx = warmingIndex;
  if (!idx) return;
  const start = performance.now();
  for (let b = 0; b < idx.allBuckets.length; b++) {
    const bucket = idx.allBuckets[b]!;
    const n = bucket.docs.length;
    while (bucket.indexed < n) {
      const end = Math.min(n, bucket.indexed + WARM_MIN_BATCH);
      for (let i = bucket.indexed; i < end; i++) indexDoc(bucket, i);
      bucket.indexed = end;
      if (performance.now() - start >= WARM_BUDGET_MS || inputPending()) {
        // Yield to the macrotask queue so touches, keystrokes and paints run immediately,
        // without waiting on Android WebView's 250 ms requestIdleCallback throttle.
        warmTimer = setTimeout(runWarmSlice, 0);
        return;
      }
    }
  }
  warmingIndex = null;
}

function scheduleWarmStep(afterPaint: boolean): void {
  if (warmTimer !== null || warmRaf !== null || !warmingIndex) return;
  if (afterPaint && typeof requestAnimationFrame === "function") {
    warmRaf = requestAnimationFrame(() => {
      warmRaf = null;
      if (warmingIndex) warmTimer = setTimeout(runWarmSlice, 0);
    });
  } else {
    warmTimer = setTimeout(runWarmSlice, 0);
  }
}

/**
 * Warms the search index for `messages` in short ~6 ms slices (preempted
 * immediately when input is pending) right after the current frame paints, so
 * the first keystroke in the search box never stalls.
 */
export function warmMessageIndex(messages: readonly MessageRecord[]): () => void {
  if (messages.length <= INDEX_THRESHOLD) {
    cancelWarm();
    warmingIndex = null;
    return () => undefined;
  }
  const index = acquireIndex(messages);
  const needsWork = index.allBuckets.some((b) => b.indexed < b.docs.length);
  if (!needsWork) {
    cancelWarm();
    warmingIndex = null;
    return () => undefined;
  }
  warmingIndex = index;
  scheduleWarmStep(true);
  return () => {
    if (warmingIndex === index) {
      cancelWarm();
      warmingIndex = null;
    }
  };
}

// ---- bucket query engine ----

function cleanIds(bucket: Bucket, raw: readonly number[]): readonly number[] {
  const { dead, outOfOrder } = bucket;
  if (!dead && !outOfOrder) return raw;
  const out: number[] = [];
  let needsSort = false;
  for (let i = 0; i < raw.length; i++) {
    const id = raw[i]!;
    if (dead?.has(id)) continue;
    if (outOfOrder?.has(id)) needsSort = true;
    out.push(id);
  }
  if (needsSort) {
    const docs = bucket.docs;
    out.sort((a, b) => placedAt(docs[a]!) - placedAt(docs[b]!) || b - a);
  }
  return out;
}

/**
 * Returns docIds matching folded query `q` (length >= 2) in ascending `placedAt`
 * order. For length 2 and 3 the posting list is already exact, avoiding both
 * substring verification and array copying in the common case.
 */
function queryBucket(bucket: Bucket, q: string): readonly number[] {
  finishBucket(bucket);
  const qLen = q.length;
  if (qLen === 2) {
    const posting = getBigram(bucket, q.charCodeAt(0), q.charCodeAt(1));
    return posting ? cleanIds(bucket, posting) : EMPTY_IDS;
  }
  if (qLen === 3) {
    const posting = bucket.trigrams.get(trigramKey(q.charCodeAt(0), q.charCodeAt(1), q.charCodeAt(2)));
    return posting ? cleanIds(bucket, posting) : EMPTY_IDS;
  }
  if (bucket.lastQuery && bucket.lastQuery.q === q) return bucket.lastQuery.ids;

  // Length >= 4: every trigram of `q` must appear in a matching doc; pick the rarest posting list.
  const { trigrams } = bucket;
  let minList: readonly number[] | undefined;
  let c0 = q.charCodeAt(0);
  let c1 = q.charCodeAt(1);
  for (let i = 2; i < qLen; i++) {
    const c2 = q.charCodeAt(i);
    const posting = trigrams.get(trigramKey(c0, c1, c2));
    if (posting === undefined) {
      bucket.lastQuery = { q, ids: EMPTY_IDS };
      return EMPTY_IDS;
    }
    if (minList === undefined || posting.length < minList.length) minList = posting;
    c0 = c1;
    c1 = c2;
  }
  if (!minList) return EMPTY_IDS;

  // Incremental typing: extending the previous query can only narrow its match set.
  let candidates: readonly number[] = minList;
  if (bucket.lastQuery && q.includes(bucket.lastQuery.q) && bucket.lastQuery.ids.length < candidates.length) {
    candidates = bucket.lastQuery.ids;
  }

  const { folded, dead, outOfOrder, docs } = bucket;
  const out: number[] = [];
  let needsSort = false;
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i]!;
    if (dead?.has(id)) continue;
    if (folded[id]!.includes(q)) {
      if (outOfOrder?.has(id)) needsSort = true;
      out.push(id);
    }
  }
  if (needsSort) out.sort((a, b) => placedAt(docs[a]!) - placedAt(docs[b]!) || b - a);
  bucket.lastQuery = { q, ids: out };
  return out;
}

function hiddenSetForBucket(bucket: Bucket, filterKey: object, exclude: (m: MessageRecord) => boolean): Set<number> {
  if (bucket.hiddenCache && bucket.hiddenCache.key === filterKey) return bucket.hiddenCache.ids;
  const ids = new Set<number>();
  const { docs, dead } = bucket;
  for (let i = 0; i < docs.length; i++) {
    if (dead?.has(i)) continue;
    if (exclude(docs[i]!)) ids.add(i);
  }
  bucket.hiddenCache = { key: filterKey, ids };
  return ids;
}

// ---- public query APIs ----

/** Paged global search result: exact total count and the newest `limit` matches. */
export interface SearchPage {
  total: number;
  items: MessageRecord[];
}

/**
 * Finds the newest `limit` messages matching `query`, together with the total
 * match count, without sorting or materialising all matches. Pass `exclude` and
 * a cache `filterKey` (such as the current blocks snapshot) only when messages
 * can be hidden.
 */
export function searchMessagePage(
  messages: readonly MessageRecord[],
  query: string,
  limit: number,
  exclude?: (m: MessageRecord) => boolean,
  filterKey?: object,
): SearchPage {
  const q = searchTerm(query);
  if (!q || messages.length === 0) return { total: 0, items: [] };

  if (messages.length <= INDEX_THRESHOLD) {
    const matched: MessageRecord[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if ((!exclude || !exclude(m)) && foldedText(m).includes(q)) matched.push(m);
    }
    matched.sort((a, b) => placedAt(b) - placedAt(a));
    return { total: matched.length, items: matched.slice(0, limit) };
  }

  const index = acquireIndex(messages);
  finishIndex(index);

  interface Cursor {
    bucket: Bucket;
    ids: readonly number[];
    pos: number;
    at: number;
    hidden: Set<number> | null;
  }

  const cursors: Cursor[] = [];
  let total = 0;

  for (let b = 0; b < index.allBuckets.length; b++) {
    const bucket = index.allBuckets[b]!;
    const ids = queryBucket(bucket, q);
    if (ids.length === 0) continue;

    let hidden: Set<number> | null = null;
    let count = ids.length;
    if (exclude) {
      if (filterKey) {
        hidden = hiddenSetForBucket(bucket, filterKey, exclude);
        if (hidden.size === 0) {
          hidden = null;
        } else if (hidden.size * 4 < ids.length) {
          let excluded = 0;
          for (const h of hidden) if (bucket.folded[h]!.includes(q)) excluded++;
          count -= excluded;
        } else {
          let visible = 0;
          for (let i = 0; i < ids.length; i++) if (!hidden.has(ids[i]!)) visible++;
          count = visible;
        }
      } else {
        const set = new Set<number>();
        let visible = 0;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          if (exclude(bucket.docs[id]!)) set.add(id);
          else visible++;
        }
        if (set.size > 0) hidden = set;
        count = visible;
      }
    }

    if (count <= 0) continue;
    total += count;

    let pos = ids.length - 1;
    if (hidden) while (pos >= 0 && hidden.has(ids[pos]!)) pos--;
    if (pos >= 0) {
      cursors.push({ bucket, ids, pos, at: placedAt(bucket.docs[ids[pos]!]!), hidden });
    }
  }

  const items: MessageRecord[] = [];
  const cap = Math.min(limit, total);
  while (items.length < cap && cursors.length > 0) {
    let best = 0;
    for (let i = 1; i < cursors.length; i++) {
      if (cursors[i]!.at > cursors[best]!.at) best = i;
    }
    const c = cursors[best]!;
    items.push(c.bucket.docs[c.ids[c.pos]!]!);
    let nextPos = c.pos - 1;
    if (c.hidden) while (nextPos >= 0 && c.hidden.has(c.ids[nextPos]!)) nextPos--;
    if (nextPos >= 0) {
      c.pos = nextPos;
      c.at = placedAt(c.bucket.docs[c.ids[nextPos]!]!);
    } else {
      cursors.splice(best, 1);
    }
  }

  return { total, items };
}

/** The messages holding the query, the newest first. */
export function findMessages(messages: readonly MessageRecord[], query: string): MessageRecord[] {
  const q = searchTerm(query);
  if (!q || messages.length === 0) return [];

  if (messages.length <= INDEX_THRESHOLD) {
    const matched: MessageRecord[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (foldedText(m).includes(q)) matched.push(m);
    }
    return matched.sort((a, b) => placedAt(b) - placedAt(a));
  }

  const index = acquireIndex(messages);
  finishIndex(index);

  // Single bucket (common for a single large channel): reverse-copy directly, zero merge overhead.
  if (index.allBuckets.length === 1) {
    const bucket = index.allBuckets[0]!;
    const ids = queryBucket(bucket, q);
    const out = new Array<MessageRecord>(ids.length);
    for (let i = 0, j = ids.length - 1; j >= 0; i++, j--) out[i] = bucket.docs[ids[j]!]!;
    return out;
  }

  return searchMessagePage(messages, query, messages.length).items;
}

/** Whose messages a search goes through: a name heard, or ours (written under a name of ours). */
export interface Sender {
  name: string;
  mine: boolean;
}

/**
 * One sender's messages in a channel or a room, the newest first: all of them, or with a query
 * long enough to search, those holding it (#64).
 */
export function messagesFrom(messages: readonly MessageRecord[], from: Sender, query: string): MessageRecord[] {
  const q = searchTerm(query);
  const side = from.mine ? "out" : "in";
  if (messages.length <= INDEX_THRESHOLD) {
    return messages.filter((m) => m.direction === side && m.sender === from.name && (!q || foldedText(m).includes(q))).sort((a, b) => placedAt(b) - placedAt(a));
  }

  const index = acquireIndex(messages);
  finishIndex(index);
  const sk = `${side}:${from.name}`;
  const out: MessageRecord[] = [];

  for (let b = 0; b < index.allBuckets.length; b++) {
    const bucket = index.allBuckets[b]!;
    const rawSender = bucket.bySender.get(sk);
    if (!rawSender || rawSender.length === 0) continue;
    const senderIds = cleanIds(bucket, rawSender);
    if (!q) {
      for (let i = senderIds.length - 1; i >= 0; i--) out.push(bucket.docs[senderIds[i]!]!);
      continue;
    }
    const textIds = queryBucket(bucket, q);
    if (textIds.length === 0) continue;
    if (senderIds.length <= textIds.length) {
      for (let i = senderIds.length - 1; i >= 0; i--) {
        const id = senderIds[i]!;
        if (bucket.folded[id]!.includes(q)) out.push(bucket.docs[id]!);
      }
    } else {
      for (let i = textIds.length - 1; i >= 0; i--) {
        const m = bucket.docs[textIds[i]!]!;
        if (m.direction === side && m.sender === from.name) out.push(m);
      }
    }
  }

  if (index.allBuckets.length > 1) out.sort((a, b) => placedAt(b) - placedAt(a));
  return out;
}

/**
 * Lazy view over a chat's search matches (newest first). Stepping between matches
 * and checking whether a drawn bubble matches both run in O(1) without allocating
 * a full array or an id Set for thousands of hits.
 */
export interface SearchMatches {
  readonly length: number;
  at(index: number): MessageRecord | undefined;
  indexOf(id: string): number;
  has(message: MessageRecord): boolean;
}

export const EMPTY_MATCHES: SearchMatches = {
  length: 0,
  at: () => undefined,
  indexOf: () => -1,
  has: () => false,
};

function arrayMatches(list: readonly MessageRecord[], test: (m: MessageRecord) => boolean): SearchMatches {
  if (list.length === 0) return EMPTY_MATCHES;
  return {
    length: list.length,
    at: (i) => (i >= 0 && i < list.length ? list[i] : undefined),
    indexOf: (id) => list.findIndex((m) => m.id === id),
    has: test,
  };
}

function bucketMatches(index: SearchIndex, bucket: Bucket, ids: readonly number[], test: (m: MessageRecord) => boolean): SearchMatches {
  const n = ids.length;
  if (n === 0) return EMPTY_MATCHES;
  return {
    length: n,
    at: (i) => (i >= 0 && i < n ? bucket.docs[ids[n - 1 - i]!] : undefined),
    indexOf(id) {
      if (!bucket.outOfOrder) {
        const loc = index.byId.get(id);
        if (!loc || loc.bucket !== bucket) return -1;
        const target = loc.docId;
        let lo = 0;
        let hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const v = ids[mid]!;
          if (v === target) return n - 1 - mid;
          if (v < target) lo = mid + 1;
          else hi = mid - 1;
        }
        return -1;
      }
      for (let i = n - 1; i >= 0; i--) if (bucket.docs[ids[i]!]!.id === id) return n - 1 - i;
      return -1;
    },
    has: test,
  };
}

/**
 * In-chat search backed by the shared session index when the conversation is
 * large enough to have its own bucket, avoiding both a second index build and
 * allocating an array or Set of thousands of matching messages.
 */
export function searchInChat(
  allMessages: readonly MessageRecord[],
  conversation: string,
  visibleMessages: readonly MessageRecord[],
  query: string,
  from: Sender | null,
  exclude?: (m: MessageRecord) => boolean,
): SearchMatches {
  const q = searchTerm(query);
  if (!q && from === null) return EMPTY_MATCHES;
  if (visibleMessages.length === 0) return EMPTY_MATCHES;

  const side = from ? (from.mine ? "out" : "in") : null;
  const senderName = from?.name ?? null;
  const matchesOne = (m: MessageRecord): boolean => {
    if (side !== null && (m.direction !== side || m.sender !== senderName)) return false;
    return !q || foldedText(m).includes(q);
  };

  // Small chat: direct reverse scan over `visibleMessages` (already sorted ascending by `placedAt`).
  if (visibleMessages.length <= INDEX_THRESHOLD || allMessages.length <= INDEX_THRESHOLD) {
    const out: MessageRecord[] = [];
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]!;
      if (matchesOne(m)) out.push(m);
    }
    return arrayMatches(out, matchesOne);
  }

  const index = acquireIndex(allMessages);
  const bucket = index.convBuckets.get(conversation);
  if (!bucket) {
    // Conversation stayed below BUCKET_SPLIT or grew after initial build: scan its sorted messages directly.
    const out: MessageRecord[] = [];
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]!;
      if (matchesOne(m)) out.push(m);
    }
    return arrayMatches(out, matchesOne);
  }

  finishBucket(bucket);

  let rawIds: readonly number[];
  if (from !== null) {
    const senderRaw = bucket.bySender.get(`${side}:${senderName}`);
    if (!senderRaw || senderRaw.length === 0) return EMPTY_MATCHES;
    const senderIds = cleanIds(bucket, senderRaw);
    if (!q) {
      rawIds = senderIds;
    } else {
      const textIds = queryBucket(bucket, q);
      if (textIds.length === 0) return EMPTY_MATCHES;
      const narrowed: number[] = [];
      if (senderIds.length <= textIds.length) {
        for (let i = 0; i < senderIds.length; i++) {
          const id = senderIds[i]!;
          if (bucket.folded[id]!.includes(q)) narrowed.push(id);
        }
      } else {
        for (let i = 0; i < textIds.length; i++) {
          const id = textIds[i]!;
          const m = bucket.docs[id]!;
          if (m.direction === side && m.sender === senderName) narrowed.push(id);
        }
      }
      rawIds = narrowed;
    }
  } else {
    rawIds = queryBucket(bucket, q!);
  }

  if (rawIds.length === 0) return EMPTY_MATCHES;
  if (!exclude) return bucketMatches(index, bucket, rawIds, matchesOne);

  const visible: number[] = [];
  for (let i = 0; i < rawIds.length; i++) {
    const id = rawIds[i]!;
    if (!exclude(bucket.docs[id]!)) visible.push(id);
  }
  return bucketMatches(index, bucket, visible, (m) => !exclude(m) && matchesOne(m));
}

/** Where the query stands in a text: start and end of each place, in order, none overlapping. */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = searchTerm(query);
  if (!q) return [];
  const hay = fold(text);
  const out: [number, number][] = [];
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}

/**
 * A result's text, from a word or two before its first match, so the one
 * line the list gives it shows the word.
 */
export function snippet(text: string, query: string, lead = 24): string {
  const q = searchTerm(query);
  if (!q) return text;
  const first = fold(text).indexOf(q);
  if (first < 0 || first <= lead) return text;
  const back = first - 16;
  const space = text.slice(back, first).search(/\s\S/);
  let from = space >= 0 ? back + space + 1 : back;
  // Not in the middle of an emoji.
  const code = text.charCodeAt(from);
  if (code >= 0xdc00 && code <= 0xdfff) from++;
  return `…${text.slice(from)}`;
}
