import { useEffect, useMemo, useState } from "react";
import { cancelConnect, getLink, useLink } from "../../lib/link.js";
import { shell } from "../../lib/platform.js";
import { connectors, lastLink, type Connector } from "../../transports/index.js";
import { LinkIcon, PlayIcon } from "../Icons.js";
import { PrivacyButton } from "../Privacy.js";
import { UpdateButton } from "../Updates.js";
import { ToastHost } from "../../ui/Menu.js";
import { t } from "../../i18n/index.js";
import { ConnectorPanel } from "./ConnectorPanel.js";
import type { CardSignal } from "./parts.js";
import { cardRadio, RadioCard } from "./RadioCard.js";

/**
 * The screen before a radio is connected: the radio to connect to at the
 * top, one tab per way of reaching a radio below it, and the app's updates
 * and privacy policy in a line at the bottom.
 */
export function ConnectView() {
  const list = useMemo(connectors, []);
  const link = useLink();
  const card = cardRadio(list, link);
  const [active, setActive] = useState<Connector | null>(() => {
    const wanted = link.target?.connectorId ?? lastLink()?.connectorId;
    return list.find((c) => c.id === wanted) ?? list[0] ?? null;
  });
  // How well the card's radio is heard, from the search under its own tab.
  const [signal, setSignal] = useState<CardSignal>(null);
  const cardHidden = card && active && card.connector.id === active.id ? (card.device?.id ?? null) : null;

  // Esc gives up a connect, as the card's Cancel does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && getLink().phase === "connecting") void cancelConnect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="connect">
      <div className="connect-column">
        <header className="connect-brand">
          <img src="./icon.svg" alt="" width={28} height={28} />
          <h1>Ommesh</h1>
        </header>

        {list.length === 0 ? (
          <NoLink />
        ) : (
          <>
            {card ? <RadioCard {...card} signal={cardHidden ? signal : null} /> : null}
            <section className="connect-ways">
              {list.length > 1 ? (
                <div className="segmented" role="tablist">
                  {list.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="tab"
                      aria-selected={active?.id === c.id}
                      className={active?.id === c.id ? "on" : ""}
                      onClick={() => setActive(c)}
                    >
                      {/* The pretend radio is not a way to reach one: a Bluetooth mark here hid it from App Review. */}
                      {c.id === "demo" ? <PlayIcon size={16} /> : <LinkIcon kind={c.kind} />}
                      {c.title}
                    </button>
                  ))}
                </div>
              ) : null}
              {active ? (
                <ConnectorPanel
                  key={active.id}
                  connector={active}
                  hideId={cardHidden}
                  other={card !== null}
                  onCardSignal={setSignal}
                />
              ) : null}
            </section>
          </>
        )}

        <footer className="connect-foot">
          <UpdateButton />
          <PrivacyButton />
        </footer>
      </div>
      {/* The card's bars say their figure in a toast. */}
      <ToastHost />
    </div>
  );
}

function NoLink() {
  const where = shell();
  return (
    <div className="stack">
      <p>{t("connect.noLink.title")}</p>
      <p className="muted">{where === "browser" ? t("connect.noLink.browser") : t("connect.noLink.shell")}</p>
    </div>
  );
}
