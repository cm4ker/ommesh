/**
 * The address a radio has on its Wi-Fi (MeshCore 1.18), offered on the
 * connect screen's Wi-Fi tab once the radio has said it over another link:
 * the computer then reaches it with a tap instead of a typed address.
 */

import { session } from "./session.js";
import { knownAddresses } from "../transports/tcp.js";

export function startWifiAddress(): () => void {
  let last = "";
  return session.subscribe(() => {
    const { self, wifi } = session.getState();
    if (!self || !wifi?.ip) return;
    const id = wifi.ip;
    const said = `${self.key}@${id}@${self.name}`;
    if (said === last) return;
    last = said;
    // The radio's own entry is under its name; an address typed by hand is under the address, and stays.
    for (const old of knownAddresses.list()) if (old.radioKey === self.key && old.name === self.name && old.id !== id) knownAddresses.forget(old.id);
    knownAddresses.remember({ id, name: self.name, detail: null, rssi: null, radioKey: self.key });
  });
}
