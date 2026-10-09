import { useEffect, useRef, useState } from "react";
import { connectWith, useLink } from "../../lib/link.js";
import { addressDevice, type Connector, type FoundDevice } from "../../transports/index.js";
import { roleOf } from "../../transports/role.js";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Field.js";
import { ChevronDownIcon, PlusIcon } from "../Icons.js";
import { t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";
import { DeviceIcon, nameOf, rowLine, SignalBars, type CardSignal } from "./parts.js";
import { closeJournal } from "../../lib/portJournal.js";
import { PortRowSummary } from "./PortSettings.js";

/** How long a Bluetooth radio missing from a pass stays listed: one quiet pass should not make the rows jump. */
const KEEP_MS = 30_000;
/** How long a search goes without hearing the card's radio before the card's bars go empty: a radio heard at all is heard by then. */
const QUIET_MS = 2_000;

/**
 * What one way of connecting offers, under its tab: the radios it finds
 * (phones and odd ports folded away under "N more"), the addresses it knows,
 * or the browser's chooser. The search runs by itself while the tab is open
 * and rests while a connect is under way, so the screen shows one thing
 * working at a time.
 */
export function ConnectorPanel({
  connector,
  hideId,
  other,
  onCardSignal,
  onCardFound,
}: {
  connector: Connector;
  hideId: string | null;
  other: boolean;
  /** How well the radio hidden for the card is heard; told again whenever that changes. */
  onCardSignal?: (signal: CardSignal) => void;
  /** The card's radio as this search finds it: a port remembered from before says what board it is only once listed again. */
  onCardFound?: (device: FoundDevice | null) => void;
}) {
  const link = useLink();
  const busy = link.phase === "connecting";
  const [remembered, setRemembered] = useState<FoundDevice[]>([]);
  const [found, setFound] = useState<FoundDevice[]>([]);
  // A search has gone on long enough that a radio not heard in it is not about.
  const [settled, setSettled] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanRun, setScanRun] = useState(0);
  const [more, setMore] = useState(false);
  const [tip, setTip] = useState(false);
  // Kept across the pauses for a connect, so a radio heard before one is still listed after.
  const seen = useRef(new Map<string, { device: FoundDevice; at: number }>());
  // Which search last had the chance to ask to turn Bluetooth on (see the search below).
  const asked = useRef<{ connector: Connector; run: number } | null>(null);

  // Read again after each connect: an address or a radio that worked is remembered then.
  useEffect(() => {
    let alive = true;
    connector.remembered().then(
      (devices) => alive && setRemembered(devices),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [connector, busy]);

  useEffect(() => {
    // The search the tab opens with, and one asked for again, may ask to turn Bluetooth on. One
    // that follows a connect may not: the connect had its own chance, and was answered.
    const last = asked.current;
    const mayAsk = !last || last.connector !== connector || last.run !== scanRun;
    asked.current = { connector, run: scanRun };
    if (connector.mode !== "scan" || !connector.scan || busy) return;
    const abort = new AbortController();
    // A port that is gone is gone; a radio can miss one pass of a Bluetooth search.
    const keep = connector.kind === "ble" ? KEEP_MS : 0;
    setScanning(true);
    setScanError(null);
    const quiet = setTimeout(() => setSettled(true), QUIET_MS);
    abort.signal.addEventListener("abort", () => clearTimeout(quiet));
    connector
      .scan((devices) => {
        const now = Date.now();
        for (const device of devices) seen.current.set(device.id, { device, at: now });
        for (const [id, entry] of seen.current) if (entry.at < now - keep) seen.current.delete(id);
        setFound([...seen.current.values()].map((entry) => entry.device));
      }, abort.signal, { mayAsk })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setScanError(errorText(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setScanning(false);
      });
    return () => abort.abort();
  }, [connector, scanRun, busy]);

  // The card's radio is left out of the list, but how well it is heard goes up to the card. Only
  // Bluetooth says: a port or an address is there or not, with no signal to it.
  const cardDevice = hideId ? found.find((d) => d.id === hideId) : undefined;
  const cardSignal: CardSignal = connector.kind !== "ble" || connector.mode !== "scan" || !hideId ? null : cardDevice ? cardDevice.rssi : settled ? "quiet" : null;
  useEffect(() => onCardSignal?.(cardSignal), [cardSignal, onCardSignal]);
  useEffect(() => () => onCardSignal?.(null), [onCardSignal]);
  useEffect(() => onCardFound?.(cardDevice ?? null), [cardDevice, onCardFound]);
  useEffect(() => () => onCardFound?.(null), [onCardFound]);

  // A port's log open on the screen lets its port go first.
  const connect = (device: FoundDevice | null) =>
    void closeJournal()
      .then(() => connectWith(connector, device))
      .catch(() => undefined);

  const shown = new Map<string, FoundDevice>();
  for (const d of remembered) shown.set(d.id, d);
  for (const d of found) shown.set(d.id, { ...(shown.get(d.id) ?? d), ...d });
  const heard = new Set(found.map((d) => d.id));
  const all = [...shown.values()].filter((d) => d.id !== hideId);
  // Heard ones first, the strongest on top; remembered ones not heard now after them.
  const radios = all
    .filter((d) => roleOf(d, connector.kind) === "radio")
    .sort((a, b) => Number(heard.has(b.id)) - Number(heard.has(a.id)) || (b.rssi ?? -999) - (a.rssi ?? -999));
  const others = all.filter((d) => roleOf(d, connector.kind) !== "radio");
  const row = (d: FoundDevice) => (
    <DeviceRow key={d.id} device={d} connector={connector} faint={connector.mode === "scan" && !heard.has(d.id)} onClick={() => connect(d)} />
  );

  if (connector.id === "demo") {
    return (
      <div className="connect-panel">
        {all.length > 0 ? <ul className="device-list">{all.map(row)}</ul> : null}
        <p className="muted small">{connector.description}</p>
      </div>
    );
  }

  if (connector.mode === "address") {
    return (
      <div className="connect-panel">
        {radios.length > 0 ? <ul className="device-list">{radios.map(row)}</ul> : null}
        <AddressForm onConnect={connect} />
        <p className="muted small">{connector.description}</p>
      </div>
    );
  }

  if (connector.mode === "picker") {
    return (
      <div className="connect-panel">
        {radios.length > 0 ? <ul className="device-list">{radios.map(row)}</ul> : null}
        <Button onClick={() => connect(null)}>{connector.kind === "ble" ? t("connect.choose.radio") : t("connect.choose.port")}</Button>
        <p className="muted small">{connector.description}</p>
      </div>
    );
  }

  const serial = connector.kind === "serial";
  const looking = scanning && !busy;
  return (
    <div className="connect-panel">
      <div className="connect-panel-head">
        <span>{serial ? t("connect.list.ports") : other ? t("connect.list.otherNearby") : t("connect.list.nearby")}</span>
        {serial || busy ? null : looking ? (
          <span className="scan-mark">
            <i aria-hidden="true" />
            {t("connect.list.looking")}
          </span>
        ) : (
          <button type="button" className="connect-link" onClick={() => setScanRun((n) => n + 1)}>
            {t("connect.scan.again")}
          </button>
        )}
      </div>
      <ul className="device-list">
        {radios.map(row)}
        {radios.length === 0 ? (
          <li className="device-empty">{serial ? t("connect.list.noPorts") : looking ? t("connect.list.empty") : t("connect.scan.none")}</li>
        ) : null}
        {others.length > 0 ? (
          <li>
            <button type="button" className="device quiet" aria-expanded={more} onClick={() => setMore(!more)}>
              <span className="device-icon">
                <PlusIcon size={16} />
              </span>
              <span className="device-text">
                <span className="device-name">{t("connect.list.more", { count: others.length })}</span>
                <span className="device-detail">{serial ? t("connect.list.morePorts") : t("connect.list.morePhones")}</span>
              </span>
              <span className={["device-chevron", more ? "open" : ""].join(" ")}>
                <ChevronDownIcon size={16} />
              </span>
            </button>
          </li>
        ) : null}
        {more ? others.map(row) : null}
      </ul>
      {scanError ? <p className="connect-error">{scanError}</p> : null}
      <div className="connect-tip">
        <button type="button" className="connect-link" onClick={() => setTip(!tip)}>
          {tip ? t("connect.tips.close") : t("connect.tips.open")}
        </button>
        {tip ? <p className="muted small">{serial ? t("connect.tips.serial") : t("connect.tips.ble")}</p> : null}
      </div>
    </div>
  );
}

function DeviceRow({ device, connector, faint, onClick }: { device: FoundDevice; connector: Connector; faint: boolean; onClick: () => void }) {
  const line = rowLine(device, connector);
  const nested = roleOf(device, connector.kind) !== "radio";
  return (
    <li className={nested ? "nested" : undefined}>
      <button type="button" className={["device", faint ? "faint" : ""].join(" ")} onClick={onClick}>
        <span className="device-icon">
          <DeviceIcon device={device} connector={connector} />
        </span>
        <span className="device-text">
          <span className="device-name">{nameOf(device, connector)}</span>
          {line ? <span className="device-detail">{line}</span> : null}
        </span>
        {connector.port ? <PortRowSummary access={connector.port} device={device} /> : null}
        {device.rssi !== null && !faint ? <SignalBars rssi={device.rssi} /> : null}
      </button>
    </li>
  );
}

/** A radio on the network: `host` or `host:port`, the firmware's port when none is given. */
function AddressForm({ onConnect }: { onConnect: (device: FoundDevice) => void }) {
  const [text, setText] = useState("");
  const device = addressDevice(text);
  return (
    <form
      className="address-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (device) onConnect(device);
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("connect.address.placeholder")}
        aria-label={t("connect.address.label")}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
      />
      <Button type="submit" variant="primary" disabled={!device}>
        {t("connect.address.connect")}
      </Button>
    </form>
  );
}
