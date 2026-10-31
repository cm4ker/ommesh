/**
 * A radio that is not there: a scripted one, for looking at the client with
 * no hardware on the desk. Offered when the page is opened with `?demo`, or
 * in development. It has a few contacts and channels, answers every command
 * the session sends, acknowledges messages a moment later, and has somebody
 * say something every so often. It also hands up the packets it "hears", so
 * routes, copies and relays show as they would on a real mesh: a flood learns
 * a route when it is acknowledged, and a route to Bob (on his bike) often
 * turns out to be gone.
 */

import {
  BaseTransport,
  ByteWriter,
  Cmd,
  crockford,
  directReactionText,
  encodeReaction,
  fromHex,
  fromUtf8,
  groupDataPayload,
  groupTextPayload,
  heardGroupTextPayload,
  MAX_FRAME_SIZE,
  messageHash,
  PEER_HELLO,
  peerEntry,
  privateKeyFault,
  publicKeyOf,
  Push,
  REACTION_DATA_TYPE,
  readMarkValue,
  ReqType,
  Resp,
  signWith,
  textHash,
  toHex,
  TxtType,
  type Transport,
} from "@meshnet/meshcore";
import type { Connector } from "./types.js";
import { t } from "../i18n/index.js";

/**
 * Who the demo radio is: its private key, the public key that comes of it,
 * its name and its Bluetooth PIN (0 for the firmware's own). They last as
 * long as the page rather than one link, as a radio keeps them over a
 * reboot, so a key, a name or a PIN given to it in Settings is what it comes
 * back with.
 */
const DEMO_KEY = fromHex("1088b9a5a4103e31b859e71fa9723589219e5651a7bd90a1a04b81a5024cc157b8460e03da7d62cf6b03cb648efca994eaf82acf07358dfe9892d2f7e71142fd");
const own = { privateKey: DEMO_KEY, publicKey: publicKeyOf(DEMO_KEY), name: "Demo radio", blePin: 0 };

/**
 * What a factory reset left, kept over the reboot that follows as a radio
 * keeps it: no contacts and Public alone, until something is written back,
 * a copy of the radio from Settings for one. Null until the demo radio is
 * reset.
 */
let wiped: { gone: Set<Person>; channels: Map<number, { name: string; secret: Uint8Array }> } | null = null;

/** A key of its own, as a radio makes one when it is reset: random, clamped, and not one the mesh keeps for itself. */
function freshKey(): Uint8Array {
  for (;;) {
    const key = crypto.getRandomValues(new Uint8Array(64));
    key[0]! &= 0xf8;
    key[31] = (key[31]! & 0x3f) | 0x40;
    if (!privateKeyFault(key)) return key;
  }
}

/**
 * The demo radio's Wi-Fi (MeshCore 1.18) and the time zone its screen shows, kept over a reboot as a
 * radio keeps them: `wifi` as written, `started` as the radio took it when it last started.
 */
const ownWifi = { wifi: { ssid: "HomeNet", pwd: "radio-pass-2026", enabled: 1 }, started: { ssid: "HomeNet", enabled: 1 }, tzOffset: 0 };

interface Person {
  key: Uint8Array;
  name: string;
  type: number;
  hops: number;
  lat: number;
  lon: number;
  /** Seconds since its last advert; ten minutes when not said. */
  ago?: number;
  /** The route the radio holds to it, relay by relay, when it is not along `RELAYS`. */
  route?: number[];
  /** Never kept from an advert: off the radio until added by its key, and nameless there until it says its name. */
  stranger?: true;
}

const PEOPLE: Person[] = [
  { key: seeded(1), name: "Alice", type: 1, hops: 0, lat: 55.03, lon: 73.37 },
  { key: seeded(2), name: "Bob (bike)", type: 1, hops: 1, lat: 0, lon: 0 },
  { key: seeded(3), name: "Hill Repeater", type: 2, hops: 1, lat: 55.05, lon: 73.4 },
  { key: seeded(4), name: "Town Room", type: 3, hops: 2, lat: 0, lon: 0 },
  { key: seeded(5), name: "Weather sensor", type: 4, hops: 0xff, lat: 55.01, lon: 73.3 },
  { key: seeded(7), name: "Tower Repeater", type: 2, hops: 1, lat: 55.09, lon: 73.31 },
  // Signs paths with the same first byte as Hill Repeater, as one-byte hashes on a busy mesh do.
  { key: startingWith(0x6f, 6), name: "Ridge Repeater", type: 2, hops: 2, lat: 55.12, lon: 73.5 },
  // A name ending in an emoji, which goes on the node's circle.
  { key: seeded(8), name: "Kolya ⛺", type: 1, hops: 1, lat: 55.075, lon: 73.43, ago: 3 * 86400 },
];

/**
 * A town's worth of repeaters south of the radio, linked as `LINKS` says, so
 * a way can be looked for and checked: the route held to RMK-3 goes through
 * SKK_Blinova → Marksa, a link that has died, and a way round it is there to
 * be found. Their floods are overheard all the time, so the app learns who
 * hears whom from them.
 */
const TOWN: [number, string, number, number, number[] | null][] = [
  [0x1a, "K10 Юг Круг", 54.992, 73.418, []],
  [0x21, "MIR", 54.982, 73.467, [0x1a]],
  [0x37, "Wan7-KORDNIY-🏢☀", 54.969, 73.568, null],
  [0x45, "SKK_Blinova", 54.94, 73.531, null],
  [0x58, "Marksa", 54.936, 73.423, null],
  [0x62, "AMUR-21", 54.883, 73.489, null],
  [0xf1, "РМК-3", 54.862, 73.466, [0x1a, 0x21, 0x37, 0x45, 0x58, 0x62]],
  [0x7a, "Frezernaya", 54.999, 73.548, [0x1a, 0x8d]],
  [0x8d, "DGG-R2", 55.034, 73.332, [0x1a]],
];
TOWN.forEach(([first, name, lat, lon, route], i) => {
  PEOPLE.push({ key: startingWith(first, 20 + i), name, type: 2, hops: route ? route.length : 0xff, lat, lon, ago: 300 + i * 97, ...(route ? { route } : {}) });
});
const TOWN_HASHES = new Set(TOWN.map(([first]) => first));

/**
 * The regions the repeaters in range carry, as each lists them when asked:
 * "*" first for one that passes on floods without a region, as all do here
 * but K10, which carries its own part of town only.
 */
const REGIONS: Record<string, string> = {
  "Hill Repeater": "*,omsk,oms",
  "Tower Repeater": "*,omsk",
  "K10 Юг Круг": "omsk,omsk-yug",
  MIR: "*,omsk",
};

/**
 * Repeaters Hill hears from well out of town, and one on the next roof, so
 * its neighbours run from a few hundred metres to fifty km and a filter by
 * distance has something to sort (#51). Nobody else hears them.
 */
const AFIELD: [number, string, number, number][] = [
  [0x93, "Кормиловка", 55.0, 74.1],
  [0xa4, "Azovo-R", 54.7, 73.03],
  [0xb5, "Lyubino-1", 55.15, 72.7],
  [0xc6, "Roof-2", 55.054, 73.407],
];
AFIELD.forEach(([first, name, lat, lon], i) => {
  PEOPLE.push({ key: startingWith(first, 40 + i), name, type: 2, hops: 0xff, lat, lon, ago: 900 + i * 613 });
});

// A repeater next door whose advert the radio never kept: who hears me finds it, and it can be added by its key and signed in to.
PEOPLE.push({ key: seeded(9), name: "Garage Repeater", type: 2, hops: 0, lat: 55.035, lon: 73.355, stranger: true });

/**
 * Who hears whom in the town: `a>b` is how well b hears a, dB; "me" is this
 * radio. A pair not here does not hear each other at all.
 */
const LINKS: Record<string, number> = {};
{
  const both = (a: string, b: string, ab: number, ba: number) => {
    LINKS[`${a}>${b}`] = ab;
    LINKS[`${b}>${a}`] = ba;
  };
  both("me", "1a", 11.75, 11.5);
  both("1a", "21", 11, 10.5);
  both("21", "37", 4.75, 3);
  both("37", "45", 2.5, -1.5);
  // SKK_Blinova and Marksa heard each other once; the link is gone.
  both("58", "62", 3, 2);
  both("62", "f1", 6, 1);
  both("21", "58", -2.5, -4);
  both("1a", "8d", 6, 6.75);
  both("8d", "7a", -3.5, -4.75);
  both("7a", "58", -6.5, -8);
  both("45", "62", -9, -11);
  both("37", "7a", -2, -3);
  both("me", "8d", 4, 3.5);
}

/** Floods that between them go along every link the town has, each ending at a repeater the radio hears. */
const TOWN_FLOODS = [
  ["f1", "62", "58", "21", "1a"],
  ["f1", "62", "58", "7a", "8d"],
  ["45", "37", "21", "1a"],
  ["37", "45", "62", "58", "21", "1a"],
  ["1a", "21", "58", "7a", "8d"],
  ["1a", "21", "37", "7a", "8d"],
  ["8d", "7a", "58", "21", "1a"],
  ["62", "58", "7a", "8d"],
  ["f1", "62", "58", "21", "1a"],
  ["45", "37", "21", "1a"],
];

function townKey(node: number | "me"): string {
  return node === "me" ? "me" : node.toString(16).padStart(2, "0");
}

/** How well `b` hears `a` on a trace, dB, or null when it does not; the older demo relays keep their own fixed figures. */
function legSnr(a: number | "me", b: number | "me"): number | null {
  const town = (x: number | "me") => x === "me" || TOWN_HASHES.has(x);
  if (town(a) && town(b)) {
    const snr = LINKS[`${townKey(a)}>${townKey(b)}`];
    return snr === undefined ? null : Math.round((snr + (Math.random() * 1.5 - 0.75)) * 4) / 4;
  }
  return heardAt(b === "me" ? (a as number) : b);
}

/**
 * `?demo&crowd=400`: that many more nodes scattered round the town, heard
 * from a minute to a few days ago, to see how the map and the lists hold up.
 */
const CROWD = (() => {
  try {
    return Math.min(3000, Math.max(0, Number(new URLSearchParams(globalThis.location?.search ?? "").get("crowd")) || 0));
  } catch {
    return 0;
  }
})();
{
  let seed = 0x2545f491;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const tails = ["", "", "", "", " 🦊", " 🚲", " 🏔️", " 📡"];
  for (let i = 0; i < CROWD; i++) {
    const key = new Uint8Array(32);
    for (let b = 0; b < 32; b++) key[b] = Math.floor(rand() * 256);
    const roll = rand();
    const type = roll < 0.8 ? 1 : roll < 0.95 ? 2 : 3;
    const name = type === 2 ? `Rpt-${i}` : type === 3 ? `Room ${i}` : `Node-${i}${tails[Math.floor(rand() * tails.length)]}`;
    PEOPLE.push({ key, name, type, hops: 1 + Math.floor(rand() * 3), lat: 55.05 + (rand() - 0.5) * 0.5, lon: 73.4 + (rand() - 0.5) * 0.9, ago: Math.floor(60 + rand() * rand() * 4 * 86400) });
  }
}

/**
 * `?demo&stale=90`: that many more nodes last heard three weeks to four
 * months ago, with no position, to fill the radio's memory and see the
 * clean-up at work.
 */
{
  let stale = 0;
  try {
    stale = Math.min(500, Math.max(0, Number(new URLSearchParams(globalThis.location?.search ?? "").get("stale")) || 0));
  } catch {
    stale = 0;
  }
  const kinds = [1, 1, 1, 2, 2, 3, 4];
  for (let i = 0; i < stale; i++) {
    const key = seeded(1000 + i);
    key[1] = (i * 97) & 0xff;
    const type = kinds[i % kinds.length]!;
    const name = type === 2 ? `Old rpt ${i}` : type === 3 ? `Old room ${i}` : type === 4 ? `Old sensor ${i}` : `Passer-by ${i}`;
    PEOPLE.push({ key, name, type, hops: 0xff, lat: 0, lon: 0, ago: (20 + ((i * 37) % 100)) * 86400 });
  }
}

function seeded(n: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (n * 37 + i * 11) & 0xff;
  return key;
}

function startingWith(first: number, n: number): Uint8Array {
  const key = seeded(n);
  key[0] = first;
  return key;
}

/** Path hashes the demo's packets travel through: Tower, Town Room, Hill or Ridge (0x6f), and a stranger. */
const RELAYS = [0x03, 0x94, 0x6f, 0x2c];

const CHANNELS = ["8b3387e9c5cdea6ac9e5edbaa115cd72", "0123456789abcdef0123456789abcdef"];

function contactFrame(code: number, p: Person, lastMod: number, hops = p.hops, relays: number[] = RELAYS, flags = p.name === "Alice" ? 1 : 0, advertAt = Math.floor(Date.now() / 1000) - (p.ago ?? 600)): Uint8Array {
  const path = new Uint8Array(64);
  if (hops !== 0xff) path.set(relays.slice(0, hops));
  return new ByteWriter()
    .u8(code)
    .bytes(p.key)
    .u8(p.type)
    .u8(flags)
    .u8(hops)
    .bytes(path)
    .fixedString(p.name, 32)
    .u32(advertAt)
    .i32(Math.round(p.lat * 1e6))
    .i32(Math.round(p.lon * 1e6))
    .u32(lastMod)
    .toBytes();
}

const LINES = [
  "Anyone up on the hill today?",
  "Repeater's back on solar, looks healthy",
  "Coffee at the usual place, 15:00",
  "Got the sensor node reporting again",
  "SNR to the tower is great from here",
  "Ping me when you're in range",
  "👍",
];

/** What the demo's repeater, room and sensor answer `get` with, and change on `set`. */
function nodePrefs(p: Person): Record<string, string> {
  return {
    name: p.name,
    lat: String(p.lat),
    lon: String(p.lon),
    "owner.info": p.type === 2 ? "Hill club|ask on #test" : "",
    radio: "868.731,62.500,7,7",
    tx: "22",
    repeat: p.type === 2 ? "on" : "off",
    "flood.max": "64",
    "advert.interval": "0",
    "flood.advert.interval": "47",
    txdelay: "0.5",
    "direct.txdelay": "0.3",
    rxdelay: "0.0",
    af: "1.0",
    "guest.password": "guest",
    "allow.read.only": "off",
    powersaving: "off",
  };
}

/**
 * How well each node hears the one before it on a trace, dB, by the hash it
 * signs with: the tower well, the hill fairly, the town room barely, the
 * stranger worse. Below about −8 dB a hop is more often lost than not.
 */
const HEARS: Record<number, number> = { 0x03: 6.5, 0x6f: -3, 0x94: -6.25, 0x2c: -9 };

/**
 * What the demo radio's own sensors say, as Cayenne LPP: on channel 1 its battery (3.98 V), its
 * processor (31.5 °C) and its GPS; on 4 a power monitor (3.38 V, 119 mA, and the power in whole
 * watts, so 0, as the firmware sends it); on 5 the air (18.4 °C, 46.5 %, 1004.2 hPa). The current
 * wanders at each answer, see `demoTelemetrySelf`.
 */
const DEMO_TELEMETRY_SELF = new Uint8Array([
  1, 0x74, 0x01, 0x8e, 1, 0x67, 0x01, 0x3b, 1, 0x88, 0x08, 0x63, 0xda, 0x0b, 0x31, 0xd0, 0x00, 0x25, 0x1c,
  4, 0x74, 0x01, 0x52, 4, 0x75, 0x00, 0x77, 4, 0x80, 0x00, 0x00,
  5, 0x67, 0x00, 0xb8, 5, 0x68, 0x5d, 5, 0x73, 0x27, 0x3a,
]);
/** Where the power monitor's current sits in `DEMO_TELEMETRY_SELF`, big-endian mA. */
const DEMO_CURRENT_AT = 25;

/** The demo radio's own sensors, its current somewhere from 80 to 160 mA, so a day of them draws a line. */
function demoTelemetrySelf(): Uint8Array {
  const bytes = DEMO_TELEMETRY_SELF.slice();
  const ma = 80 + Math.round(Math.random() * 80);
  bytes[DEMO_CURRENT_AT] = ma >> 8;
  bytes[DEMO_CURRENT_AT + 1] = ma & 0xff;
  return bytes;
}

/** What anyone else's radio answers: its battery (4.02 V), its processor (28.0 °C) and its GPS. */
const DEMO_TELEMETRY_OTHER = new Uint8Array([1, 0x74, 0x01, 0x92, 1, 0x67, 0x01, 0x18, 1, 0x88, 0x08, 0x65, 0xac, 0x0b, 0x31, 0xe4, 0x00, 0x23, 0x28]);

/** The weather sensor's air on its channel 2, drifting a little: temperature, humidity, pressure, as LPP. */
function weatherLpp(): Uint8Array {
  const minute = Date.now() / 60_000;
  const celsius = 14.2 + Math.sin(minute / 3) * 0.8;
  const humidity = 63 + Math.sin(minute / 5) * 3;
  const hpa = 1012.4 + Math.sin(minute / 7) * 0.6;
  const be = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  return new Uint8Array([2, 0x67, ...be(Math.round(celsius * 10)), 2, 0x68, Math.round(humidity * 2), 2, 0x73, ...be(Math.round(hpa * 10))]);
}

function heardAt(hash: number): number {
  return Math.round(((HEARS[hash] ?? -4) + (Math.random() * 2 - 1)) * 4) / 4;
}

/** A trace gets through a hop heard at `snr` with this chance. */
function through(snr: number): boolean {
  return Math.random() < 1 / (1 + Math.exp(-(snr + 7.5) / 1.1));
}

/**
 * The repeaters a demo repeater hears direct: prefix, seconds ago, SNR in
 * dB. Hill hears most of the town, one it lost days ago, two it cannot
 * name, and four out of town; Tower and Ridge hear Hill back, so a link shows both ways; the
 * town's repeaters hear whom `LINKS` says.
 */
function neighboursOf(p: Person): [string, number, number][] {
  const named = (name: string) => PEOPLE.find((x) => x.name === name);
  const town = (hash: number) => named(TOWN.find(([first]) => first === hash)?.[1] ?? "");
  const list = (rows: [Person | undefined, number, number][]) => rows.flatMap(([x, secs, snr]): [string, number, number][] => (x ? [[toHex(x.key.subarray(0, 6)), secs, snr]] : []));
  if (p.name === "Hill Repeater") {
    return [
      ...list([
        [named("Tower Repeater"), 240, 7.25],
        [named("Ridge Repeater"), 120, 9],
        [town(0x1a), 660, 3.5],
        [town(0x21), 2880, 1.25],
        [town(0x8d), 1560, -2.75],
        [town(0x7a), 3840, -8.5],
        [town(0x58), 7860, -5.5],
        [town(0x62), 3 * 86400, -12.25],
        [town(0xf1), 12720, 0.5],
        [town(0x37), 20400, 4.75],
        [town(0x45), 28800, -10.25],
        [named("Кормиловка"), 5100, -9.75],
        [named("Azovo-R"), 2600, 1.5],
        [named("Lyubino-1"), 9800, -6.25],
        [named("Roof-2"), 90, 10.5],
      ]),
      ["0d4c7bddeeff", 18300, -14],
      ["9aa3e1102030", 5400, 2.25],
    ];
  }
  if (p.name === "Tower Repeater") return list([[named("Hill Repeater"), 1200, -1.5], [named("Ridge Repeater"), 900, 2], [town(0x8d), 300, 5.5]]);
  if (p.name === "Ridge Repeater") return list([[named("Hill Repeater"), 200, 6], [named("Tower Repeater"), 800, 1.5]]);
  const own = [...TOWN_HASHES].find((h) => town(h) === p);
  if (own === undefined) return [];
  return list(
    Object.entries(LINKS)
      .filter(([pair]) => pair.endsWith(`>${townKey(own)}`) && !pair.startsWith("me>"))
      .map(([pair, snr], i): [Person | undefined, number, number] => [town(parseInt(pair.split(">")[0]!, 16)), 300 + i * 211, snr]),
  );
}

/** Where the firmware's default build lets a client repeat (`repeat_freq_ranges` in `companion_radio/MyMesh.cpp`), kHz. */
const DEMO_REPEAT_KHZ = [433_000, 869_495, 918_000];

class DemoRadio extends BaseTransport {
  readonly kind = "ble" as const;
  readonly label = "MeshCore-demo";
  private queue: Uint8Array[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** What the app has handed in to sign since its start, or null outside one. */
  private signing: Uint8Array | null = null;
  private chatter: ReturnType<typeof setInterval> | null = null;
  private acks = 0x1000;
  /** The radio's own settings, kept as the firmware keeps them so a re-read brings back what was set. */
  private radio = { frequencyKhz: 868_731, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7, repeat: false, pathHashMode: 0 };
  /** The region the radio keeps, as the firmware keeps it: the name, then its key. */
  private region: Uint8Array | null = null;
  private prefs = new Map<Person, Record<string, string>>(PEOPLE.filter((p) => p.type >= 2).map((p) => [p, nodePrefs(p)]));
  /** Nodes that took our admin password; only they answer the console. */
  private admins = new Set<Person>();
  /** When each repeater last called its neighbours, local ms. */
  private searched = new Map<Person, number>();
  /** What each repeater was told to forget: neighbours whose key starts with `prefix`, heard before `at`. */
  private forgotten = new Map<Person, { prefix: string; at: number }[]>();
  /**
   * How far each node's clock is behind ours, seconds; negative when it runs ahead. The
   * repeaters run 47 s behind, for the clock card, but Tower runs five minutes ahead, which
   * only a reset brings back.
   */
  private clocks = new Map<Person, number>(PEOPLE.filter((p) => p.type >= 2).map((p) => [p, p.name === "Tower Repeater" ? -300 : p.type === 2 ? 47 : 2]));
  /**
   * Ridge is two hops out, and the answer to the first `clock sync` it takes is lost on the way
   * back: the clock is set, the card still has it 47 s behind, and setting it again is refused.
   */
  private lostClockAnswer = new Set<Person>(PEOPLE.filter((p) => p.name === "Ridge Repeater"));
  /** The route this radio holds to each contact, as a hop count; 0xff for none. */
  private routes = new Map<Person, number>(PEOPLE.map((p) => [p, p.hops]));
  /** Contacts taken off this radio, and the flags written to the others. */
  private gone = wiped?.gone ?? new Set<Person>(PEOPLE.filter((p) => p.stranger));
  /** What was written for a stranger added by its key: all the radio knows of it. */
  private written = new Map<Person, { name: string; lat: number; lon: number }>();
  private flags = new Map<Person, number>();
  private autoAdd = { config: 0, maxHops: 0 };
  /** Routes written by hand, relay by relay; the rest go along `RELAYS`. */
  private paths = new Map<Person, number[]>(PEOPLE.filter((p) => p.route).map((p) => [p, p.route!]));
  /** Texts on Friends whose first send the repeaters already missed. */
  private missed = new Set<string>();
  private murmur: ReturnType<typeof setInterval> | null = null;
  /** The weather sensor sending its readings by itself, while asked to. */
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  /** When the demo radio came up, unix seconds: the stamp the queued messages are dated from. */
  private readonly started = Math.floor(Date.now() / 1000);

  /**
   * Reached through a phone that shares it, as a computer is: the relay says so once the radio
   * has said who it is, and the phone's app reads each message on Public a few seconds after it came.
   */
  constructor(private readonly throughPhone = false) {
    super();
  }

  start(): void {
    // Queued before the app connected: their packets were never heard, so their routes are unknown.
    // A place each: Alice's exact, sent from her phone, and a rough one on Public.
    // Links to real pages and a picture, for the previews to be tried on.
    this.queue.push(
      this.dm(PEOPLE[0]!, "Welcome to the demo mesh"),
      this.dm(PEOPLE[0]!, "👋"),
      this.dm(PEOPLE[0]!, "geo:55.04212,73.39208;u=9 Meet you here"),
      this.dm(PEOPLE[0]!, "The firmware is here: https://github.com/meshcore-dev/MeshCore"),
      this.dm(PEOPLE[0]!, "And a picture to try: https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png"),
      this.channel(0, "Bob (bike)", "Public channel works too", this.started - 120),
      this.channel(0, "Bob (bike)", "geo:55.06,73.43;u=1000 Somewhere round here today"),
      this.channel(0, "Bob (bike)", "What LoRa is, for the newcomers: https://en.wikipedia.org/wiki/LoRa"),
      // Replies (#32) as other apps send them: MCO Advanced quotes the start, MeshCore One puts the quote on a
      // line of its own, the official app names whom alone. Mira's message was before this radio listened.
      this.channel(0, "Bob (bike)", "Raised the antenna on the mast, now it reaches town"),
      this.channel(0, "Alice", "Who hears the Tower today?"),
      this.channel(0, "Bob (bike)", "Raised the antenna another metre"),
      this.channel(0, "Kolya ⛺", "@[Bob (bike)] >Raised the antenna on the mast...\nHow tall is the mast?"),
      this.channel(0, "Alice", "@[Bob (bike)] Nice, I hear you from the bridge now"),
      this.channel(0, "Kolya ⛺", "@[Bob (bike)]\n>Public cha..\nWorks here too"),
      this.channel(0, "Kolya ⛺", "@[Mira] >Who is on the hill...\nMe, till midnight"),
      // Somebody writing in a channel their radio no longer has: the all-zero key, filed in the first empty slot.
      this.channel(2, "Wanderer", "Anyone else see this channel with no name?"),
    );
    // Reactions to Bob's first line: Alice's from Ommesh, and Kolya's as MeshCore One sends one, in text.
    void messageHash("Public channel works too", this.started - 120).then((hash) => {
      this.queue.push(this.reaction(0, hash, "👍", "Alice"), this.channel(0, "Kolya ⛺", `@[Bob (bike)]❤️\n${crockford(hash)}`));
      this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    });
    // Bob, on 1.18 too, tries this radio's console. Without the right the radio hands his command up (protocol 14);
    // with it the radio would run it and answer him, and the app would hear nothing.
    this.later(20_000, () => {
      const bob = PEOPLE.find((q) => q.name.startsWith("Bob"));
      if (!bob || ((this.flags.get(bob) ?? 0) & 0x10) !== 0) return;
      this.queue.push(new ByteWriter().u8(Resp.ContactMsgRecvV3).i8(18).u16(0).bytes(bob.key.subarray(0, 6)).u8(bob.hops).u8(TxtType.CliCommand).u32(Math.floor(Date.now() / 1000)).string("reboot").toBytes());
      this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    });
    this.chatter = setInterval(() => void this.chat(), 25_000);
    this.murmur = setInterval(() => this.overhear(), 3_500);
    // The town's floods: every link once at first, so there is something to look through from the start.
    TOWN_FLOODS.forEach((path, i) => this.later(300 + i * 250, () => this.overhearTown(path)));
  }

  /**
   * A flood from somewhere in the town, as the radio hears it: a walk back
   * from a repeater it hears direct, each step to one that hears the next.
   * An advert names who sent it.
   */
  private overhearTown(given?: string[]): void {
    const heardHere = ["1a", "8d"];
    const path = given ? [...given] : [heardHere[Math.floor(Math.random() * heardHere.length)]!];
    const before = (to: string) => Object.keys(LINKS).filter((l) => l.endsWith(`>${to}`)).map((l) => l.split(">")[0]!).filter((f) => f !== "me" && !path.includes(f));
    const steps = given ? 0 : 1 + Math.floor(Math.random() * 5);
    for (let i = 0; i < steps; i++) {
      const options = before(path[0]!);
      if (!options.length) break;
      path.unshift(options[Math.floor(Math.random() * options.length)]!);
    }
    const snr = LINKS[`${path[path.length - 1]}>me`]! + (Math.random() * 2 - 1);
    const hops = path.map((h) => parseInt(h, 16));
    const senders = before(path[0]!);
    if (senders.length && Math.random() < 0.4) {
      const first = parseInt(senders[Math.floor(Math.random() * senders.length)]!, 16);
      const sender = PEOPLE.find((p) => p.key[0] === first && TOWN_HASHES.has(first))!;
      const advert = new Uint8Array(110);
      crypto.getRandomValues(advert);
      advert.set(sender.key, 0);
      this.emitFrame(this.heard(4, hops, advert, snr));
    } else {
      const noise = new Uint8Array(30);
      crypto.getRandomValues(noise);
      this.emitFrame(this.heard(5, hops, noise, snr));
    }
  }

  /** The mesh going about its business: adverts, acks and requests between others, which the radio overhears. */
  private overhear(): void {
    if (Math.random() < 0.45) return this.overhearTown();
    // The town's repeaters are heard only along the town's own links.
    // A stranger's adverts never reach this radio.
    const others = PEOPLE.filter((p) => !p.stranger && !(p.type === 2 && TOWN_HASHES.has(p.key[0]!)));
    const someone = others[Math.floor(Math.random() * others.length)]!;
    const pick = Math.random();
    const noise = (n: number) => {
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      return bytes;
    };
    const paths = [[0x03], [0x6f, 0x03], [0x2c, 0x94, 0x03], []];
    const path = paths[Math.floor(Math.random() * paths.length)]!;
    if (pick < 0.3) {
      const advert = noise(110);
      advert.set(someone.key, 0);
      this.emitFrame(this.heard(4, path, advert));
    } else if (pick < 0.55) {
      this.emitFrame(this.heard(3, path, noise(4)));
    } else if (pick < 0.8) {
      const sealed = noise(40);
      sealed[0] = PEOPLE[Math.floor(Math.random() * PEOPLE.length)]!.key[0]!;
      sealed[1] = someone.key[0]!;
      this.emitFrame(this.heard(2, path, sealed));
    } else {
      const request = noise(24);
      request[0] = 0x6f;
      request[1] = someone.key[0]!;
      this.emitFrame(this.heard(0, path, request));
    }
  }

  private async chat(): Promise<void> {
    const who = PEOPLE[Math.floor(Math.random() * 2)]!;
    const line = LINES[Math.floor(Math.random() * LINES.length)]!;
    if (Math.random() < 0.5) await this.heardChannel(0, who.name, line);
    else this.heardDm(who, line);
  }

  /** A channel message from somebody: its first copy, the message, then the copies other repeaters send on. */
  private async heardChannel(index: number, sender: string, text: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = await heardGroupTextPayload(fromHex(CHANNELS[index]!), timestamp, TxtType.Plain, `${sender}: ${text}`);
    const paths = [[0x03], [0x6f, 0x03], [0x2c, 0x94, 0x03]].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
    this.emitFrame(this.heard(5, paths[0]!, payload));
    this.queue.push(this.channel(index, sender, text, timestamp, paths[0]!.length));
    this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    paths.slice(1).forEach((path, i) => this.later(700 * (i + 1), this.heard(5, path, payload)));
    if (this.throughPhone && index === 0) this.later(8000, peerEntry("r:ch:0", readMarkValue({ timestamp, hash: textHash(text) })));
  }

  /** A direct message that flooded here: its packet names us and the sender, and a second copy trails it. */
  private heardDm(from: Person, text: string): void {
    const sealed = new Uint8Array(20);
    crypto.getRandomValues(sealed);
    sealed[0] = own.publicKey[0]!;
    sealed[1] = from.key[0]!;
    const path = RELAYS.slice(0, from.hops);
    this.emitFrame(this.heard(2, path, sealed));
    this.queue.push(this.dm(from, text));
    this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    this.later(900, this.heard(2, [0x6f, ...path], sealed));
  }

  /** A packet the radio heard, as it hands them up on LOG_RX_DATA: flooded, one-byte hashes. */
  private heard(payloadType: number, path: number[], payload: Uint8Array, snr = Math.random() * 20 - 8): Uint8Array {
    return new ByteWriter()
      .u8(Push.LogRxData)
      .i8(Math.round(snr * 4))
      .i8(-60 - Math.round(Math.random() * 50))
      .u8((payloadType << 2) | 1)
      .u8(path.length)
      .bytes(new Uint8Array(path))
      .bytes(payload)
      .toBytes();
  }

  private dm(from: Person, text: string): Uint8Array {
    return new ByteWriter()
      .u8(Resp.ContactMsgRecvV3)
      .i8(Math.round((Math.random() * 20 - 5) * 4))
      .u8(0)
      .u8(0)
      .bytes(from.key.subarray(0, 6))
      .u8(from.hops === 0xff ? 0xff : from.hops)
      .u8(TxtType.Plain)
      .u32(Math.floor(Date.now() / 1000))
      .string(text)
      .toBytes();
  }

  private channel(index: number, sender: string, text: string, timestamp = Math.floor(Date.now() / 1000), hops = 1): Uint8Array {
    return new ByteWriter()
      .u8(Resp.ChannelMsgRecvV3)
      .i8(Math.round((Math.random() * 20 - 5) * 4))
      .u8(0)
      .u8(0)
      .u8(index)
      .u8(hops)
      .u8(TxtType.Plain)
      .u32(timestamp)
      .string(`${sender}: ${text}`)
      .toBytes();
  }

  /** An emoji put on a channel message from Ommesh: a datagram, as the radio hands one up. */
  private reaction(index: number, target: Uint8Array, emoji: string, by: string): Uint8Array {
    const data = encodeReaction({ target, emoji, by, stamp: Math.floor(Date.now() / 1000) });
    return new ByteWriter()
      .u8(Resp.ChannelDataRecv)
      .i8(Math.round((Math.random() * 20 - 5) * 4))
      .u8(0)
      .u8(0)
      .u8(index)
      .u8(1)
      .u16(REACTION_DATA_TYPE)
      .u8(data.length)
      .bytes(data)
      .toBytes();
  }

  /** The contact the radio holds for `p`; a stranger's has only what was written for it, and no advert. */
  private held(p: Person, lastMod: number): Uint8Array {
    const written = p.stranger ? (this.written.get(p) ?? { name: "", lat: 0, lon: 0 }) : null;
    return contactFrame(Resp.Contact, written ? { ...p, ...written } : p, lastMod, this.routes.get(p), this.paths.get(p), this.flags.get(p), written ? 0 : undefined);
  }

  private person(key: Uint8Array): Person | undefined {
    return PEOPLE.find((p) => !this.gone.has(p) && key.every((b, i) => b === p.key[i]));
  }

  private sent(tag: number, flood = false): Uint8Array {
    return new ByteWriter().u8(Resp.Sent).u8(flood ? 1 : 0).u32(tag).u32(2500).toBytes();
  }

  /** Like the radio, what goes to a node floods when no route to it is held. */
  private floods(p: Person | undefined): boolean {
    return !p || this.routes.get(p) === 0xff;
  }

  /**
   * A console reply: queued as a CliData message and announced, after the node's pause. Like
   * the firmware, it is stamped with the node's clock as it answers.
   */
  private cliReply(p: Person, text: string, ms = 1100 + Math.random() * 900): void {
    const stamp = Math.floor(Date.now() / 1000) - (this.clocks.get(p) ?? 0);
    this.timers.push(
      setTimeout(() => {
        this.queue.push(
          new ByteWriter()
            .u8(Resp.ContactMsgRecvV3)
            .i8(24)
            .u16(0)
            .bytes(p.key.subarray(0, 6))
            .u8(p.hops)
            .u8(TxtType.CliData)
            .u32(stamp)
            .string(text)
            .toBytes(),
        );
        this.emitFrame(new Uint8Array([Push.MsgWaiting]));
      }, ms),
    );
  }

  private runCli(p: Person, command: string): string | null {
    const prefs = this.prefs.get(p)!;
    const get = /^get (\S+)$/.exec(command);
    const set = /^set (\S+) (.*)$/.exec(command);
    const clockText = (behind: number) => {
      const at = new Date(Date.now() - behind * 1000);
      return `${at.toISOString().slice(11, 16)} - ${at.getUTCDate()}/${at.getUTCMonth() + 1}/${at.getUTCFullYear()} UTC`;
    };
    if (command === "ver") return "v1.17.1 (Build: 14-Aug-2026)";
    if (command === "board") return "Demo board";
    if (command === "clock") return clockText(this.clocks.get(p) ?? 0);
    // Like the firmware: the clock only goes forward, to the command's stamp. The command lands
    // seconds after it was stamped, so a clock behind by less than that is refused too.
    if (command === "clock sync") {
      if ((this.clocks.get(p) ?? 0) < 3) return "ERR: clock cannot go backwards";
      this.clocks.set(p, 0);
      if (this.lostClockAnswer.delete(p)) return null;
      return `OK - clock set: ${clockText(0)}`;
    }
    // Back to 15 May 2024, and a restart that leaves no time to answer.
    if (command === "clkreboot") {
      this.clocks.set(p, Math.floor(Date.now() / 1000) - 1_715_770_351);
      return null;
    }
    if (command === "advert") return "OK - Advert sent";
    if (command === "advert.zerohop") return "OK - zerohop advert sent";
    if (command === "clear stats") return "OK";
    if (command === "reboot") return null;
    if (command === "discover.neighbors") {
      this.searched.set(p, Date.now());
      return "OK - Discover sent";
    }
    // As the firmware: an even count of hex digits, none at all matching every key.
    if (command.startsWith("neighbor.remove ")) {
      const prefix = command.slice(16).toLowerCase();
      if (prefix.length % 2 || !/^[0-9a-f]*$/.test(prefix)) return "ERR: bad pubkey";
      this.forgotten.set(p, [...(this.forgotten.get(p) ?? []), { prefix, at: Date.now() }]);
      return "OK";
    }
    if (command === "neighbors") return this.neighboursNow(p).slice(0, 5).map(([prefix, secs, snr]) => `${prefix.slice(0, 8)}:${secs}:${snr * 4}`).join("\n");
    if (command === "powersaving") return prefs["powersaving"]!;
    if (command === "powersaving on" || command === "powersaving off") {
      prefs["powersaving"] = command.slice(12);
      return command.endsWith("on") ? "on - After 2 minutes" : "off";
    }
    if (command.startsWith("password ")) return `password now: ${command.slice(9)}`;
    if (command.startsWith("tempradio ")) return `OK - temp params for ${command.split(",").pop()} mins`;
    if (command.startsWith("setperm ")) return "OK";
    if (get) return get[1]! in prefs ? `> ${prefs[get[1]!]}` : `??: ${get[1]}`;
    if (set) {
      if (!(set[1]! in prefs)) return `unknown config: ${set[1]}`;
      prefs[set[1]!] = set[2]!;
      if (set[1] === "radio") return "OK - reboot to apply";
      if (set[1] === "repeat") return `OK - repeat is now ${set[2] === "on" ? "ON" : "OFF"}`;
      return "OK";
    }
    return "Unknown command";
  }

  /**
   * A repeater's neighbours as it knows them now. After it calls them, those
   * it heard within the hour answer a second or so apart and are heard anew;
   * the rest stay silent, and Hill hears two repeaters it did not know. A
   * neighbour forgotten is gone until it is heard again.
   */
  private neighboursNow(p: Person): [string, number, number][] {
    const now = Date.now();
    const forgotten = this.forgotten.get(p) ?? [];
    // The listed ones were heard before anything was forgotten.
    const kept = (prefix: string, heardAt: number) => !forgotten.some((f) => f.at >= heardAt && prefix.startsWith(f.prefix));
    const all = neighboursOf(p);
    const heard = new Map(all.filter(([prefix]) => kept(prefix, 0)).map((row) => [row[0], row]));
    const at = this.searched.get(p);
    if (at === undefined) return [...heard.values()];
    const since = (now - at) / 1000;
    const answers = all.filter(([, secs]) => secs < 3600);
    if (p.name === "Hill Repeater") answers.splice(1, 0, ["c3a91e7700b2", 0, -4.75], ["5e0f4d21a8c6", 0, 1.5]);
    answers.forEach(([prefix, , snr], i) => {
      const delay = 0.8 + i * 0.6;
      if (since >= delay && kept(prefix, at + delay * 1000)) heard.set(prefix, [prefix, Math.floor(since - delay), snr]);
    });
    return [...heard.values()];
  }

  private binary(p: Person, tag: number, req: Uint8Array): Uint8Array | null {
    const w = new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(tag);
    switch (req[0]) {
      case ReqType.GetNeighbours: {
        const count = req[2] ?? 10;
        const offset = (req[3] ?? 0) | ((req[4] ?? 0) << 8);
        const order = req[5] ?? 0;
        const all = this.neighboursNow(p);
        const sorted = [...all].sort((a, b) => (order === 0 ? a[1] - b[1] : order === 1 ? b[1] - a[1] : order === 2 ? b[2] - a[2] : a[2] - b[2]));
        const page = sorted.slice(offset, offset + Math.min(count, 11));
        w.u16(all.length).u16(page.length);
        for (const [prefix, secs, snr] of page) w.bytes(fromHex(prefix)).u32(secs).i8(Math.round(snr * 4));
        return w.toBytes();
      }
      case ReqType.GetAccessList:
        if (!this.admins.has(p)) return null;
        w.bytes(own.publicKey.subarray(0, 6)).u8(3).bytes(PEOPLE[0]!.key.subarray(0, 6)).u8(3);
        if (p.type !== 3) w.bytes(PEOPLE[1]!.key.subarray(0, 6)).u8(2).bytes(fromHex("91c2e0a1b2c3")).u8(1);
        return w.toBytes();
      case ReqType.GetOwnerInfo:
        return w.string(`v1.17.1\n${p.name}\n${this.prefs.get(p)!["owner.info"]!.replace(/\|/g, "\n")}`).toBytes();
      case ReqType.Subscribe: {
        // MeshCore 1.18: the sensor sends its readings by itself under the app's tag, here every 20 s,
        // for as long as it was asked (its region is the demo's). The app's own clock tells the time.
        if (p.type !== 4) return null;
        const pushTag = (req[1] ?? 0) | ((req[2] ?? 0) << 8) | ((req[3] ?? 0) << 16) | ((req[4] ?? 0) << 24);
        const secs = (req[5] ?? 0) | ((req[6] ?? 0) << 8);
        if (this.pushTimer) clearInterval(this.pushTimer);
        const until = Date.now() + secs * 1000;
        this.pushTimer = setInterval(() => {
          if (Date.now() > until) return;
          this.emitFrame(
            new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(pushTag >>> 0).u32(Math.floor(Date.now() / 1000)).bytes(DEMO_TELEMETRY_OTHER).bytes(weatherLpp()).toBytes(),
          );
        }, 20_000);
        return w.u16(secs).u16(0).string("omsk").toBytes();
      }
      case ReqType.Unsubscribe:
        if (this.pushTimer) clearInterval(this.pushTimer);
        this.pushTimer = null;
        return w.zeros(10).toBytes();
      case ReqType.GetAvgMinMax: {
        const span = (req[1] ?? 0) | ((req[2] ?? 0) << 8) | ((req[3] ?? 0) << 16);
        const wide = Math.min(1, span / (7 * 86400));
        const be = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
        const series = (type: number, scale: number, min: number, max: number, avg: number) =>
          w.u8(1).u8(type).bytes(be(Math.round(min * scale))).bytes(be(Math.round(max * scale))).bytes(be(Math.round(avg * scale)));
        w.u32(Math.floor(Date.now() / 1000));
        series(0x67, 10, 13.6 - 7 * wide, 14.4 + 7 * wide, 14.0 - 1.5 * wide);
        series(0x68, 10, 69 - 20 * wide, 72 + 22 * wide, 70.5);
        series(0x73, 10, 1012.1 - 14 * wide, 1012.5 + 7 * wide, 1012.3 - 4 * wide);
        series(0x74, 100, 3.97 - 0.12 * wide, 3.98 + 0.08 * wide, 3.98 - 0.02 * wide);
        return w.toBytes();
      }
      default:
        return null;
    }
  }

  async send(frame: Uint8Array): Promise<void> {
    // For the phone's app, which the relay takes: nothing answers it.
    if (frame[0] === Push.Peer) return;
    if (frame[0] === Cmd.SignFinish) {
      const data = this.signing;
      this.signing = null;
      const reply = data ? new ByteWriter().u8(Resp.Signature).bytes(await signWith(own.privateKey, data)).toBytes() : new Uint8Array([Resp.Err, 4]);
      this.timers.push(setTimeout(() => this.emitFrame(reply), 15));
      return;
    }
    const replies = this.answer(frame);
    const t = setTimeout(() => {
      for (const r of replies) this.emitFrame(r);
    }, 15);
    this.timers.push(t);
  }

  /** A heard packet goes up only whole in one frame, as the firmware's `logRxRaw` sends it; a longer one is dropped (#84). */
  protected override emitFrame(frame: Uint8Array): void {
    if (frame[0] === Push.LogRxData && frame.length > MAX_FRAME_SIZE) return;
    super.emitFrame(frame);
  }

  private later(ms: number, frame: Uint8Array | (() => void)): void {
    this.timers.push(setTimeout(() => (typeof frame === "function" ? frame() : this.emitFrame(frame)), ms));
  }

  private ownTx = 22;

  /** A few of upstream's companion console commands, word for word; the rest are unknown as they would be there. */
  private ownCli(command: string): string {
    const { frequencyKhz, bandwidthHz, spreadingFactor, codingRate, pathHashMode } = this.radio;
    // It is on the network it was given before its last start.
    const running = ownWifi.started;
    const wifi = ownWifi.wifi;
    switch (command) {
      case "get wifi.ssid":
        return `> ${wifi.ssid || "(not set)"}`;
      case "get wifi.pwd":
        return `> ${wifi.pwd}`;
      case "get wifi.enabled":
        return `> ${wifi.enabled}`;
      case "get wifi.status":
        return running.enabled && running.ssid ? "> connected" : "> disconnected";
      case "get wifi.ip":
        return running.enabled && running.ssid ? "> 192.168.1.42" : "> (not connected)";
      case "set wifi.clear":
        ownWifi.wifi = { ...wifi, ssid: "", pwd: "" };
        return "> wifi config cleared (reboot to apply)";
      case "get tz.offset":
        return `> ${ownWifi.tzOffset}`;
    }
    if (command.startsWith("set wifi.ssid ")) {
      wifi.ssid = command.slice(14, 14 + 32);
      return `> wifi.ssid is now ${wifi.ssid} (set wifi.pwd too, then reboot)`;
    }
    if (command.startsWith("set wifi.pwd ")) {
      wifi.pwd = command.slice(13, 13 + 63);
      return "> wifi.pwd updated (reboot to apply)";
    }
    if (command.startsWith("set wifi.enabled ")) {
      wifi.enabled = Number(command.slice(17)) ? 1 : 0;
      return `> wifi.enabled is now ${wifi.enabled} (reboot to apply)`;
    }
    if (command.startsWith("set tz.offset ")) {
      const tz = Math.trunc(Number(command.slice(14)));
      if (!(tz >= -12 && tz <= 14)) return "Error, must be from -12 to +14";
      ownWifi.tzOffset = tz;
      return "OK";
    }
    switch (command) {
      case "ver":
        return "v1.18.0 (Build: 15 Oct 2026)";
      case "board":
        return "Demo board";
      case "get name":
        return "> Demo radio";
      case "get radio":
        return `> ${(frequencyKhz / 1000).toFixed(6)},${bandwidthHz / 1000},${spreadingFactor},${codingRate}`;
      case "get freq":
        return `> ${(frequencyKhz / 1000).toFixed(6)}`;
      case "get tx":
        return `> ${this.ownTx}`;
      case "get af":
        return "> 1.0";
      case "get dutycycle":
        return "> 50.0%";
      case "get path.hash.mode":
        return `> ${pathHashMode}`;
      case "get multi.acks":
        return "> 0";
      case "get radio.rxgain":
        return "> on";
    }
    const tx = /^set tx (-?\d+)$/.exec(command);
    if (tx) {
      const dbm = Number(tx[1]);
      if (dbm < -9 || dbm > 22) return "Error, must be -9 to 22";
      this.ownTx = dbm;
      return "OK";
    }
    if (command.startsWith("set radio ")) return "OK - reboot to apply";
    if (/^set (name|af|rxdelay|multi\.acks|path\.hash\.mode|radio\.rxgain) /.test(command)) return "OK";
    if (command.startsWith("set pin ")) return `> pin is now ${command.slice(8).padStart(6, "0")}`;
    return "Unknown command";
  }

  private answer(frame: Uint8Array): Uint8Array[] {
    const code = frame[0];
    switch (code) {
      case Cmd.DeviceQuery:
        return [
          new ByteWriter()
            .u8(Resp.DeviceInfo)
            .u8(14)
            .u8(50)
            .u8(8)
            .u32(own.blePin)
            .fixedString("15 Oct 2026", 12)
            .fixedString("Demo board", 40)
            .fixedString("v1.18.0", 20)
            .u8(this.radio.repeat ? 1 : 0)
            .u8(this.radio.pathHashMode)
            .toBytes(),
        ];
      case Cmd.AppStart:
        return [
          new ByteWriter()
            .u8(Resp.SelfInfo)
            .u8(1)
            .i8(22)
            .i8(22)
            .bytes(own.publicKey)
            .i32(55_020_000)
            .i32(73_360_000)
            .u8(0)
            .u8(1)
            .u8(2)
            .u8(0)
            .u32(this.radio.frequencyKhz)
            .u32(this.radio.bandwidthHz)
            .u8(this.radio.spreadingFactor)
            .u8(this.radio.codingRate)
            .string(own.name)
            .toBytes(),
          ...(this.throughPhone ? [new Uint8Array([Push.Peer, PEER_HELLO, 1, 1])] : []),
        ];
      case Cmd.GetDeviceTime:
        return [new ByteWriter().u8(Resp.CurrTime).u32(Math.floor(Date.now() / 1000)).toBytes()];
      case Cmd.GetContacts: {
        const kept = PEOPLE.filter((p) => !this.gone.has(p));
        // The radio stamps a contact with the moment it stored its last advert.
        const stamp = (p: Person) => Math.floor(Date.now() / 1000) - (p.ago ?? 600);
        return [
          new ByteWriter().u8(Resp.ContactsStart).u32(kept.length).toBytes(),
          ...kept.map((p) => this.held(p, stamp(p))),
          new ByteWriter().u8(Resp.EndOfContacts).u32(Math.floor(Date.now() / 1000)).toBytes(),
        ];
      }
      case Cmd.RemoveContact: {
        const p = this.person(frame.subarray(1, 33));
        if (!p) return [new Uint8Array([Resp.Err, 2])];
        this.gone.add(p);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetAutoAddConfig:
        return [new Uint8Array([Resp.AutoAddConfig, this.autoAdd.config, this.autoAdd.maxHops])];
      case Cmd.SetAutoAddConfig:
        this.autoAdd = { config: frame[1] ?? 0, maxHops: frame[2] ?? 0 };
        return [new Uint8Array([Resp.Ok])];
      case Cmd.GetContactByKey: {
        const p = this.person(frame.subarray(1, 33));
        return p ? [this.held(p, Math.floor(Date.now() / 1000))] : [new Uint8Array([Resp.Err, 2])];
      }
      case Cmd.ResetPath: {
        const p = this.person(frame.subarray(1, 33));
        if (p) this.routes.set(p, 0xff);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.SendChannelTxtMsg: {
        // Repeaters send it on, and the radio overhears them.
        const index = frame[2] ?? 0;
        const timestamp = (frame[3]! | (frame[4]! << 8) | (frame[5]! << 16) | (frame[6]! << 24)) >>> 0;
        const text = fromUtf8(frame.subarray(7));
        // On Friends the repeaters miss the first send of every text, so a
        // message there turns unheard and a second send gets through.
        if (index === 1 && !this.missed.has(text)) {
          this.missed.add(text);
          return [new Uint8Array([Resp.Ok])];
        }
        void groupTextPayload(fromHex(CHANNELS[index] ?? CHANNELS[0]!), timestamp, own.name, text).then((payload) => {
          [[0x03], [0x03, 0x94], [0x2c]].forEach((path, i) => this.later(600 * (i + 1), this.heard(5, path, payload)));
        });
        // Alice likes whatever is said on Public.
        if (index === 0) {
          void messageHash(text, timestamp).then((hash) =>
            this.later(2500, () => {
              this.queue.push(this.reaction(0, hash, "👍", "Alice"));
              this.emitFrame(new Uint8Array([Push.MsgWaiting]));
            }),
          );
        }
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.SendChannelData: {
        // A reaction: Public's repeaters send it on, and Friends' miss the first try of each, as they do texts.
        const index = frame[1] ?? 0;
        const data = frame.subarray(5);
        const target = toHex(data.subarray(1, 6));
        if (index === 1 && !this.missed.has(`reaction:${target}`)) {
          this.missed.add(`reaction:${target}`);
          return [new Uint8Array([Resp.Ok])];
        }
        const type = frame[3]! | (frame[4]! << 8);
        // A couple of seconds pass before the first repeater is heard, so the chip's outline shows a while.
        void groupDataPayload(fromHex(CHANNELS[index] ?? CHANNELS[0]!), type, data).then((payload) => this.later(2000, this.heard(6, [0x03], payload)));
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetChannel: {
        const index = frame[1] ?? 0;
        if (wiped) {
          const held = wiped.channels.get(index);
          return [held ? new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString(held.name, 32).bytes(held.secret).toBytes() : new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString("", 32).zeros(16).toBytes()];
        }
        if (index === 0) return [new ByteWriter().u8(Resp.ChannelInfo).u8(0).fixedString("Public", 32).bytes(fromHex(CHANNELS[0]!)).toBytes()];
        if (index === 1) return [new ByteWriter().u8(Resp.ChannelInfo).u8(1).fixedString("Friends", 32).bytes(fromHex(CHANNELS[1]!)).toBytes()];
        return [new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString("", 32).zeros(16).toBytes()];
      }
      case Cmd.SetChannel:
        // Kept only once the radio was reset: before, its two channels are fixed.
        wiped?.channels.set(frame[1] ?? 0, { name: fromUtf8(frame.subarray(2, 34)).replace(/\0.*$/s, ""), secret: frame.slice(34, 50) });
        return [new Uint8Array([Resp.Ok])];
      case Cmd.FactoryReset:
        // As the firmware: everything goes, the radio makes itself a new key and a name from it, and starts again.
        wiped = { gone: new Set(PEOPLE), channels: new Map([[0, { name: "Public", secret: fromHex(CHANNELS[0]!) }]]) };
        own.privateKey = freshKey();
        own.publicKey = publicKeyOf(own.privateKey);
        own.name = toHex(own.publicKey).slice(0, 8).toUpperCase();
        own.blePin = 0;
        this.timers.push(
          setTimeout(() => {
            void this.shutdown();
            this.emitClose(new Error("the radio was reset"));
          }, 200),
        );
        return [new Uint8Array([Resp.Ok])];
      case Cmd.SyncNextMessage:
        return [this.queue.shift() ?? new Uint8Array([Resp.NoMoreMessages])];
      case Cmd.GetBattAndStorage:
        return [new ByteWriter().u8(Resp.BattAndStorage).u16(3980).u32(120).u32(1024).toBytes()];
      case Cmd.GetTuningParams:
        return [new ByteWriter().u8(Resp.TuningParams).u32(0).u32(1000).toBytes()];
      case Cmd.GetCustomVars:
        // The demo radio has no GPS of its own: it is put where the phone is.
        return [new Uint8Array([Resp.CustomVars])];
      case Cmd.RunCliCommand: {
        // The radio's own console, answered in upstream MeshCore's words (protocol 14).
        let text = fromUtf8(frame.subarray(1));
        let tag = "";
        if (text.length > 4 && text[2] === "|") [tag, text] = [text.slice(0, 3), text.slice(3)];
        if (text === "reboot" || text === "poweroff" || text === "shutdown") {
          ownWifi.started = { ssid: ownWifi.wifi.ssid, enabled: ownWifi.wifi.enabled };
          // Upstream answers neither: the radio is gone from this link.
          this.timers.push(
            setTimeout(() => {
              void this.shutdown();
              this.emitClose(new Error("the radio rebooted"));
            }, 200),
          );
          return [];
        }
        return [new ByteWriter().u8(Resp.CliReply).string(tag + this.ownCli(text)).toBytes()];
      }
      case Cmd.SendTxtMsg: {
        if (frame[1] === TxtType.CliCommand) {
          const p = this.person(frame.subarray(7, 13));
          const text = fromUtf8(frame.subarray(13));
          const tagged = /^([0-9a-f]{2})\|(.*)$/s.exec(text);
          const command = tagged ? tagged[2]! : text;
          // Alice gave this radio the right to control hers (MeshCore 1.18); Bob and Kolya did not, and say nothing.
          if (p?.name === "Alice") {
            const reply = command === "ver" ? "v1.18.0 (Build: 15 Oct 2026)" : command === "get name" ? "> Alice" : command === "board" ? "Heltec V4" : command === "get tz.offset" ? "> 6" : "Unknown command";
            this.cliReply(p, tagged ? `${tagged[1]}|${reply}` : reply);
          }
          return [this.sent(0, this.floods(p))];
        }
        if (frame[1] === TxtType.CliData) {
          const p = this.person(frame.subarray(7, 13));
          const text = fromUtf8(frame.subarray(13));
          const tagged = /^([0-9a-f]{2})\|(.*)$/s.exec(text);
          // Like the firmware: the console answers admins, and a stranger hears nothing.
          if (p && this.prefs.has(p) && this.admins.has(p)) {
            const reply = this.runCli(p, tagged ? tagged[2]! : text);
            if (reply !== null) this.cliReply(p, tagged ? `${tagged[1]}|${reply}` : reply);
          }
          return [this.sent(0, this.floods(p))];
        }
        const p = this.person(frame.subarray(7, 13));
        const tag = this.acks++;
        const confirmed = new ByteWriter().u8(Push.SendConfirmed).u32(tag).u32(1400).toBytes();
        const flood = !p || this.routes.get(p) === 0xff;
        if (p?.name.startsWith("Kolya")) {
          // Kolya is out camping, past the reach of the mesh: no try gets to him, and nothing comes back.
        } else if (flood) {
          // The acknowledgement rides back on the route the flood took: the radio learns it first.
          this.later(1500 + Math.random() * 1500, () => {
            if (p) {
              this.routes.set(p, 1 + Math.floor(Math.random() * 3));
              this.emitFrame(new ByteWriter().u8(Push.PathUpdated).bytes(p.key).toBytes());
            }
            this.emitFrame(confirmed);
          });
        } else if (!(p.name.startsWith("Bob") && Math.random() < 0.6)) {
          // Bob is on his bike: more often than not, the route he was last reached by is gone.
          this.later(900 + Math.random() * 1500, confirmed);
        }
        // Alice likes what she is sent, and says so as console data, as Ommesh does in a direct chat.
        if (p?.name === "Alice") {
          const stamp = (frame[3]! | (frame[4]! << 8) | (frame[5]! << 16) | (frame[6]! << 24)) >>> 0;
          void messageHash(fromUtf8(frame.subarray(13)), stamp).then((hash) =>
            this.later(3000, () => {
              this.queue.push(
                new ByteWriter().u8(Resp.ContactMsgRecvV3).i8(24).u16(0).bytes(p.key.subarray(0, 6)).u8(p.hops).u8(TxtType.CliData).u32(Math.floor(Date.now() / 1000)).string(directReactionText("👍", hash)).toBytes(),
              );
              this.emitFrame(new Uint8Array([Push.MsgWaiting]));
            }),
          );
        }
        return [new ByteWriter().u8(Resp.Sent).u8(flood ? 1 : 0).u32(tag).u32(3000).toBytes()];
      }
      case Cmd.SendLogin: {
        const p = this.person(frame.subarray(1, 33));
        const password = fromUtf8(frame.subarray(33));
        if (!p || !this.prefs.has(p)) return [new Uint8Array([Resp.Err, 2])];
        if (password === "wrong" || (p.type === 4 && password === "guest")) {
          this.later(1400, new ByteWriter().u8(Push.LoginFail).u8(0).bytes(p.key.subarray(0, 6)).toBytes());
        } else {
          // "guest" signs in as a guest (a room's guests may post); anything else, blank included, as admin.
          const guest = password === "guest";
          if (guest) this.admins.delete(p);
          else this.admins.add(p);
          const drift = this.clocks.get(p) ?? 0;
          this.later(
            1400,
            new ByteWriter()
              .u8(Push.LoginSuccess)
              .u8(guest ? 0 : 1)
              .bytes(p.key.subarray(0, 6))
              .u32(Math.floor(Date.now() / 1000) - drift)
              .u8(guest ? (p.type === 3 ? 2 : 0) : 3)
              .u8(p.type === 2 ? 2 : 1)
              .toBytes(),
          );
        }
        return [new ByteWriter().u8(Resp.Sent).u8(this.floods(p) ? 1 : 0).bytes(p.key.subarray(0, 4)).u32(2500).toBytes()];
      }
      case Cmd.SendStatusReq: {
        const p = this.person(frame.subarray(1, 33));
        const room = p?.type === 3;
        const hours = (Date.now() / 3_600_000) % 24;
        const mv = room ? 4200 : Math.round(4050 + 80 * Math.sin((hours / 24) * Math.PI * 2) + Math.random() * 20);
        const w = new ByteWriter()
          .u8(Push.StatusResponse)
          .u8(0)
          .bytes(frame.subarray(1, 7))
          .u16(mv)
          .u16(Math.random() < 0.8 ? 0 : 2)
          .u16((-112 + Math.round(Math.random() * 4)) & 0xffff)
          .u16(-98 & 0xffff)
          .u32(48213)
          .u32(21907)
          .u32(22080)
          .u32(86400 * 12 + 4 * 3600)
          .u32(19204)
          .u32(2703)
          .u32(41880)
          .u32(6333)
          .u16(0)
          .u16(25)
          .u16(88)
          .u16(9412);
        if (room) w.u16(184).u16(1203);
        else w.u32(111_600).u32(1_480);
        this.later(1500, w.toBytes());
        return [this.sent(this.acks++, this.floods(p))];
      }
      case Cmd.SendTelemetryReq: {
        const prefix = frame.length > 4 ? frame.subarray(4, 10) : own.publicKey.subarray(0, 6);
        this.later(
          frame.length > 4 ? 1500 : 50,
          new ByteWriter()
            .u8(Push.TelemetryResponse)
            .u8(0)
            .bytes(prefix)
            .bytes(frame.length > 4 ? DEMO_TELEMETRY_OTHER : demoTelemetrySelf())
            .bytes(frame.length > 4 && this.person(frame.subarray(4, 10))?.type === 4 ? weatherLpp() : new Uint8Array())
            .toBytes(),
        );
        return frame.length > 4 ? [this.sent(this.acks++, this.floods(this.person(frame.subarray(4, 10))))] : [];
      }
      case Cmd.SendBinaryReq: {
        const p = this.person(frame.subarray(1, 33));
        const tag = this.acks++;
        const reply = p ? this.binary(p, tag, frame.subarray(33)) : null;
        if (reply) this.later(1600, reply);
        return [this.sent(tag, this.floods(p))];
      }
      case Cmd.SendAnonReq: {
        // A repeater in range lists its regions after its clock; anyone else, or any other question, says nothing.
        const p = this.person(frame.subarray(1, 33));
        const tag = this.acks++;
        const regions = p && frame[33] === 0x01 ? REGIONS[p.name] : undefined;
        if (regions) this.later(900, new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(tag).u32(Math.floor(Date.now() / 1000)).string(regions).toBytes());
        return [this.sent(tag)];
      }
      case Cmd.GetDefaultFloodScope:
        return [this.region ? new ByteWriter().u8(Resp.DefaultFloodScope).bytes(this.region).toBytes() : new Uint8Array([Resp.DefaultFloodScope])];
      case Cmd.SetDefaultFloodScope:
        this.region = frame.length >= 48 ? frame.slice(1, 48) : null;
        return [new Uint8Array([Resp.Ok])];
      case Cmd.SendPathDiscoveryReq: {
        // The flood finds a shorter way than the one held, when there is one to shorten; the answer comes back the other way round.
        const p = this.person(frame.subarray(2, 34));
        if (!p) return [new Uint8Array([Resp.Err, 2])];
        const held = this.paths.get(p) ?? (p.hops === 0xff ? [RELAYS[0]!] : RELAYS.slice(0, p.hops));
        const out = held.length > 1 ? [held[0]!, ...held.slice(2)] : held;
        const back = out.slice().reverse();
        this.later(2200, new ByteWriter().u8(Push.PathDiscoveryResponse).u8(0).bytes(p.key.subarray(0, 6)).u8(out.length).bytes(new Uint8Array(out)).u8(back.length).bytes(new Uint8Array(back)).toBytes());
        return [new ByteWriter().u8(Resp.Sent).u8(1).u32(this.acks++).u32(3000).toBytes()];
      }
      case Cmd.SendTracePath: {
        // Out along the path and back: each node adds how well it heard the one before, and any hop may lose it.
        const tag = frame.subarray(1, 5);
        const flags = frame[9] ?? 0;
        const size = 1 << (flags & 3);
        const path = frame.subarray(10);
        const hashes = Array.from({ length: path.length / size }, (_, i) => path[i * size]!);
        // Each node hears the one before it, and this radio hears the last; a pair that does not hear each other loses it.
        const nodes: (number | "me")[] = ["me", ...hashes, "me"];
        const legs = nodes.slice(1).map((b, i) => legSnr(nodes[i]!, b));
        const snrs = legs.slice(0, -1).map((s) => s ?? 0);
        const final = legs[legs.length - 1] ?? 0;
        const back = legs.every((s) => s !== null && through(s));
        // Shorter than a real radio would say, so a trace lost in the demo is not waited on for long.
        const estimate = 600 + 350 * (hashes.length + 1);
        if (back) {
          const trip = 170 * (hashes.length + 1) + Math.random() * 90 * hashes.length;
          this.later(
            trip,
            new ByteWriter()
              .u8(Push.TraceData)
              .u8(0)
              .u8(path.length)
              .u8(flags)
              .bytes(tag)
              .u32(0)
              .bytes(path)
              .bytes(new Uint8Array(snrs.map((s) => Math.round(s * 4) & 0xff)))
              .i8(Math.round(final * 4))
              .toBytes(),
          );
        }
        return [new ByteWriter().u8(Resp.Sent).u8(0).bytes(tag).u32(estimate).toBytes()];
      }
      case Cmd.SendControlData: {
        // Who hears me: the repeaters in range answer after a pause of their own, with how they heard us.
        if (((frame[1] ?? 0) & 0xf0) === 0x80) {
          const tag = frame.subarray(3, 7);
          for (const p of PEOPLE.filter((x) => x.type === 2 && x.hops <= 1)) {
            if (!p.stranger && Math.random() < 0.15) continue;
            const us = heardAt(p.key[0]!);
            const them = heardAt(p.key[0]!) + 1;
            this.later(
              500 + Math.random() * 6000,
              new ByteWriter()
                .u8(Push.ControlData)
                .i8(Math.round(them * 4))
                .i8(-100 + Math.round(them * 2))
                .u8(0)
                .u8(0x92)
                .i8(Math.round(us * 4))
                .bytes(tag)
                // An ask that wants prefixes gets the first eight bytes of the key.
                .bytes((frame[1] ?? 0) & 1 ? p.key.subarray(0, 8) : p.key)
                .toBytes(),
            );
          }
        }
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetStats:
        // Core: its battery, two hours and a quarter up, no errors, nothing queued.
        if (frame[1] === 0) return [new ByteWriter().u8(Resp.Stats).u8(0).u16(3980).u32(8040).u16(0).u8(0).toBytes()];
        if (frame[1] !== 1) return [new Uint8Array([Resp.Err, 1])];
        return [
          new ByteWriter()
            .u8(Resp.Stats)
            .u8(1)
            .u16((-114 + Math.round(Math.random() * 4)) & 0xffff)
            .i8(-96)
            .i8(26)
            .u32(412)
            .u32(9120)
            .toBytes(),
        ];
      case Cmd.GetAdvertPath: {
        const p = this.person(frame.subarray(2, 34));
        if (!p || p.hops === 0xff) return [new Uint8Array([Resp.Err, 2])];
        // An advert comes in the other way round: its first relay is the one nearest to it.
        const relays = (this.paths.get(p) ?? RELAYS.slice(0, p.hops)).slice().reverse();
        return [new ByteWriter().u8(Resp.AdvertPath).u32(Math.floor(Date.now() / 1000) - 900).u8(relays.length).bytes(new Uint8Array(relays)).toBytes()];
      }
      case Cmd.AddUpdateContact: {
        const key = frame.subarray(1, 33);
        const p = PEOPLE.find((x) => key.every((b, i) => b === x.key[i]));
        const length = frame[35] ?? 0xff;
        if (p) {
          this.gone.delete(p);
          this.flags.set(p, frame[34] ?? 0);
          if (p.stranger) {
            const at = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
            const name = fromUtf8(frame.subarray(100, 132)).replace(/\0.*$/s, "");
            this.written.set(p, { name, lat: frame.length >= 144 ? at.getInt32(136, true) / 1e6 : 0, lon: frame.length >= 144 ? at.getInt32(140, true) / 1e6 : 0 });
          }
          this.routes.set(p, length);
          if (length !== 0xff) this.paths.set(p, Array.from(frame.subarray(36, 36 + (length & 63))));
        }
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.SetRadioParams: {
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const frequencyKhz = view.getUint32(1, true);
        // As the firmware: a missing repeat byte is "off", and repeat is refused off its frequencies.
        const repeat = frame.length > 11 && frame[11] !== 0;
        if (repeat && !DEMO_REPEAT_KHZ.includes(frequencyKhz)) return [new Uint8Array([Resp.Err, 6])];
        this.radio = { ...this.radio, frequencyKhz, bandwidthHz: view.getUint32(5, true), spreadingFactor: frame[9]!, codingRate: frame[10]!, repeat };
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetAllowedRepeatFreq: {
        const w = new ByteWriter().u8(Resp.AllowedRepeatFreq);
        for (const khz of DEMO_REPEAT_KHZ) w.u32(khz).u32(khz);
        return [w.toBytes()];
      }
      case Cmd.SetPathHashMode:
        if (frame[1] !== 0 || frame[2]! >= 3) return [new Uint8Array([Resp.Err, 6])];
        this.radio = { ...this.radio, pathHashMode: frame[2]! };
        return [new Uint8Array([Resp.Ok])];
      case Cmd.ExportPrivateKey:
        return [new ByteWriter().u8(Resp.PrivateKey).bytes(own.privateKey).toBytes()];
      // As the firmware: the data comes in pieces after a start, up to 8 KB, and the signature at the finish (in `send`).
      case Cmd.SignStart:
        this.signing = new Uint8Array(0);
        return [new ByteWriter().u8(Resp.SignStart).u8(0).u32(8 * 1024).toBytes()];
      case Cmd.SignData: {
        if (!this.signing) return [new Uint8Array([Resp.Err, 4])];
        if (this.signing.length + frame.length - 1 > 8 * 1024) return [new Uint8Array([Resp.Err, 3])];
        const more = new Uint8Array(this.signing.length + frame.length - 1);
        more.set(this.signing);
        more.set(frame.subarray(1), this.signing.length);
        this.signing = more;
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.ImportPrivateKey: {
        // The firmware checks the key the way `privateKeyFault` does, and refuses an unfit one as an illegal argument.
        const key = frame.slice(1, 65);
        if (key.length !== 64 || privateKeyFault(key)) return [new Uint8Array([Resp.Err, 6])];
        own.privateKey = key;
        own.publicKey = publicKeyOf(key);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.SetAdvertName:
        own.name = new TextDecoder().decode(frame.subarray(1));
        return [new Uint8Array([Resp.Ok])];
      case Cmd.SetDevicePin: {
        // As the firmware: the PIN of its own, or six digits that do not start with 0.
        const pin = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, true);
        if (pin !== 0 && (pin < 100_000 || pin > 999_999)) return [new Uint8Array([Resp.Err, 6])];
        own.blePin = pin;
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.Reboot:
        // A radio that reboots says nothing more on this link, and starts with the Wi-Fi it was given.
        ownWifi.started = { ssid: ownWifi.wifi.ssid, enabled: ownWifi.wifi.enabled };
        this.timers.push(
          setTimeout(() => {
            void this.shutdown();
            this.emitClose(new Error("the radio rebooted"));
          }, 200),
        );
        return [];
      default:
        // Everything else is a setting: say yes.
        return [new Uint8Array([Resp.Ok])];
    }
  }

  protected async shutdown(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    if (this.chatter) clearInterval(this.chatter);
    if (this.murmur) clearInterval(this.murmur);
    if (this.pushTimer) clearInterval(this.pushTimer);
  }
}

export const demoConnector: Connector = {
  id: "demo",
  kind: "ble",
  get title() {
    return t("connect.transport.demo");
  },
  get description() {
    return t("connect.describe.demo");
  },
  mode: "scan",
  async scan(onFound) {
    onFound([
      { id: "demo", name: "MeshCore-demo", detail: t("connect.device.noHardware"), rssi: -42 },
      // The same radio through a phone that shares it, for what two apps keep alike.
      { id: "demo-phone", name: "Ommesh demo", detail: t("connect.device.noHardware"), rssi: -55 },
    ]);
  },
  async remembered() {
    return [];
  },
  async connect(device): Promise<Transport> {
    const radio = new DemoRadio(device?.id === "demo-phone");
    radio.start();
    return radio;
  },
};

export function demoWanted(): boolean {
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has("demo");
}
