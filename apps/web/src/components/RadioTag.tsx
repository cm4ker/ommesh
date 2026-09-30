import { useBatteryType } from "../lib/batteryType.js";
import { batteryPercent, lowCharge } from "../lib/format.js";
import { useWide } from "../lib/layout.js";
import { goSection, openRadioPage } from "../lib/nav.js";
import { useSelector } from "../lib/session.js";
import { t } from "../i18n/index.js";
import { AlertIcon } from "./Icons.js";

/**
 * This radio's name and charge at the end of a list's head (#10), so which radio the
 * app is on is seen without a trip to Settings. The name has the room the title
 * leaves and is cut only past that; the charge never is.
 */
export function RadioTag() {
  // Values rather than the state, so the head is drawn again only when one of them changes.
  const key = useSelector((state) => state.self?.key);
  const name = useSelector((state) => state.self?.name);
  const mv = useSelector((state) => state.battery?.mv ?? null);
  const online = useSelector((state) => state.status === "ready");
  const cell = useBatteryType(key);
  const wide = useWide();
  if (key === undefined) return null;

  const shown = name || t("connect.rail.theRadio");
  // A charge read before the link dropped says nothing about now.
  const charge = online && mv !== null ? { percent: batteryPercent(mv, cell), low: lowCharge(mv, cell) } : null;
  const label = !online ? t("connect.tag.offline", { name: shown }) : charge ? t(charge.low ? "connect.tag.lowCharge" : "connect.tag.charge", { name: shown, percent: charge.percent }) : shown;
  return (
    // To the radio's card: on top of Settings on a phone, beside the Connection page on a desktop.
    <button type="button" className={["radio-tag", online ? "" : "off"].join(" ")} title={label} aria-label={label} onClick={() => (wide ? openRadioPage("connection") : goSection("radio", true))}>
      {online ? null : <span className="dot off" aria-hidden="true" />}
      <span className="radio-tag-name">{shown}</span>
      {charge ? (
        <span className={["radio-tag-charge", charge.low ? "low" : ""].join(" ")}>
          {charge.low ? <AlertIcon size={11} /> : null}
          {charge.percent}%
        </span>
      ) : null}
    </button>
  );
}
