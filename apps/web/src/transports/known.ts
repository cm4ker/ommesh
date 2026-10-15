/**
 * Devices connected to before, kept by the app where the platform keeps no
 * list of its own: a radio's Bluetooth address on a phone or on Windows, an
 * address on the network. The newest first, at most eight.
 */

import type { TransportKind } from "@meshnet/meshcore";
import type { FoundDevice } from "./types.js";
import { roleOf } from "./role.js";
import { readSetting, writeSetting } from "../lib/storage.js";

const KEPT = 8;

export interface KnownList {
  list(): FoundDevice[];
  remember(device: FoundDevice): void;
  forget(id: string): void;
  /**
   * The device `id` turned out to be the radio with this public key. Another
   * entry of that radio, of the same kind (a radio, or a phone sharing it), is
   * an address it no longer has, and goes: a radio wiped or flashed afresh
   * comes back at a new Bluetooth address. An entry kept before keys were
   * stored is matched by its name instead.
   */
  identify(id: string, radioKey: string): void;
}

export function knownList(key: string, kind: TransportKind): KnownList {
  const list = () => readSetting<FoundDevice[]>(key, []);
  return {
    list,
    remember(device) {
      // A device from a search does not say which radio it is; the entry it replaces may.
      const radioKey = device.radioKey ?? list().find((d) => d.id === device.id)?.radioKey;
      writeSetting(key, [{ ...device, radioKey }, ...list().filter((d) => d.id !== device.id)].slice(0, KEPT));
    },
    forget(id) {
      writeSetting(key, list().filter((d) => d.id !== id));
    },
    identify(id, radioKey) {
      const all = list();
      const own = all.find((d) => d.id === id);
      if (!own) return;
      const role = roleOf(own, kind);
      const same = (d: FoundDevice) => (d.radioKey ? d.radioKey === radioKey : d.name === own.name) && roleOf(d, kind) === role;
      writeSetting(
        key,
        all.filter((d) => d.id === id || !same(d)).map((d) => (d.id === id ? { ...d, radioKey } : d)),
      );
    },
  };
}
