import { test } from "node:test";
import assert from "node:assert/strict";
import { TauriWinBleTransport } from "./tauriWinBle.js";

test("a write that fails ends the link and lets the shell close it", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push([command, args]);
    if (command === "winble_send") throw "write: ProtocolError";
    return undefined as T;
  };
  const transport = new TauriWinBleTransport("Phone", 7, call);
  const closed: (Error | null)[] = [];
  transport.onClose((reason) => closed.push(reason));

  await assert.rejects(transport.send(new Uint8Array([0x16, 0x03])), /write: ProtocolError/);
  assert.equal(transport.isClosed, true);
  assert.equal(closed.length, 1);
  assert.match(String(closed[0]?.message), /write: ProtocolError/);
  assert.deepEqual(calls.map(([command, args]) => [command, args.link]), [["winble_send", undefined], ["winble_disconnect", 7]]);
});
