/**
 * A radio on the network, from the desktop (see `tcp.ts` for what the
 * firmware serves). The socket is the shell's own (`tcp.rs`): bytes arrive on
 * one channel, the end of the connection on another; the framing is done
 * here.
 */

import { BaseTransport, frameForStream, StreamFrameDecoder } from "@meshnet/meshcore";
import { Channel, invoke } from "@tauri-apps/api/core";
import { addressOf, knownAddresses, TCP_CONNECT_TIMEOUT_S } from "./tcp.js";
import type { Connector } from "./types.js";
import { t } from "../i18n/index.js";

class TauriTcpTransport extends BaseTransport {
  readonly kind = "tcp" as const;
  private readonly decoder = new StreamFrameDecoder();
  private id: number | null = null;

  constructor(readonly label: string) {
    super();
  }

  /** Connects. The channels belong to this transport before the socket exists, so a drop right after the connect still reaches it. */
  async open(host: string, port: number): Promise<void> {
    const onData = new Channel<number[]>();
    onData.onmessage = (data) => {
      for (const frame of this.decoder.push(Uint8Array.from(data))) this.emitFrame(frame);
    };
    const onClosed = new Channel<string>();
    onClosed.onmessage = (reason) => this.emitClose(new Error(reason || "the radio closed the connection"));
    this.id = await invoke<number>("tcp_open", { host, port, timeoutMs: TCP_CONNECT_TIMEOUT_S * 1000, onData, onClosed });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.isClosed || this.id === null) throw new Error(t("connect.error.connectionClosed"));
    await invoke("tcp_write", { id: this.id, data: Array.from(frameForStream(frame)) });
  }

  protected async shutdown(): Promise<void> {
    if (this.id === null) return;
    await invoke("tcp_close", { id: this.id }).catch(() => undefined);
  }
}

export const tauriTcpConnector: Connector = {
  id: "tauri-tcp",
  kind: "tcp",
  get title() {
    return t("connect.transport.wifi");
  },
  get description() {
    return t("connect.describe.tcp");
  },
  mode: "address",

  async remembered() {
    return knownAddresses.list();
  },

  async forget(id) {
    knownAddresses.forget(id);
  },

  async connect(device) {
    if (!device) throw new Error(t("connect.error.typeAddress"));
    const { host, port } = addressOf(device);
    const transport = new TauriTcpTransport(device.name);
    try {
      await transport.open(host, port);
    } catch (error) {
      throw new Error(String(error));
    }
    knownAddresses.remember(device);
    return transport;
  },
};
