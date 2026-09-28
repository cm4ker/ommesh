import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord, SessionState } from "@meshnet/meshcore";
import { ALL_CHATS, CATCH_UP_MS, QUIET_MS, createAnnouncer, type Notice } from "./announce.js";

const BOB = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const EVE = "2102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

let clock = 1_700_000_000_000;

function message(conversation: string, text: string, sender: string | null = null): MessageRecord {
  clock += 1000;
  return {
    id: `${conversation}-${clock}`,
    conversation,
    direction: "in",
    text,
    sender,
    senderPrefix: null,
    timestamp: Math.floor(clock / 1000),
    receivedAt: clock,
    snr: null,
    hops: null,
    txtType: 0,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
  };
}

function contact(key: string, name: string) {
  return { key, prefix: key.slice(0, 12), type: 1, flags: 0, outPathLen: 0xff, outPath: "", name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0, lastHeardAt: null, pathSince: null };
}

function initial(messages: MessageRecord[] = [], unread: Record<string, number> = {}): SessionState {
  return {
    status: "ready",
    link: null,
    device: null,
    self: { name: "Me" } as SessionState["self"],
    contacts: { [BOB]: contact(BOB, "Bob"), [EVE]: contact(EVE, "Eve") },
    contactsCursor: 0,
    removed: {},
    autoAdd: null,
    contactsFull: false,
    removing: null,
    channels: [
      { index: 0, name: "Public", secret: "00" },
      { index: 1, name: "test", secret: "01" },
      { index: 2, name: "Friends", secret: "02" },
    ],
    messages,
    unread,
    battery: null,
    tuning: null,
    logins: {},
    telemetry: {},
    statuses: {},
    statusHistory: {},
    batteryHistory: {},
    neighbours: {},
    accessLists: {},
    ownerInfo: {},
    series: {},
    nodeSettings: {},
    consoles: {},
    remote: { active: null, queued: [] },
    routing: { resetAfterMin: null, contacts: {} },
    log: [],
    error: null,
    syncing: false,
    connectStep: null,
  };
}

/** The session's side, as MeshSession plays it: state, then the change, then the news. */
let state: SessionState;
let focused: string | null;
let wanted: (m: MessageRecord) => boolean;
/** What each notice says, as the tests below compare it; `full` keeps whose circle it shows and its thread. */
let shown: Notice[];
let full: Notice[];
/** The tags of the notices that rang. */
let rang: string[];
let withdrawn: string[];
let announcer: ReturnType<typeof createAnnouncer>;

function set(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  announcer.changed();
}

function receive(m: MessageRecord): void {
  const unread = focused === m.conversation ? state.unread : { ...state.unread, [m.conversation]: (state.unread[m.conversation] ?? 0) + 1 };
  set({ messages: [...state.messages, m], unread });
  announcer.received(m);
}

/** The radio's queue drained in one pass, as at connect, and then a quiet. */
function drain(messages: MessageRecord[]): void {
  set({ syncing: true });
  for (const m of messages) receive(m);
  set({ syncing: false });
  mock.timers.tick(QUIET_MS);
}

/** One message in a pass of its own, as the phone's radio core hands its copy of the queue over. */
function handOver(m: MessageRecord): void {
  set({ syncing: true });
  receive(m);
  set({ syncing: false });
}

function markRead(conversation: string): void {
  const unread = { ...state.unread };
  delete unread[conversation];
  set({ unread });
}

function start(from: SessionState = initial()): void {
  state = from;
  announcer = createAnnouncer({ state: () => state, wanted: (m) => wanted(m), show: (n) => {
    const { face: _face, thread: _thread, silent, ...said } = n;
    shown.push(said);
    full.push(n);
    if (!silent) rang.push(n.tag);
  }, withdraw: (t) => withdrawn.push(t) });
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  rang = [];
  focused = null;
  wanted = () => true;
  shown = [];
  full = [];
  withdrawn = [];
  start();
});

afterEach(() => mock.timers.reset());

test("the history read back at connect is not announced, unread or not", () => {
  start(initial([]));
  const history = [message("ch:0", "old", "Alice"), message(`c:${BOB}`, "older")];
  set({ status: "connecting" });
  set({ messages: history, unread: { "ch:0": 1, [`c:${BOB}`]: 1 } });
  set({ status: "ready" });
  assert.deepEqual(shown, []);
});

test("one message is one notice: who said it and where", () => {
  drain([message("ch:0", "hi all", "Alice")]);
  assert.deepEqual(shown, [{ title: "Alice in Public", body: "hi all", tag: "c:ch:0", kind: "chats" }]);
});

test("a queue drained at connect is announced once it is drained, one notice per conversation", () => {
  set({ syncing: true });
  receive(message("ch:0", "one", "Alice"));
  receive(message("ch:0", "two", "Bob"));
  assert.deepEqual(shown, []);
  receive(message("ch:0", "three", "Alice"));
  receive(message("ch:0", "four", "Carol"));
  receive(message(`c:${BOB}`, "ping"));
  set({ syncing: false });
  assert.deepEqual(shown, [
    { title: "Public · 4 new", body: "Bob: two\nAlice: three\nCarol: four", tag: "c:ch:0", kind: "chats" },
    { title: "Bob", body: "ping", tag: `c:c:${BOB}`, kind: "direct" },
  ]);
});

test("more news in a conversation replaces its notice with the count of all that is unread", () => {
  drain([message(`c:${BOB}`, "first")]);
  drain([message(`c:${BOB}`, "second")]);
  assert.deepEqual(shown.map((n) => [n.title, n.tag]), [
    ["Bob", `c:c:${BOB}`],
    ["Bob · 2 new", `c:c:${BOB}`],
  ]);
  assert.equal(shown[1]?.body, "first\nsecond");
});

test("news in more than three conversations is one notice for all of them", () => {
  drain([
    message("ch:0", "a", "Alice"),
    message("ch:0", "b", "Alice"),
    message("ch:1", "c", "Alice"),
    message("ch:2", "d", "Alice"),
    message(`c:${BOB}`, "e"),
    message(`c:${EVE}`, "f"),
  ]);
  assert.deepEqual(shown, [{ title: "6 new messages in 5 chats", body: "Public 2, test 1, Friends 1, Bob 1, …", tag: ALL_CHATS, kind: "chats" }]);
});

test("conversation notices already out give way to one for all when a fourth conversation has news", () => {
  drain([message("ch:0", "a", "Alice"), message("ch:1", "b", "Alice")]);
  drain([message("ch:2", "c", "Alice")]);
  drain([message(`c:${BOB}`, "d")]);
  assert.deepEqual(shown.map((n) => n.tag), ["c:ch:0", "c:ch:1", "c:ch:2", ALL_CHATS]);
  assert.deepEqual(withdrawn.sort(), ["c:ch:0", "c:ch:1", "c:ch:2"]);
  assert.equal(shown.at(-1)?.title, "4 new messages in 4 chats");
});

test("the notice for all is withdrawn when the app is opened, and news after it is announced on its own", () => {
  drain(["ch:0", "ch:1", "ch:2", `c:${BOB}`].map((c) => message(c, "x", "Alice")));
  announcer.opened();
  assert.deepEqual(withdrawn, [ALL_CHATS]);
  drain([message(`c:${EVE}`, "hello")]);
  assert.deepEqual(shown.at(-1), { title: "Eve", body: "hello", tag: `c:c:${EVE}`, kind: "direct" });
});

test("a conversation read anywhere loses its notice, one from an earlier run included", () => {
  drain([message(`c:${BOB}`, "ping")]);
  markRead(`c:${BOB}`);
  assert.deepEqual(withdrawn, [`c:c:${BOB}`, ALL_CHATS]);

  // Unread from before this run: its notice may still be out.
  start(initial([message("ch:0", "old", "Alice")], { "ch:0": 1, "ch:1": 2 }));
  withdrawn = [];
  markRead("ch:0");
  assert.deepEqual(withdrawn, ["c:ch:0"]);
});

test("a message in the conversation on screen arrives read and is not announced", () => {
  focused = "ch:0";
  drain([message("ch:0", "seen", "Alice"), message("ch:1", "not seen", "Alice")]);
  assert.deepEqual(shown.map((n) => n.tag), ["c:ch:1"]);
});

test("a mention is said in the notice, alone or among others", () => {
  drain([message("ch:0", "@[Me] look", "Alice")]);
  assert.equal(shown.at(-1)?.title, "Alice mentioned you in Public");
  drain([message("ch:0", "and this", "Bob")]);
  assert.equal(shown.at(-1)?.title, "Public · 2 new, you are mentioned");
});

test("with the switch off nothing is announced, and nothing is kept for later", () => {
  wanted = () => false;
  drain([message("ch:0", "quiet", "Alice")]);
  wanted = () => true;
  set({ syncing: false });
  assert.deepEqual(shown, []);
});

test("a chat left at mentions rings for the mentions only, and counts only those", () => {
  wanted = (m) => m.text.includes("@[Me]");
  drain([message("ch:0", "chatter", "Alice")]);
  assert.deepEqual(shown, []);
  drain([message("ch:0", "@[Me] look", "Bob"), message("ch:0", "more chatter", "Carol")]);
  assert.deepEqual(shown, [{ title: "Bob mentioned you in Public", body: "@[Me] look", tag: "c:ch:0", kind: "chats" }]);
});

test("the notice for several chats counts only what rings", () => {
  wanted = (m) => m.conversation !== "ch:0" || m.text.includes("@[Me]");
  drain([
    message("ch:0", "chatter", "Alice"),
    message("ch:1", "one", "Bob"),
    message("ch:2", "two", "Bob"),
    message(`c:${BOB}`, "three"),
    message(`c:${EVE}`, "four"),
  ]);
  assert.deepEqual(shown.at(-1), { title: "4 new messages in 4 chats", body: "test 1, Friends 1, Bob 1, Eve 1", tag: ALL_CHATS, kind: "chats" });
});

test("a channel's message shows its writer's circle, and its thread names each writer", () => {
  drain([message("ch:0", "hi all", "Alice")]);
  const notice = full.at(-1);
  assert.deepEqual(notice?.face, { name: "Alice" });
  assert.deepEqual(notice?.thread?.face, { name: "Public", channel: true });
  assert.equal(notice?.thread?.group, true);
  assert.deepEqual(notice?.thread?.lines.map((l) => [l.sender, l.text]), [["Alice", "hi all"]]);
});

test("several messages in a channel show the channel's circle, the latest three in the thread", () => {
  drain([message("ch:0", "one", "Alice"), message("ch:0", "two", "Bob"), message("ch:0", "three", "Carol"), message("ch:0", "four", "Alice")]);
  const notice = full.at(-1);
  assert.deepEqual(notice?.face, { name: "Public", channel: true });
  assert.deepEqual(notice?.thread?.lines.map((l) => l.sender), ["Bob", "Carol", "Alice"]);
});

test("a person's message shows their circle by their advert, and the thread is theirs alone", () => {
  drain([message(`c:${BOB}`, "ping")]);
  const notice = full.at(-1);
  assert.deepEqual(notice?.face, { name: "Bob", type: 1 });
  assert.equal(notice?.thread?.group, false);
  assert.deepEqual(notice?.thread?.lines.map((l) => l.sender), ["Bob"]);
});

test("the notice for several chats shows no one's circle", () => {
  drain([message("ch:0", "a", "Alice"), message("ch:1", "b", "Bob"), message("ch:2", "c", "Bob"), message(`c:${BOB}`, "d")]);
  const notice = full.at(-1);
  assert.equal(notice?.tag, ALL_CHATS);
  assert.equal(notice?.face, undefined);
  assert.equal(notice?.thread, undefined);
});

test("a queue handed over a message at a time rings once, and the count is shown once it stops", () => {
  for (let i = 0; i < 150; i++) {
    handOver(i % 2 ? message("ch:0", `m${i}`, "Alice") : message(`c:${BOB}`, `m${i}`));
    mock.timers.tick(100);
  }
  assert.deepEqual(rang, [`c:c:${BOB}`]);
  assert.ok(shown.length < 2 * (15_000 / CATCH_UP_MS + 2), "brought up to date every few seconds, not message by message");
  shown = [];
  mock.timers.tick(QUIET_MS);
  assert.deepEqual(shown.map((n) => n.title).sort(), ["Bob · 75 new", "Public · 75 new"]);
  assert.deepEqual(rang, [`c:c:${BOB}`], "quietly");
});

test("messages seconds apart ring each, at once", () => {
  handOver(message(`c:${BOB}`, "one"));
  assert.deepEqual(rang, [`c:c:${BOB}`]);
  mock.timers.tick(4000);
  handOver(message(`c:${BOB}`, "two"));
  mock.timers.tick(4000);
  handOver(message("ch:0", "three", "Alice"));
  assert.deepEqual(rang, [`c:c:${BOB}`, `c:c:${BOB}`, "c:ch:0"]);
});

test("a burst in several chats rings with its first notice only", () => {
  drain([message("ch:0", "a", "Alice"), message(`c:${BOB}`, "b")]);
  assert.deepEqual(shown.map((n) => n.tag), ["c:ch:0", `c:c:${BOB}`]);
  assert.deepEqual(rang, ["c:ch:0"]);
});

test("news nobody wants to hear of leaves the burst to ring for what they do", () => {
  wanted = (m) => m.conversation !== "ch:0";
  handOver(message("ch:0", "chatter", "Alice"));
  mock.timers.tick(100);
  handOver(message(`c:${BOB}`, "ping"));
  assert.deepEqual(rang, [`c:c:${BOB}`]);
});
