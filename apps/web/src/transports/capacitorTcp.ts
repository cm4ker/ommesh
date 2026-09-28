/**
 * A radio on the network, from a phone (see `tcp.ts` for what the firmware
 * serves). The socket is the app's own plugin, `MeshTcp`
 * (`MeshTcpPlugin.swift` on iOS, `MeshTcpPlugin.java` on Android); the
 * framing is done here.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { BaseTransport, frameForStream, StreamFrameDecoder } from "@meshnet/meshcore";
import { addressOf, knownAddresses, rememberAddress, TCP_CONNECT_TIMEOUT_S } from "./tcp.js";
import type { Connector } from "./types.js";
import { t } from "../i18n/index.js";

interface MeshTcpPlugin {
  open(options: { host: string; port: number; timeout?: number }): Promise<{ id: string }>;
  write(options: { id: string; data: string }): Promise<void>;
  close(options: { id: string }): Promise<void>;
  addListener(event: "data", listener: (event: { id: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "closed", listener: (event: { id: string; error?: string }) => void): Promise<PluginListenerHandle>;
}

let plugin: MeshTcpPlugin | null = null;

/**
 * Runs `use` with the plugin. Never resolve a Promise with the plugin itself:
 * the Capacitor proxy answers `then`, and the promise would hang (see relay.ts).
 * That hang kept every phone at "Connecting" to a radio on the network.
 */
async function withTcp<T>(use: (api: MeshTcpPlugin) => Promise<T>): Promise<T> {
  if (!plugin) {
    const { registerPlugin } = await import("@capacitor/core");
    plugin = registerPlugin<MeshTcpPlugin>("MeshTcp");
  }
  return use(plugin);
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** Open connections by the plugin's id; the plugin's events carry the id. */
const routes = new Map<string, CapacitorTcpTransport>();

let listening: Promise<unknown> | null = null;

/** One listener per event for the app's lifetime, in place before the first connection can say anything. */
function listen(api: MeshTcpPlugin): Promise<unknown> {
  listening ??= Promise.all([
    api.addListener("data", (event) => routes.get(event.id)?.receive(event.data)),
    api.addListener("closed", (event) => routes.get(event.id)?.dropped(event.error)),
  ]);
  return listening;
}

class CapacitorTcpTransport extends BaseTransport {
  readonly kind = "tcp" as const;
  private readonly decoder = new StreamFrameDecoder();

  constructor(
    private readonly api: MeshTcpPlugin,
    private readonly id: string,
    readonly label: string,
  ) {
    super();
    routes.set(id, this);
  }

  receive(data: string): void {
    for (const frame of this.decoder.push(fromBase64(data))) this.emitFrame(frame);
  }

  dropped(error: string | undefined): void {
    routes.delete(this.id);
    this.emitClose(new Error(error || "the radio closed the connection"));
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.isClosed) throw new Error(t("connect.error.connectionClosed"));
    await this.api.write({ id: this.id, data: toBase64(frameForStream(frame)) });
  }

  protected async shutdown(): Promise<void> {
    routes.delete(this.id);
    await this.api.close({ id: this.id }).catch(() => undefined);
  }
}

export const capacitorTcpConnector: Connector = {
  id: "cap-tcp",
  kind: "tcp",
  get title() {
    return t("connect.transport.wifi");
  },
  get description() {
    return t("connect.describe.tcp");
  },
  mode: "address",

  async remembered() {
    return knownAddresses();
  },

  async connect(device) {
    if (!device) throw new Error(t("connect.error.typeAddress"));
    const address = addressOf(device);
    return withTcp(async (api) => {
      await listen(api);
      const { id } = await api.open({ ...address, timeout: TCP_CONNECT_TIMEOUT_S });
      const transport = new CapacitorTcpTransport(api, id, device.name);
      rememberAddress(device);
      return transport;
    });
  },
};
