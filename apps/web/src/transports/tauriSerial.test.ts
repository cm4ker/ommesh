import { test } from "node:test";
import assert from "node:assert/strict";
import type { WatchHandlers, WatchOptions } from "tauri-plugin-serialplugin-api";
import { portDevice, raisesDtr, TauriSerialTransport } from "./tauriSerial.js";

class FakePort {
  handlers: WatchHandlers | null = null;
  options: WatchOptions | undefined;
  watchError: Error | null = null;
  closes = 0;
  lines: string[] = [];
  async open() { return "COM6"; }
  async writeDataTerminalReady(level: boolean) { this.lines.push(`dtr:${level}`); }
  async writeRequestToSend(level: boolean) { this.lines.push(`rts:${level}`); }
  async watch(handlers: WatchHandlers, options?: WatchOptions) {
    if (this.watchError) throw this.watchError;
    this.handlers = handlers;
    this.options = options;
    return { channelId: 1, unwatch: async () => undefined };
  }
  async writeBinary(bytes: Uint8Array | number[]) { return bytes.length; }
  async close() { this.closes += 1; }
}

test("USB watch preserves binary bytes and reassembles split replies", async () => {
  const port = new FakePort();
  const transport = new TauriSerialTransport(port, "COM6");
  const received: Uint8Array[] = [];
  transport.onFrame((frame) => received.push(frame));
  await transport.open();
  // A TinyUSB radio answers only once the host raises DTR. RTS beside it would send an ESP32 on
  // its own USB into its loader when the port closes.
  assert.deepEqual(port.lines, ["dtr:true"]);
  assert.equal(port.options?.decode, false);
  assert.equal(port.options?.routeUrc, false);
  port.handlers!.onData(new Uint8Array([0x3e, 3]));
  port.handlers!.onData(new Uint8Array([0, 0x88, 0xff, 0x0a, 0x3e, 1, 0, 10]));
  assert.deepEqual(received, [new Uint8Array([0x88, 0xff, 0x0a]), new Uint8Array([10])]);
  await transport.close();
});

test("a watch failure releases the opened USB port", async () => {
  const port = new FakePort();
  port.watchError = new Error("watch failed");
  const transport = new TauriSerialTransport(port, "COM6");
  await assert.rejects(transport.open(), /watch failed/);
  assert.equal(port.closes, 1);
  assert.equal(transport.isClosed, true);
});

test("USB errors release the native port and report the first failure once", async () => {
  const port = new FakePort();
  const transport = new TauriSerialTransport(port, "COM6");
  const failures: (Error | null)[] = [];
  transport.onClose((reason) => failures.push(reason));
  await transport.open();
  port.handlers!.onError?.("read failed");
  port.handlers!.onDisconnect?.("port closed");
  await transport.close();
  assert.equal(port.closes, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.message, "read failed");
  await assert.rejects(transport.send(new Uint8Array([10])), /port closed/);
});

test("a port behind a USB-to-UART chip is opened with its lines left alone", async () => {
  const info = (vid: number, type = "USB") => ({ path: "COM7", type, vid: String(vid), pid: "1", product: "Unknown", manufacturer: "Unknown", serial_number: "Unknown" });
  // CP210x, CH340, FTDI and Prolific; then a Xiao's own USB, a T-Echo, and ports that say nothing.
  assert.deepEqual([0x10c4, 0x1a86, 0x0403, 0x067b].map((vid) => raisesDtr(info(vid))), [false, false, false, false]);
  assert.deepEqual([raisesDtr(info(0x303a)), raisesDtr(info(0x239a)), raisesDtr(info(0, "Unknown")), raisesDtr(undefined)], [true, true, true, true]);
  const port = new FakePort();
  await new TauriSerialTransport(port, "COM7", { dtr: false, rts: false }).open();
  assert.deepEqual(port.lines, []);
});

test("lines picked by hand are both set, and DTR is written after RTS so Windows passes RTS on", async () => {
  const port = new FakePort();
  const transport = new TauriSerialTransport(port, "COM7", { dtr: false, rts: false }, true);
  await transport.open();
  assert.deepEqual(port.lines, ["dtr:false", "rts:false", "dtr:false"]);
  port.lines = [];
  await transport.close();
  // Nothing was raised, so nothing is lowered before the port closes.
  assert.deepEqual(port.lines, []);
  assert.equal(port.closes, 1);
});

test("a port with both lines up lowers RTS, then DTR, before it closes", async () => {
  const port = new FakePort();
  const transport = new TauriSerialTransport(port, "COM4", { dtr: true, rts: true }, true);
  await transport.open();
  assert.deepEqual(port.lines, ["dtr:true", "rts:true", "dtr:true"]);
  port.lines = [];
  await transport.close();
  // Closed with both up, an ESP32 on its own USB restarts into its loader.
  assert.deepEqual(port.lines, ["rts:false", "dtr:true", "dtr:false"]);
  assert.equal(port.closes, 1);
});

test("a USB port is offered as a radio by its product; the board's and Bluetooth's ports are set apart", () => {
  const info = (type: string, product = "Unknown", manufacturer = "Unknown") => ({ path: "COM7", type, vid: "4292", pid: "60000", product, manufacturer, serial_number: "Unknown" });
  const usb = portDevice("COM7", info("USB", "Silicon Labs CP210x USB to UART Bridge (COM7)", "Silicon Labs"));
  assert.deepEqual([usb.role, usb.name, usb.detail], ["radio", "COM7", "Silicon Labs CP210x USB to UART Bridge"]);
  assert.equal(portDevice("COM8", info("USB", "Unknown", "wch.cn")).detail, "wch.cn");
  assert.equal(portDevice("COM9", info("USB")).detail, null);
  assert.equal(portDevice("COM1", info("PCI")).role, "port");
  assert.equal(portDevice("COM4", info("Bluetooth")).role, "port");
  assert.equal(portDevice("/dev/ttyS0", info("Unknown")).role, "port");
});
