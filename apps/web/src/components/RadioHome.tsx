import { useRef, useSyncExternalStore } from "react";
import { useBatteryType } from "../lib/batteryType.js";
import { t } from "../i18n/index.js";
import { battery, batteryPercent, lowCharge } from "../lib/format.js";
import { disconnect, useLink } from "../lib/link.js";
import { useLookalikePrefs } from "../lib/lookalikes.js";
import { openRadioPage, type RadioPage } from "../lib/nav.js";
import { canHover } from "../lib/platform.js";
import { PULL_TRIGGER, usePull } from "../lib/pull.js";
import { resync, STEP_COUNT, stepLabel, useResync } from "../lib/resync.js";
import { summaryOf, useNoticePrefs } from "../lib/noticePrefs.js";
import { session, useSelector, useSession } from "../lib/session.js";
import { act } from "../lib/toast.js";
import { useDesktopUpdateInfo } from "../lib/updates.js";
import { memoryUse } from "../lib/tidy.js";
import { getPreference, subscribeTheme } from "../theme/store.js";
import { findTheme } from "../theme/themes.js";
import { Button, IconButton } from "../ui/Button.js";
import { Group, LinkRow } from "../ui/List.js";
import { showMenu } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { AirIcon, AlertIcon, BellIcon, FileIcon, GaugeIcon, InfoIcon, LinkIcon, LocationIcon, LogIcon, PaletteIcon, PowerIcon, RadioIcon, RefreshIcon, ShieldIcon, SlidersIcon, TextIcon, UsersIcon, WavesIcon } from "./Icons.js";
import { presetName, radioTitle } from "./RadioPages.js";
import { readingsSummary } from "./Readings.js";


/** Advertising: once to the neighbours, or flooded across the mesh. */
export function advertise(at: { x: number; y: number } | null = null): void {
  showMenu(
    [
      { label: t("radio.home.nearby"), hint: t("radio.home.nearbyHint"), icon: <RadioIcon size={18} />, air: true, onSelect: () => void act(() => session.sendAdvert(false), t("radio.home.nearbySent")) },
      { label: t("radio.home.flood"), hint: t("radio.home.floodHint"), icon: <WavesIcon size={18} />, air: true, onSelect: () => void act(() => session.sendAdvert(true), t("radio.home.floodSent")) },
    ],
    { title: t("radio.home.advertiseTitle"), at },
  );
}

/**
 * The radio section's root: this radio's state and the two things done most
 * with it, then one row per topic, each with what it is set to now.
 */
export function RadioHome({ selected }: { selected: RadioPage | null }) {
  const appInfo = useDesktopUpdateInfo();
  const state = useSession();
  const events = useSelector((state) => state.log.length);
  const lookalikes = useLookalikePrefs();
  const theme = useSyncExternalStore(subscribeTheme, getPreference);
  const self = state.self;
  const online = state.status === "ready";
  const cell = useBatteryType(self?.key);
  const low = !!state.battery && lowCharge(state.battery.mv, cell);
  const own = state.telemetry["self"];
  const row = (page: RadioPage, icon: React.ReactNode, value?: string) => (
    <LinkRow key={page} icon={icon} label={radioTitle(page)} value={value} tone={page === "power" ? "danger" : undefined} selected={selected === page} onClick={() => openRadioPage(page)} />
  );
  const notices = summaryOf(useNoticePrefs());
  const use = memoryUse(state);
  const contactsValue = state.contactsFull ? t("radio.home.full") : use ? t("radio.home.used", { used: use.used, max: use.max }) : undefined;
  const reading = useResync();
  const link = useLink();
  const scroller = useRef<HTMLDivElement>(null);
  const pull = usePull(scroller, onPull, online && !reading);

  return (
    <div className="list-pane radio-home">
      <header className="list-head">
        <h1>{t("radio.home.title")}</h1>
        {/* A phone pulls the list down instead. */}
        {canHover() ? (
          <IconButton label={t("radio.home.resync")} disabled={!online || !!reading} onClick={onPull}>
            <RefreshIcon size={17} className={reading ? "spin" : ""} />
          </IconButton>
        ) : null}
      </header>
      {reading ? (
        <div className="resync-bar" role="progressbar" aria-valuemin={0} aria-valuemax={STEP_COUNT} aria-valuenow={reading.index}>
          <i style={{ width: `${((reading.index + 0.5) / STEP_COUNT) * 100}%` }} />
        </div>
      ) : null}
      <div className="screen-scroll" ref={scroller}>
        {pull > 0 ? (
          <div className="pull-hint" style={{ height: pull }}>
            <RefreshIcon size={17} style={{ transform: `rotate(${(pull / PULL_TRIGGER) * 270}deg)` }} />
            <span>{pull >= PULL_TRIGGER ? t("radio.home.release") : t("radio.home.pull")}</span>
          </div>
        ) : null}
        <div className="radio-card">
          <div className="radio-card-head">
            {/* A glyph, not initials: "Node-21" would read "NO". The fallback name only picks the hue, the same in every language. */}
            <Avatar name={self?.name ?? "Radio"} size={44} icon={<RadioIcon size={22} />} />
            <span className="row-main">
              <span className="row-title">{self?.name ?? t("connect.rail.theRadio")}</span>
              <span className={["row-sub", online ? "muted" : "danger"].join(" ")}>
                {!online
                  ? link.phase === "connecting"
                    ? t("radio.home.offlineReconnecting")
                    : t("radio.home.offline")
                  : reading
                    ? t("radio.home.resyncStep", { step: stepLabel(reading.step), index: reading.index + 1, total: STEP_COUNT })
                    : state.link
                      ? state.link.label
                      : t("radio.home.online")}
              </span>
            </span>
            <button type="button" className="radio-battery" disabled={!self} title={t("radio.titles.readings")} onClick={() => openRadioPage("readings")}>
              {state.battery ? (
                <>
                  <b className={low ? "low" : undefined} title={low ? t("node.readings.lowCharge") : undefined}>
                    {low ? <AlertIcon size={13} role="img" aria-hidden={false} aria-label={t("node.readings.lowCharge")} /> : null}
                    {batteryPercent(state.battery.mv, cell)}%
                  </b>
                  <small>{battery(state.battery.mv)}</small>
                </>
              ) : (
                <b>—</b>
              )}
            </button>
          </div>
          <div className="radio-card-actions">
            <Button variant="primary" size="lg" disabled={!online} onClick={(e) => advertise(e.detail === 0 ? null : { x: e.clientX, y: e.clientY })}>
              <AirIcon size={17} />
              {t("radio.home.advertise")}
            </Button>
            <Button size="lg" onClick={() => void disconnect()}>
              {t("radio.connection.disconnect")}
            </Button>
          </div>
        </div>

        <Group title={t("radio.home.thisRadio")}>
          {row("name", <LocationIcon size={17} />, self?.name)}
          {row("frequency", <RadioIcon size={17} />, self ? t("radio.home.presetPower", { preset: presetName(self), tx: self.txPower }) : undefined)}
          {row("readings", <GaugeIcon size={17} />, [state.battery ? `${batteryPercent(state.battery.mv, cell)}%` : null, own ? readingsSummary(own.readings) : null].filter(Boolean).join(" · ") || undefined)}
          {row("contacts", <UsersIcon size={17} />, contactsValue)}
          {row("privacy", <ShieldIcon size={17} />)}
          {row("advanced", <SlidersIcon size={17} />)}
        </Group>
        <Group title={t("radio.home.thisApp")}>
          {row("notifications", <BellIcon size={17} />, notices)}
          {row("messages", <TextIcon size={17} />, lookalikes.on ? t("radio.home.lookalikes") : undefined)}
          {row("history", <FileIcon size={17} />)}
          {row("appearance", <PaletteIcon size={17} />, theme === "system" ? t("radio.home.themeSystem") : themeName(theme))}
          {row("connection", state.link ? <LinkIcon kind={state.link.kind} size={17} /> : <RadioIcon size={17} />, state.link ? { ble: "Bluetooth", serial: "USB", tcp: "Wi-Fi" }[state.link.kind] : undefined)}
        </Group>
        <Group>
          {row("air", <WavesIcon size={17} />, t("radio.home.listen"))}
          {row("log", <LogIcon size={17} />, t("radio.home.events", { count: events }))}
          {row("power", <PowerIcon size={17} />)}
          {row("about", <InfoIcon size={17} />, appInfo.version)}
        </Group>
      </div>
    </div>
  );
}

/** The picked theme's name, in the reader's language. */
function themeName(id: string): string | undefined {
  const theme = findTheme(id);
  return theme ? t(theme.name) : undefined;
}

function onPull(): void {
  void resync();
}
