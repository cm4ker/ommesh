import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseTransport, type Transport } from "@meshnet/meshcore";
import { BluetoothOffError, type Connector, type FoundDevice } from "../transports/types.js";
import { cancelConnect, connectWith, disconnect, getLink, reconnectNow } from "./link.js";
import { demoConnector } from "../transports/demo.js";
import { lastLink } from "../transports/index.js";
import { session } from "./session.js";

class IdleRadio extends BaseTransport {
  readonly kind = "ble" as const;
  shut = false;
  constructor(readonly label: string) {
    super();
  }
  async send(): Promise<void> {}
  protected async shutdown(): Promise<void> {
    this.shut = true;
  }
}

/** A connector whose every connect waits until the test answers it. */
function slowConnector(): { connector: Connector; answer: (transport: Transport) => void } {
  const waiting: ((transport: Transport) => void)[] = [];
  const connector: Connector = {
    id: "slow",
    kind: "ble",
    title: "Slow",
    description: "",
    mode: "scan",
    remembered: async () => [],
    connect: () => new Promise<Transport>((resolve) => waiting.push(resolve)),
  };
  return { connector, answer: (transport) => waiting.shift()?.(transport) };
}

const radio = (name: string): FoundDevice => ({ id: name, name, detail: null, rssi: null });

test("a radio given up while it was still connecting is let go when it answers, not handed to the session", async () => {
  const { connector, answer } = slowConnector();
  const attempt = connectWith(connector, radio("Node-21"));
  await disconnect();
  const late = new IdleRadio("Node-21");
  answer(late);
  await attempt;
  // The late link is closed on the next turns.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(late.shut, true);
  assert.equal(session.getState().link, null);
  assert.equal(getLink().phase, "idle");
});

test("a connect names the radio it is for, and Cancel says so at once, before the radio has answered", async () => {
  const { connector, answer } = slowConnector();
  const device = radio("Node-21");
  const attempt = connectWith(connector, device);
  assert.deepEqual(getLink().target, { connectorId: "slow", device });
  // A radio asked for anew is connected from the connect screen, not over the last one's chats.
  assert.equal(getLink().dropped, false);
  const cancelling = cancelConnect();
  assert.equal(getLink().phase, "idle");
  assert.equal(getLink().target, null);
  await cancelling;
  const late = new IdleRadio("Node-21");
  answer(late);
  await attempt;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(late.shut, true);
  assert.equal(getLink().phase, "idle");
});

test("the link remembered is kept with the radio's own name, which a port or an address does not give", async (t) => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  await connectWith(demoConnector, radio("MeshCore-demo"));
  assert.equal(lastLink()?.connectorId, "demo");
  assert.equal(lastLink()?.radioName, session.getState().self?.name);
  assert.ok(lastLink()?.radioName);
  await disconnect();
});

/** Turns of the event loop until `done`, for a radio that answers on timers. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), "gave up waiting");
}

test("a dropped link is tried again for as long as the radio stays away, and comes back with it", async () => {
  let away = false;
  const tries: string[] = [];
  const connector: Connector = {
    ...demoConnector,
    id: "flaky",
    connect: async (device) => {
      tries.push(away ? "away" : "there");
      if (away) throw new Error("not in range");
      return demoConnector.connect(device);
    },
  };
  await connectWith(connector, radio("MeshCore-demo"));
  assert.equal(getLink().phase, "connected");

  away = true;
  await session.reboot();
  // Past the six tries the loop used to give up after, each brought forward rather than waited out.
  for (let i = 0; i < 10; i++) {
    await until(() => getLink().waiting);
    assert.equal(getLink().phase, "connecting");
    // Getting a dropped link back keeps its chats on screen.
    assert.equal(getLink().dropped, true);
    reconnectNow();
  }
  await until(() => getLink().waiting);
  away = false;
  reconnectNow();
  await until(() => getLink().phase === "connected");
  assert.equal(session.getState().status, "ready");
  assert.equal(tries.filter((t) => t === "away").length, 10);
  await disconnect();
});

test("a link is connected once the radio has answered, and one lost while its contacts are still read is got back like a drop", async () => {
  let transport: Transport | null = null;
  const connector: Connector = {
    ...demoConnector,
    id: "catching-up",
    connect: async (device) => (transport = await demoConnector.connect(device)),
  };
  const phases: string[] = [];
  let settled = false;
  const stop = session.subscribe(() => {
    if (session.getState().status !== "ready" || phases.length > 0) return;
    phases.push("ready");
    // Lost while the rest is still read.
    queueMicrotask(() => {
      phases.push(getLink().phase, settled ? "caught up" : "catching up");
      void transport?.close();
    });
  });
  try {
    // Resolves rather than fails: the link was usable before it went.
    await connectWith(connector, radio("MeshCore-demo")).then(() => (settled = true));
    assert.deepEqual(phases, ["ready", "connected", "catching up"]);
    assert.equal(getLink().phase, "connecting");
    assert.equal(getLink().retrying, true);
    // Its chats stay on screen while it is got back.
    assert.equal(getLink().dropped, true);
  } finally {
    stop();
    await disconnect();
  }
});

test("a radio picked by hand with Bluetooth off may ask once to turn it on, and is not tried again behind a no", async () => {
  const asked: (boolean | undefined)[] = [];
  const connector: Connector = {
    ...demoConnector,
    id: "bluetooth-off",
    connect: async (_device, options) => {
      asked.push(options?.mayAsk);
      throw new BluetoothOffError("Bluetooth is off");
    },
  };
  await assert.rejects(connectWith(connector, radio("MeshCore-demo")), BluetoothOffError);
  assert.deepEqual(asked, [true]);
  assert.equal(getLink().phase, "failed");
  assert.equal(getLink().bluetoothOff, true);
  await disconnect();
});

test("a dropped link waits out Bluetooth turned off without asking, and only a try by hand may ask", async () => {
  let off = false;
  const asked: (boolean | undefined)[] = [];
  const connector: Connector = {
    ...demoConnector,
    id: "bluetooth-dropped",
    connect: async (device, options) => {
      if (!off) return demoConnector.connect(device);
      asked.push(options?.mayAsk);
      throw new BluetoothOffError("Bluetooth is off");
    },
  };
  await connectWith(connector, radio("MeshCore-demo"));
  off = true;
  await session.reboot();
  // The first try after the drop comes by itself, and does not ask.
  await until(() => asked.length === 1 && getLink().waiting);
  assert.equal(getLink().bluetoothOff, true);
  // Looks for Bluetooth are not counted as tries, so the pause after them stays short.
  assert.equal(getLink().attempt, 0);
  reconnectNow();
  await until(() => asked.length === 2 && getLink().waiting);
  assert.deepEqual(asked, [false, true]);
  off = false;
  reconnectNow();
  await until(() => getLink().phase === "connected");
  assert.equal(getLink().bluetoothOff, false);
  await disconnect();
});
