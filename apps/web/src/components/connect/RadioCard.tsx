import { useState } from "react";
import { CONNECT_TRIES, cancelConnect, connectWith, pairLink, useLink, type LinkState } from "../../lib/link.js";
import { shell } from "../../lib/platform.js";
import { useSelector } from "../../lib/session.js";
import { autoConnectWanted, lastLink, setAutoConnect, type Connector, type FoundDevice } from "../../transports/index.js";
import { roleOf } from "../../transports/role.js";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Field.js";
import { AlertIcon, CheckIcon, LockIcon } from "../Icons.js";
import { t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";
import { cardLine, CardSignalBars, DeviceIcon, nameOf, type CardSignal } from "./parts.js";
import { closeJournal } from "../../lib/portJournal.js";
import { PortSection } from "./PortSettings.js";

/** The radio at the top of the screen. */
export interface CardRadio {
  connector: Connector;
  /** Null for a radio still to be picked in the browser's chooser. */
  device: FoundDevice | null;
  radioName: string | null;
  /** The last radio connected to, which the switch to connect at launch is about. */
  last: boolean;
}

/**
 * The radio a connect is for while one is under way or has failed, else the
 * last one connected to; null on a first launch. A radio this platform has no
 * way to reach any more is left out.
 */
export function cardRadio(list: Connector[], link: LinkState): CardRadio | null {
  const last = lastLink();
  const lastConnector = last ? list.find((c) => c.id === last.connectorId) : undefined;
  const target = link.phase !== "idle" ? link.target : null;
  const targetConnector = target ? list.find((c) => c.id === target.connectorId) : undefined;
  if (target && targetConnector) {
    const isLast = last !== null && last.connectorId === target.connectorId && last.device.id === (target.device?.id ?? "");
    return { connector: targetConnector, device: target.device, radioName: isLast ? (last.radioName ?? null) : null, last: isLast };
  }
  if (last && lastConnector) return { connector: lastConnector, device: last.device, radioName: last.radioName ?? null, last: true };
  return null;
}

/**
 * Connects to a radio; a chooser's radio with no id to find it by is picked in the chooser again. A port's log
 * open on the screen lets its port go first.
 */
export function connectTo(connector: Connector, device: FoundDevice | null): void {
  void closeJournal()
    .then(() => connectWith(connector, connector.mode === "picker" && !device?.id ? null : device))
    .catch(() => undefined);
}

function firstStep(connector: Connector, device: FoundDevice | null): string {
  if (connector.id === "demo") return t("connect.step.demo");
  if (connector.kind === "serial") return t("connect.step.serial", { port: device?.name ?? connector.title });
  if (connector.kind === "tcp") return t("connect.step.tcp", { address: device?.name ?? connector.title });
  return t("connect.step.ble");
}

function hint(connector: Connector): string | null {
  if (connector.id === "demo") return null;
  return connector.kind === "serial" ? t("connect.hint.serial") : connector.kind === "tcp" ? t("connect.hint.tcp") : t("connect.hint.ble");
}

/**
 * One radio and what is happening with it: Connect; while connecting, the
 * step it has reached and Cancel; a PIN field when the radio wants a bond;
 * the failure, what to check, and Try again. Before a connect and after a
 * failed one, bars in the corner say how well the phone hears it.
 */
export function RadioCard({ connector, device, radioName, last, signal = null }: CardRadio & { signal?: CardSignal }) {
  const link = useLink();
  const step = useSelector((s) => (s.status === "connecting" ? s.connectStep : null));
  // Once the radio has said who it is, the card says it too.
  const answered = useSelector((s) => (s.status === "connecting" && s.connectStep === "history" ? (s.self?.name ?? null) : null));
  const [auto, setAuto] = useState(autoConnectWanted);
  const [details, setDetails] = useState(false);

  const phase =
    link.phase === "connected" ? "done" : link.phase === "connecting" ? "busy" : link.phase === "failed" ? (link.pair ? "pin" : "failed") : "idle";
  const name = answered ?? radioName ?? (device ? nameOf(device, connector) : t("connect.card.chosen"));
  // The error's first sentence heads the card, the rest waits behind a tap. Cut without a lookbehind:
  // Safari before 16.4 cannot read one, and the app did not start at all there.
  const error = link.error ?? "";
  const cut = error.search(/[.!?]\s/);
  const headline = cut < 0 ? error : error.slice(0, cut + 1);
  const more = cut < 0 ? "" : error.slice(cut + 1).trim();

  let line;
  if (phase === "busy") {
    line = link.retrying
      ? t("connect.status.reconnectingAttempt", { attempt: link.attempt })
      : link.attempt > 1
        ? t("connect.card.attempt", { attempt: link.attempt, tries: CONNECT_TRIES })
        : t("connect.card.connecting");
  } else if (phase === "done") line = <span className="connect-good">{t("connect.card.connected")}</span>;
  else if (phase === "pin") line = <span className="connect-pin-title"><LockIcon size={12} /> {t("connect.pair.cardTitle")}</span>;
  else if (phase === "failed") line = <span className="connect-bad">{headline}</span>;
  else line = cardLine(device, connector, radioName);

  const icon = phase === "failed" ? <AlertIcon size={20} /> : phase === "done" ? <CheckIcon size={20} /> : <DeviceIcon device={device} connector={connector} size={20} />;
  const reached = phase === "done" ? 3 : step === "history" ? 2 : step === "hello" ? 1 : 0;
  // A cable's port can be set up before a connect and after a failed one.
  const port = connector.port && device?.id && (phase === "idle" || phase === "failed") ? <PortSection connector={connector} access={connector.port} device={device} /> : null;
  const steps = [firstStep(connector, device), t("connect.step.hello"), t("connect.step.history")];

  return (
    <section className={["connect-card", phase === "failed" ? "bad" : "", phase === "done" ? "good" : ""].join(" ")} aria-live="polite">
      <div className="connect-card-top">
        <span className="connect-card-icon">{icon}</span>
        <span className="connect-card-text">
          <span className="connect-card-name">{name}</span>
          <span className="connect-card-line">{line}</span>
        </span>
        {phase === "idle" || phase === "failed" ? <CardSignalBars signal={signal} /> : null}
      </div>

      {phase === "busy" || phase === "done" ? (
        <div className="connect-steps">
          <div className="connect-steps-bar" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <i key={i} className={i < reached ? "done" : i === reached ? "now" : ""} />
            ))}
          </div>
          <div className="connect-steps-label">
            <span>{phase === "done" ? t("connect.step.done") : steps[reached]}</span>
            <span>{t("connect.step.count", { step: Math.min(reached + 1, 3) })}</span>
          </div>
        </div>
      ) : null}

      {phase === "pin" && device ? <PinForm phone={roleOf(device, connector.kind) === "phone"} /> : null}

      {phase === "failed" ? (
        <>
          {/* A failure that says what to do, or that is about the pairing, has no need of the general hint. */}
          {!more && !link.unpaired && hint(connector) ? <p className="connect-hint">{hint(connector)}</p> : null}
          {details && more ? <p className="connect-details">{more}</p> : null}
        </>
      ) : null}

      {phase === "idle" ? (
        <>
          <Button variant="primary" size="lg" className="wide" autoFocus={shell() !== "capacitor"} onClick={() => connectTo(connector, device)}>
            {t("connect.card.connect")}
          </Button>
          {last ? (
            <button
              type="button"
              role="switch"
              aria-checked={auto}
              className="connect-auto"
              onClick={() => {
                setAuto(!auto);
                setAutoConnect(!auto);
              }}
            >
              <span>{t("connect.autoConnect")}</span>
              <span className={["switch", auto ? "on" : ""].join(" ")} aria-hidden="true" />
            </button>
          ) : null}
        </>
      ) : phase === "busy" ? (
        <Button size="lg" className="wide" onClick={() => void cancelConnect()}>
          {t("connect.card.cancel")}
        </Button>
      ) : phase === "pin" ? (
        <div className="connect-card-row">
          <span className="connect-hint">{t("connect.pair.once")}</span>
          <button type="button" className="connect-link" onClick={() => void cancelConnect()}>
            {t("connect.card.cancel")}
          </button>
        </div>
      ) : phase === "failed" ? (
        <div className="connect-card-row">
          <Button variant="primary" onClick={() => connectTo(connector, device)}>
            {t("connect.card.retry")}
          </Button>
          <span className="connect-card-links">
            {more ? (
              <button type="button" className="connect-link" onClick={() => setDetails(!details)}>
                {details ? t("connect.card.less") : t("connect.card.more")}
              </button>
            ) : null}
            {!last ? (
              <button type="button" className="connect-link" onClick={() => void cancelConnect()}>
                {t("connect.card.close")}
              </button>
            ) : null}
          </span>
        </div>
      ) : null}

      {port}
    </section>
  );
}

/** The PIN, in the card: the radio shows it on its screen; a phone sharing its radio takes any digits. */
function PinForm({ phone }: { phone: boolean }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="connect-pin"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await pairLink(pin.trim());
        } catch (err) {
          setError(t("connect.pair.failed", { error: errorText(err) }));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="connect-pin">{phone ? t("connect.pair.cardLabelPhone") : t("connect.pair.cardLabel")}</label>
      <div className="connect-pin-row">
        <Input
          id="connect-pin"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder={t("connect.pair.placeholder")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
        />
        <Button type="submit" variant="primary" busy={busy} disabled={!pin.trim()}>
          {t("connect.pair.submit")}
        </Button>
      </div>
      {error ? <p className="connect-error">{error}</p> : null}
    </form>
  );
}
