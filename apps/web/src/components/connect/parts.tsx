import type { Connector, FoundDevice } from "../../transports/index.js";
import { bleAddress, roleOf, sharedRadio, shownName } from "../../transports/role.js";
import { t } from "../../i18n/index.js";
import { toast } from "../../lib/toast.js";
import { LinkIcon, PhoneIcon, PlayIcon, PortIcon } from "../Icons.js";

/** What the screen calls a device. The demo keeps its full name, which the README tells a newcomer to look for. */
export function nameOf(device: FoundDevice, connector: Connector): string {
  return connector.id === "demo" ? device.name : shownName(device, connector.kind);
}

export function DeviceIcon({ device, connector, size = 16 }: { device: FoundDevice | null; connector: Connector; size?: number }) {
  const role = device ? roleOf(device, connector.kind) : "radio";
  if (role === "phone") return <PhoneIcon size={size} />;
  if (role === "port") return <PortIcon size={size} />;
  // The pretend radio is not a way to reach one: a Bluetooth mark here hid it from App Review.
  if (connector.id === "demo") return <PlayIcon size={size} />;
  return <LinkIcon kind={connector.kind} size={size} />;
}

/** A row's second line: what tells two of one name apart. The tab above it already names the way. */
export function rowLine(device: FoundDevice, connector: Connector): string | null {
  const role = roleOf(device, connector.kind);
  if (role === "phone") {
    const radio = sharedRadio(device);
    return radio ? t("connect.device.sharesRadio", { name: radio }) : t("connect.device.phoneShares");
  }
  if (connector.kind === "ble") return bleAddress(device) ?? device.detail;
  if (connector.kind === "tcp") return null;
  return device.detail;
}

/** The card's second line: the way, then the address; a port or an address once the radio's own name is known. */
export function cardLine(device: FoundDevice | null, connector: Connector, radioName: string | null): string {
  if (!device) return [connector.title, t("connect.card.chooser")].join(" · ");
  const second =
    roleOf(device, connector.kind) === "phone" || connector.kind === "ble" ? rowLine(device, connector) : radioName ? device.name : device.detail;
  return [connector.title, second].filter(Boolean).join(" · ");
}

/** Four bars for how well the radio is heard; the figure itself is in the tooltip. Null: not heard, the bars empty. */
export function SignalBars({ rssi }: { rssi: number | null }) {
  const lit = rssi === null ? 0 : barsOf(rssi);
  const label = rssi === null ? t("connect.signal.quiet") : t("connect.signal.bars", { level: lit });
  return (
    <span className={["signal-bars", rssi === null ? "quiet" : ""].join(" ")} title={rssi === null ? label : t("connect.signal.dbm", { value: rssi })} aria-label={label}>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={n <= lit ? "on" : ""} style={{ height: `${n * 25}%` }} />
      ))}
    </span>
  );
}

function barsOf(rssi: number): number {
  return rssi >= -60 ? 4 : rssi >= -75 ? 3 : rssi >= -90 ? 2 : 1;
}

/**
 * How well the card's radio is heard by the search under the tabs, which hides
 * it from its list: its signal in dBm, "quiet" when a search has gone on for a
 * while without hearing it, or null when there is nothing to say (another way
 * of connecting, no search yet, a radio heard with no figure).
 */
export type CardSignal = number | "quiet" | null;

/** The card's bars: a tap says the figure, or why the radio may not be heard. */
export function CardSignalBars({ signal }: { signal: CardSignal }) {
  if (signal === null) return null;
  const rssi = signal === "quiet" ? null : signal;
  return (
    <button
      type="button"
      className="connect-card-signal"
      onClick={() =>
        toast(
          rssi === null ? t("connect.signal.quiet") : t("connect.signal.card", { value: rssi }),
          "",
          undefined,
          rssi === null ? t("connect.signal.quietWhy") : t("connect.signal.bars", { level: barsOf(rssi) }),
        )
      }
    >
      <SignalBars rssi={rssi} />
    </button>
  );
}
