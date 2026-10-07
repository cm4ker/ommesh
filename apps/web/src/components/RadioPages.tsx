import { useEffect, useState, useSyncExternalStore } from "react";
import { AdvertLocPolicy, AdvType, isTrusted, TelemMode, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { autostartEnabled, autostartLabel, hasAutostart, setAutostart } from "../lib/autostart.js";
import { agoPhrase, dayLabel, timeOfDay } from "../lib/format.js";
import { HASH_MODES, hashHops, repeatAllowed, repeatFreqsText } from "../lib/radioNetwork.js";
import { setFollowPhone, useFollowStatus } from "../lib/followPhone.js";
import { parseLatLon, pointDecimal } from "../lib/geo.js";
import { canOpenAnother, openAnother } from "../lib/instance.js";
import { disconnect, useLink } from "../lib/link.js";
import { setLookalikePrefs, useLookalikePrefs } from "../lib/lookalikes.js";
import { setOpenAtUnread, useOpenAtUnread } from "../lib/firstUnread.js";
import { setJumboEmoji, useJumboEmoji } from "../lib/jumboEmoji.js";
import { BACKGROUND_NAMES, BACKGROUNDS, setBackground, setBackgroundScale, setBackgroundStrength, useBackgroundPrefs } from "../lib/chatBackground.js";
import { isDirect, oneSignal, SIGNALS, setNoticePrefs, useNoticePrefs, type Corner, type NoticeKind, type NoticePrefs } from "../lib/noticePrefs.js";
import { titleOf } from "../lib/conversations.js";
import { ChatSoundRow, signalName } from "./ChatNotices.js";
import { askPermission, hasNoticeSettings, openNoticeSettings } from "../lib/notify.js";
import { previewSignal } from "../lib/chime.js";
import { push, type RadioPage } from "../lib/nav.js";
import { useOwnConsole } from "../lib/ownConsole.js";
import { canLocate, locateOnce, locateText, phoneLocates } from "../lib/phonePosition.js";
import { canHover, nativePlatform, shell } from "../lib/platform.js";
import { reach, trustUsed, withBase } from "../lib/privacy.js";
import { recentStops, relayAvailable, relayWanted, setRelayWanted, setSharing, useRelay, type AppStop } from "../lib/relay.js";
import { limitLabel, limitValue, parseLimit, ROUTE_LIMITS } from "../lib/routes.js";
import { SEND_TRIES_MAX, setSendTries, triesSpanMs, useSendTries } from "../lib/sendTries.js";
import { session, storage, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { getActiveTheme, getPreference, listThemes, setPreference, subscribeTheme } from "../theme/store.js";
import { getSystemTextScale, getTextScale, getTextSizePreference, hasSystemTextSize, setTextSizePreference, subscribeTextSize, TEXT_STEPS } from "../theme/textSize.js";
import { autoConnectWanted, setAutoConnect } from "../transports/index.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { SearchField } from "../ui/Field.js";
import { ActionRow, Block, ChoiceRow, Group, InfoRow, LinkRow, SelectRow, StepperRow, SwitchRow } from "../ui/List.js";
import { Avatar, SenderName } from "./Avatar.js";
import { ChatBackdrop } from "./ChatBackdrop.js";
import { CopyIcon, PictureIcon } from "./Icons.js";
import { ContactsPage, RemovedPage } from "./ContactsPages.js";
import { Console } from "./node/Console.js";
import { LogView } from "./LogView.js";
import { AirView } from "./AirView.js";
import { OwnReadings } from "./NodeReadings.js";
import { HistoryPage } from "./HistoryPage.js";
import { ScreenHead, type Chrome } from "./ScreenHead.js";
import { UpdateButton } from "./Updates.js";
import { useDesktopUpdateInfo } from "../lib/updates.js";
import { PeoplePage, PeopleRow, ReportRow } from "./People.js";
import { PrivacyButton } from "./Privacy.js";
import { NewBuildRow } from "./NewBuild.js";
import { NewsPage, NewsRow } from "./News.js";
import { getLanguagePreference, languageName, languages, setLanguagePreference, subscribeLanguage, systemLanguage, t, type Key } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

type Self = NonNullable<SessionState["self"]>;

/** Pages opened from another page rather than from the Radio list: the list keeps the parent picked. */
export const RADIO_PARENTS: Partial<Record<RadioPage, RadioPage>> = {
  removed: "contacts",
  sound: "notifications",
  soundDirect: "notifications",
  soundChats: "notifications",
  soundNodes: "notifications",
  people: "about",
  news: "about",
  trusted: "privacy",
  console: "advanced",
  background: "appearance",
};

/** Pages that read only under their own parent, one kind's sound under Sound: the palette leaves them out. */
export const RADIO_INNER: ReadonlySet<RadioPage> = new Set(["soundDirect", "soundChats", "soundNodes"]);

/** Each page's title as a key; `radioTitle` says it. */
export const RADIO_TITLES: Record<RadioPage, Key> = {
  name: "radio.titles.name",
  frequency: "radio.titles.frequency",
  readings: "radio.titles.readings",
  privacy: "radio.titles.privacy",
  trusted: "radio.titles.trusted",
  contacts: "radio.titles.contacts",
  removed: "radio.titles.removed",
  advanced: "radio.titles.advanced",
  console: "radio.titles.console",
  notifications: "radio.titles.notifications",
  sound: "radio.titles.sound",
  soundDirect: "radio.notifications.direct",
  soundChats: "radio.notifications.chats",
  soundNodes: "radio.notifications.nodes",
  messages: "radio.titles.messages",
  history: "radio.titles.history",
  appearance: "radio.titles.appearance",
  background: "radio.titles.background",
  connection: "radio.titles.connection",
  air: "radio.titles.air",
  log: "radio.titles.log",
  power: "radio.titles.power",
  about: "radio.titles.about",
  people: "radio.titles.people",
  news: "radio.titles.news",
};

/** A Radio page's title in the reader's language. */
export function radioTitle(page: RadioPage): string {
  return t(RADIO_TITLES[page]);
}

interface Preset {
  /** A region's name, the same in every language; `label` where it has a word in it. */
  name: string;
  label?: Key;
  frequencyKhz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
}

const PRESETS: Preset[] = [
  { name: "EU/UK", frequencyKhz: 869_525, bandwidthHz: 250_000, spreadingFactor: 11, codingRate: 5 },
  { name: "EU narrow", label: "radio.presets.euNarrow", frequencyKhz: 869_618, bandwidthHz: 62_500, spreadingFactor: 8, codingRate: 8 },
  { name: "US", frequencyKhz: 910_525, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 5 },
  { name: "ANZ", frequencyKhz: 915_800, bandwidthHz: 250_000, spreadingFactor: 10, codingRate: 5 },
  // Omsk's mesh moved here from 869.161 MHz on 2026-10-06.
  { name: "OMS", frequencyKhz: 868_731, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7 },
];

const BANDWIDTHS = ["7.8", "10.4", "15.6", "20.8", "31.25", "41.7", "62.5", "125", "250", "500"];

/** A lead of the radio's clock past this, seconds, is more than the whole seconds the two clocks are read in. */
const CLOCK_LEAD_S = 2;

/** The preset the radio is on, or its frequency and spreading factor when it is on none. */
export function presetName(self: Self): string {
  const p = PRESETS.find((q) => q.frequencyKhz === self.frequencyKhz && q.bandwidthHz === self.bandwidthHz && q.spreadingFactor === self.spreadingFactor && q.codingRate === self.codingRate);
  return p ? presetLabel(p) : `${(self.frequencyKhz / 1000).toFixed(3)} · SF${self.spreadingFactor}`;
}

function presetLabel(p: Preset): string {
  return p.label ? t(p.label) : p.name;
}

const TELEMETRY: { value: string; label: Key }[] = [
  { value: String(TelemMode.Deny), label: "radio.telemetry.nobody" },
  { value: String(TelemMode.AllowFlags), label: "radio.telemetry.trusted" },
  { value: String(TelemMode.AllowAll), label: "radio.telemetry.anyone" },
];

/** Who may read a kind of telemetry, as the select offers it. */
const telemetryOptions = () => TELEMETRY.map((o) => ({ value: o.value, label: t(o.label) }));

/** The rest of the radio's settings go in one command, so a change to one sends all of them as they are. */
function saveOther(self: Self, patch: Partial<Pick<Self, "manualAddContacts" | "telemetryModeBase" | "telemetryModeLocation" | "telemetryModeEnvironment" | "advertLocPolicy" | "multiAcks">>) {
  return act(
    () =>
      session.setOtherParams({
        manualAddContacts: patch.manualAddContacts ?? self.manualAddContacts,
        telemetryModeBase: patch.telemetryModeBase ?? self.telemetryModeBase,
        telemetryModeLocation: patch.telemetryModeLocation ?? self.telemetryModeLocation,
        telemetryModeEnvironment: patch.telemetryModeEnvironment ?? self.telemetryModeEnvironment,
        advertLocPolicy: patch.advertLocPolicy ?? self.advertLocPolicy,
        multiAcks: patch.multiAcks ?? self.multiAcks,
      }),
    t("common.savedToRadio"),
  );
}

/**
 * A text field that saves itself when it is left or Enter is pressed, if it
 * changed and reads right. Nothing to press; the toast says it was saved.
 */
function CommitField({ label, hint, value, onCommit, check, disabled, inputMode, maxLength, mono }: { label: string; hint?: string | undefined; value: string; onCommit: (text: string) => Promise<unknown>; check?: (text: string) => string | null; disabled?: boolean | undefined; inputMode?: "decimal" | "numeric" | "text" | undefined; maxLength?: number | undefined; mono?: boolean | undefined }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() === value) return setError(null);
    const problem = check?.(text.trim()) ?? null;
    setError(problem);
    if (problem) return;
    void act(() => onCommit(text.trim()), t("common.savedToRadio")).then((ok) => ok || setText(value));
  };
  return (
    <Block>
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          className={["input", mono ? "mono" : ""].join(" ")}
          value={text}
          disabled={disabled}
          inputMode={inputMode}
          maxLength={maxLength}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            if (e.key === "Escape") setText(value);
          }}
        />
        {error ? <span className="field-hint danger">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
      </label>
    </Block>
  );
}

/** A number between two bounds; `range` says so in a whole sentence: "Latitude is between {min} and {max}." */
const number = (min: number, max: number, range: Key) => (text: string) => {
  const n = Number(text);
  return Number.isFinite(n) && text !== "" && n >= min && n <= max ? null : t(range, { min, max });
};

/** A position field also takes both halves at once, pasted from a map, and a half with a decimal comma. */
const orBoth = (check: (text: string) => string | null) => (text: string) => {
  const point = pointDecimal(text);
  return parseLatLon(point) ? null : check(point);
};

/** Both halves when the field was given both, or its own half. */
function setPosition(text: string, one: (n: number) => Promise<void>): Promise<void> {
  const point = pointDecimal(text);
  const both = parseLatLon(point);
  return both ? session.setLocation(both.lat, both.lon) : one(Number(point));
}

export function RadioPageView({ page, chrome }: { page: RadioPage; chrome: Chrome }) {
  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{radioTitle(page)}</span>
      </ScreenHead>
      {page === "log" ? <LogView /> : page === "air" ? <AirView /> : page === "console" ? <OwnConsole /> : <div className="screen-scroll">{<PageBody page={page} />}</div>}
    </div>
  );
}

function PageBody({ page }: { page: RadioPage }) {
  const state = useSession();
  const self = state.self;
  const online = state.status === "ready";
  switch (page) {
    case "name":
      return self ? <NamePage self={self} online={online} /> : <Offline />;
    case "frequency":
      return self ? <FrequencyPage self={self} online={online} /> : <Offline />;
    case "readings":
      return self ? <OwnReadings /> : <Offline />;
    case "privacy":
      return self ? <PrivacyPage self={self} online={online} /> : <Offline />;
    case "trusted":
      return self ? <TrustedPage online={online} /> : <Offline />;
    case "contacts":
      return <ContactsPage />;
    case "removed":
      return <RemovedPage />;
    case "advanced":
      return self ? <AdvancedPage self={self} online={online} /> : <Offline />;
    case "notifications":
      return <NotificationsPage />;
    case "sound":
      return <SoundPage />;
    case "soundDirect":
      return <KindSoundPage kind="direct" />;
    case "soundChats":
      return <KindSoundPage kind="chats" />;
    case "soundNodes":
      return <KindSoundPage kind="nodes" />;
    case "messages":
      return <MessagesPage />;
    case "history":
      return self ? <HistoryPage self={self} /> : <Offline />;
    case "appearance":
      return <AppearancePage />;
    case "background":
      return <BackgroundPage />;
    case "connection":
      return <ConnectionPage />;
    case "power":
      return <PowerPage />;
    case "about":
      return <AboutPage />;
    case "people":
      return <PeoplePage />;
    case "news":
      return <NewsPage />;
    default:
      return null;
  }
}

function OwnConsole() {
  const self = useSession().self;
  return self ? <Console own /> : <Offline />;
}

function Offline() {
  return <div className="empty muted">{t("radio.offline")}</div>;
}

function NamePage({ self, online }: { self: Self; online: boolean }) {
  return (
    <Group>
      <CommitField label={t("radio.name.name")} hint={t("radio.name.nameHint")} value={self.name} maxLength={31} disabled={!online} onCommit={(name) => session.setName(name)} check={(text) => (text ? null : t("radio.name.nameEmpty"))} />
    </Group>
  );
}

/**
 * Everything others can learn about the radio, by the way it reaches them:
 * where it is and whether every advert carries that to whoever hears it, then
 * what the radio answers when asked. Who may ask comes first, because the
 * radio answers nobody it would not give its battery, so position and sensors
 * reach no further.
 */
function PrivacyPage({ self, online }: { self: Self; online: boolean }) {
  const follow = useFollowStatus(self.key);
  const contacts = useSession().contacts;
  const [locating, setLocating] = useState(false);
  // The radio's own GPS writes its position itself, so the phone does not follow it there. A position typed or taken
  // from this device still stands until the GPS has a fix: that is the way out when the GPS is slow to find one.
  const following = follow.on && follow.gps !== true;
  const shared = self.advertLocPolicy !== AdvertLocPolicy.None;
  const base = self.telemetryModeBase;
  const narrower = telemetryOptions().filter((o) => Number(o.value) <= base);
  const trusted = Object.values(contacts).filter((c) => !c.unsaved && isTrusted(c)).length;
  const locate = async () => {
    setLocating(true);
    try {
      const fix = await locateOnce();
      await act(() => session.setLocation(Number(fix.lat.toFixed(6)), Number(fix.lon.toFixed(6))), t("radio.position.taken"));
    } catch (error) {
      toast(locateText(error), "error");
    } finally {
      setLocating(false);
    }
  };
  // Turned on, it asks the phone at once: the system's question comes up now, while the switch is in hand.
  const setFollow = async (on: boolean) => {
    if (!on) return setFollowPhone(self.key, false);
    setLocating(true);
    try {
      await locateOnce();
      setFollowPhone(self.key, true);
    } catch (error) {
      toast(locateText(error), "error");
    } finally {
      setLocating(false);
    }
  };
  const followHint =
    follow.gps === true
      ? t("radio.position.followGps")
      : !follow.on
        ? t("radio.position.followHint")
        : follow.rough !== null
          ? t("radio.position.followRough", { accuracy: follow.rough })
          : follow.wrote
            ? t("radio.position.followWrote", { time: agoPhrase(follow.wrote.at), accuracy: follow.wrote.accuracy })
            : t("radio.position.followWaiting");
  // The map's spot menu also puts the radio where a finger holds, or a mouse right-clicks.
  const mapHint = following ? undefined : t(canHover() ? "radio.position.mapHintMouse" : "radio.position.mapHint");
  return (
    <>
      <Group title={t("radio.privacy.location")} note={t("radio.privacy.nameNote")}>
        {phoneLocates() ? <SwitchRow label={t("radio.position.follow")} hint={followHint} checked={following} disabled={!online || locating || follow.gps === true} onChange={(v) => void setFollow(v)} /> : null}
        <CommitField
          label={t("radio.position.latitude")}
          hint={following ? undefined : t("radio.position.latitudeHint")}
          value={String(self.lat)}
          inputMode="decimal"
          disabled={!online || following}
          check={orBoth(number(-90, 90, "radio.check.latitude"))}
          onCommit={(text) => setPosition(text, (n) => session.setLocation(n, self.lon))}
        />
        <CommitField
          label={t("radio.position.longitude")}
          hint={mapHint}
          value={String(self.lon)}
          inputMode="decimal"
          disabled={!online || following}
          check={orBoth(number(-180, 180, "radio.check.longitude"))}
          onCommit={(text) => setPosition(text, (n) => session.setLocation(self.lat, n))}
        />
        {canLocate() && !following ? <ActionRow label={t("radio.position.useDevice")} hint={follow.gps === true ? t("radio.position.useDeviceGps") : undefined} disabled={!online} busy={locating} onClick={() => void locate()} /> : null}
        <SwitchRow
          label={t("radio.privacy.share")}
          hint={shared && following ? t("radio.privacy.shareFollowHint") : t("radio.privacy.shareHint")}
          checked={shared}
          disabled={!online}
          onChange={(v) => void saveOther(self, { advertLocPolicy: v ? AdvertLocPolicy.Share : AdvertLocPolicy.None })}
        />
      </Group>
      <Group title={t("radio.privacy.onRequest")} note={base === TelemMode.Deny ? t("radio.privacy.closed") : undefined}>
        <SelectRow label={t("radio.privacy.readings")} hint={t("radio.privacy.readingsHint")} value={String(base)} options={telemetryOptions()} disabled={!online} onChange={(v) => void saveOther(self, withBase(self, Number(v)))} />
        {/* The firmware puts a position in its answer only from its own GPS. */}
        {base !== TelemMode.Deny && follow.gps === true ? (
          <SelectRow label={t("radio.privacy.location")} value={String(reach(self.telemetryModeLocation, base))} options={narrower} disabled={!online} onChange={(v) => void saveOther(self, { telemetryModeLocation: Number(v) })} />
        ) : null}
        {base !== TelemMode.Deny ? (
          <SelectRow label={t("radio.privacy.sensors")} value={String(reach(self.telemetryModeEnvironment, base))} options={narrower} disabled={!online} onChange={(v) => void saveOther(self, { telemetryModeEnvironment: Number(v) })} />
        ) : null}
        {trustUsed(self, follow.gps) ? <LinkRow label={radioTitle("trusted")} value={String(trusted)} onClick={() => push({ kind: "radio", page: "trusted" })} /> : null}
      </Group>
    </>
  );
}

/**
 * The contacts trusted with what Privacy opens to trusted contacts: the people
 * among the contacts, since they are the ones who ask, and any other contact
 * another app trusted, so it can be let go. The order is taken as the page
 * opens, so a row stays under the finger when it is switched.
 */
function TrustedPage({ online }: { online: boolean }) {
  const contacts = useSession().contacts;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [first] = useState(() => new Set(Object.values(contacts).filter(isTrusted).map((c) => c.key)));
  const name = (c: ContactRecord) => c.name || c.prefix;
  const all = Object.values(contacts).filter((c) => !c.unsaved && (c.type === AdvType.Chat || isTrusted(c)));
  const q = query.trim().toLowerCase();
  const rows = all.filter((c) => !q || name(c).toLowerCase().includes(q)).sort((a, b) => Number(first.has(b.key)) - Number(first.has(a.key)) || name(a).localeCompare(name(b)));
  const toggle = async (key: string, on: boolean) => {
    setBusy(key);
    await act(() => session.setTrusted(key, on));
    setBusy(null);
  };
  if (all.length === 0) return <p className="group-note">{t("radio.trusted.nobodyYet")}</p>;
  return (
    <>
      <SearchField value={query} onValue={setQuery} placeholder={t("chats.list.find")} aria-label={t("radio.trusted.find")} />
      {rows.length ? (
        <Group note={t("radio.trusted.note")}>
          {rows.map((c) => (
            <SwitchRow key={c.key} icon={<Avatar name={name(c)} type={c.type} size={28} />} label={name(c)} checked={isTrusted(c)} disabled={!online || busy !== null} onChange={(v) => void toggle(c.key, v)} />
          ))}
        </Group>
      ) : (
        <p className="group-note">{t("radio.trusted.nobodyNamed")}</p>
      )}
    </>
  );
}

/**
 * The radio's frequency and power, and below them its place in the mesh:
 * whether it repeats for others and how long a hash repeaters write into its
 * paths. The firmware takes repeat in the same command as the frequency, so
 * the whole page goes to the radio with one Apply.
 */
function FrequencyPage({ self, online }: { self: Self; online: boolean }) {
  const { device, repeatFreqs } = useSession();
  const initial = () => ({
    frequency: (self.frequencyKhz / 1000).toFixed(3),
    bandwidth: (self.bandwidthHz / 1000).toString(),
    sf: String(self.spreadingFactor),
    cr: String(self.codingRate),
    tx: String(self.txPower),
    repeat: device?.repeatEnabled ?? false,
    hash: String(device?.pathHashMode ?? 0),
  });
  const [values, setValues] = useState(initial);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = initial();
  const dirty = JSON.stringify(values) !== JSON.stringify(now);
  // What the radio reports wins while nothing here was touched.
  useEffect(() => {
    if (!dirty) setValues(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self.frequencyKhz, self.bandwidthHz, self.spreadingFactor, self.codingRate, self.txPower, device?.repeatEnabled, device?.pathHashMode]);
  const update = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));
  const freq = Number(values.frequency);
  const tx = Number(values.tx);
  const valid = Number.isFinite(freq) && freq >= 150 && freq <= 2500 && Number.isInteger(tx) && tx >= -9 && tx <= self.maxTxPower;
  const params = { frequencyKhz: Math.round(freq * 1000), bandwidthHz: Math.round(Number(values.bandwidth) * 1000), spreadingFactor: Number(values.sf), codingRate: Number(values.cr) };
  const radioChanged = params.frequencyKhz !== self.frequencyKhz || params.bandwidthHz !== self.bandwidthHz || params.spreadingFactor !== self.spreadingFactor || params.codingRate !== self.codingRate;
  const canRepeat = repeatAllowed(params.frequencyKhz, repeatFreqs);
  // Off a frequency that allows it, repeat goes off, so the radio is never sent settings it would refuse.
  const repeat = values.repeat && canRepeat;
  const repeatChanged = device?.repeatEnabled != null && repeat !== device.repeatEnabled;
  const hash = Number(values.hash);
  const hashChanged = device?.pathHashMode != null && hash !== device.pathHashMode;

  const apply = async () => {
    setBusy(true);
    const ok = await act(async () => {
      // Firmware that knows repeat takes a missing flag as off, so it always goes with the frequency.
      if (radioChanged || repeatChanged) await session.setRadioParams(device?.repeatEnabled != null ? { ...params, repeat } : params);
      if (tx !== self.txPower) await session.setTxPower(tx);
      if (hashChanged) await session.setPathHashMode(hash);
    }, t("radio.frequency.applied"));
    setBusy(false);
    setAsking(false);
    if (!ok) setValues(initial());
  };

  return (
    <>
      <Group title={t("radio.frequency.preset")}>
        <Block>
          <div className="preset-chips">
            {PRESETS.map((p) => {
              const on = Math.round(freq * 1000) === p.frequencyKhz && Math.round(Number(values.bandwidth) * 1000) === p.bandwidthHz && Number(values.sf) === p.spreadingFactor && Number(values.cr) === p.codingRate;
              return (
                <button
                  key={p.name}
                  type="button"
                  className={["chip", on ? "on" : ""].join(" ")}
                  disabled={!online}
                  onClick={() => update({ frequency: (p.frequencyKhz / 1000).toFixed(3), bandwidth: (p.bandwidthHz / 1000).toString(), sf: String(p.spreadingFactor), cr: String(p.codingRate) })}
                >
                  {presetLabel(p)} <span className="muted">{(p.frequencyKhz / 1000).toFixed(3)}</span>
                </button>
              );
            })}
          </div>
        </Block>
      </Group>
      <Group title={t("radio.frequency.values")}>
        <Block>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">{t("radio.frequency.frequency")}</span>
              <input className="input mono" inputMode="decimal" value={values.frequency} disabled={!online} onChange={(e) => update({ frequency: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">{t("radio.frequency.bandwidth")}</span>
              <select className="input select" value={values.bandwidth} disabled={!online} onChange={(e) => update({ bandwidth: e.target.value })}>
                {BANDWIDTHS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t("radio.frequency.spreadingFactor")}</span>
              <select className="input select" value={values.sf} disabled={!online} onChange={(e) => update({ sf: e.target.value })}>
                {[5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                  <option key={n} value={n}>
                    SF{n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t("radio.frequency.codingRate")}</span>
              <select className="input select" value={values.cr} disabled={!online} onChange={(e) => update({ cr: e.target.value })}>
                {[5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    4/{n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t("radio.frequency.txPower", { max: self.maxTxPower })}</span>
              <input className="input mono" type="number" min={-9} max={self.maxTxPower} value={values.tx} disabled={!online} onChange={(e) => update({ tx: e.target.value })} />
            </label>
          </div>
        </Block>
      </Group>
      {device?.repeatEnabled != null || device?.pathHashMode != null ? (
        <Group title={t("radio.frequency.network")}>
          {device.repeatEnabled != null ? (
            <SwitchRow
              label={t("radio.frequency.repeat")}
              hint={canRepeat ? undefined : t("radio.frequency.repeatOnly", { list: repeatFreqsText(repeatFreqs ?? []) })}
              checked={repeat}
              disabled={!online || !canRepeat}
              onChange={(v) => update({ repeat: v })}
            />
          ) : null}
          {device.pathHashMode != null ? (
            <SelectRow
              label={t("radio.frequency.hash")}
              value={values.hash}
              options={HASH_MODES.map((m) => ({ value: String(m), label: `${t("radio.frequency.hashBytes", { count: m + 1 })} · ${t("radio.frequency.hashHops", { count: hashHops(m) })}` }))}
              disabled={!online}
              onChange={(v) => update({ hash: v })}
            />
          ) : null}
        </Group>
      ) : null}
      <div className="page-actions">
        {dirty ? <Button onClick={() => setValues(initial())}>{t("radio.frequency.revert")}</Button> : null}
        <Button variant="primary" size="lg" disabled={!dirty || !valid || !online} busy={busy} onClick={() => setAsking(true)}>
          {t("radio.frequency.apply")}
        </Button>
      </div>
      <Confirm
        open={asking}
        title={t("radio.frequency.confirmTitle")}
        body={confirmNotes({ radioChanged, repeatChanged, repeat, hashChanged, hash }).map((note) => (
          <p key={note}>{note}</p>
        ))}
        confirmLabel={t("radio.frequency.apply")}
        onCancel={() => setAsking(false)}
        onConfirm={apply}
      />
    </>
  );
}

/** What the confirm says will change, one line per kind of change; power alone says what a frequency change does, as it always has. */
function confirmNotes(c: { radioChanged: boolean; repeatChanged: boolean; repeat: boolean; hashChanged: boolean; hash: number }): string[] {
  const notes: string[] = [];
  if (c.radioChanged) notes.push(t("radio.frequency.confirmBody"));
  if (c.repeatChanged) notes.push(c.repeat ? t("radio.frequency.repeatOn") : t("radio.frequency.repeatOff"));
  if (c.hashChanged) notes.push(c.hash > 0 ? t("radio.frequency.hashLonger", { size: t("radio.frequency.hashBytes", { count: c.hash + 1 }) }) : t("radio.frequency.hashShorter"));
  return notes.length ? notes : [t("radio.frequency.confirmBody")];
}

/**
 * The radio's charge, and what its cell is made of (#26): the radio reports
 * only volts, so the type is what makes them a percent. Each type shows the
 * percent it would give now, so the one that looks right is plain to see.
 */
function AdvancedPage({ self, online }: { self: Self; online: boolean }) {
  const device = useSession().device;
  const hasConsole = useOwnConsole();
  return (
    <>
      {hasConsole ? (
        <Group title={t("radio.advanced.manage")}>
          <LinkRow label={t("radio.titles.console")} hint={t("radio.advanced.consoleHint")} onClick={() => push({ kind: "radio", page: "console" })} />
        </Group>
      ) : null}
      <Group title={t("radio.advanced.device")}>
        {device ? (
          <>
            <InfoRow label={t("radio.advanced.firmware")}>{t("radio.advanced.firmwareValue", { version: device.firmwareVersion, date: device.buildDate, protocol: device.firmwareVerCode })}</InfoRow>
            <InfoRow label={t("radio.advanced.board")}>{device.manufacturer}</InfoRow>
            <InfoRow label={t("radio.advanced.capacity")}>
              {t("radio.advanced.capacityValue", { contacts: t("radio.advanced.contacts", { count: device.maxContacts }), channels: t("radio.advanced.channels", { count: device.maxChannels }) })}
            </InfoRow>
            {device.blePin ? (
              <InfoRow label={t("radio.advanced.blePin")} mono>
                {String(device.blePin).padStart(6, "0")}
              </InfoRow>
            ) : null}
          </>
        ) : null}
        <LinkRow label={t("radio.advanced.publicKey")} value={<span className="mono">{self.key.slice(0, 16)}…</span>} trailing={<CopyIcon size={14} className="line-chev" />} onClick={() => void navigator.clipboard?.writeText(self.key).then(() => toast(t("common.copied")))} />
      </Group>
      <Group title={t("radio.advanced.clock")}>
        <ActionRow
          label={t("radio.advanced.setClock")}
          disabled={!online}
          onClick={() =>
            void act(async () => {
              // The radio takes no time behind its own, so one that runs ahead is only told about.
              const ahead = await session.syncClock(0);
              if (ahead > CLOCK_LEAD_S) toast(t("radio.advanced.clockAhead", { seconds: ahead }), "error");
              else toast(t("radio.advanced.clockSet"));
            })
          }
        />
      </Group>
    </>
  );
}

function NotificationsPage() {
  const prefs = useNoticePrefs();
  // Turning something on asks the system first: a notice it refuses would never show.
  const allowed = async () => {
    if (await askPermission()) return true;
    toast(t("radio.notifications.blocked"), "error");
    return false;
  };
  const change = async (patch: Partial<NoticePrefs>, on: boolean) => {
    if (on && !(await allowed())) return;
    setNoticePrefs(patch);
  };
  const desktop = shell() === "tauri";
  const phone = shell() === "capacitor";
  const windows = desktop && navigator.userAgent.includes("Windows");
  const app = "Ommesh";
  const own = prefs.shownBy === "app";
  // Who draws them, and what that means here: a computer's app draws all of them, a phone's and a tab's only while on screen.
  const shownHint = own
    ? desktop
      ? t(windows ? "radio.notifications.ownDesktopWindows" : "radio.notifications.ownDesktop", { app })
      : phone
        ? t("radio.notifications.ownPhone", { app })
        : t("radio.notifications.ownTab")
    : desktop
      ? t(windows ? "radio.notifications.systemDesktopWindows" : "radio.notifications.systemDesktop")
      : phone
        ? t("radio.notifications.systemPhone", { app })
        : t("radio.notifications.systemTab");
  const one = oneSignal(prefs);
  return (
    <>
      <Group title={t("radio.notifications.messages")}>
        <SwitchRow label={t("radio.notifications.direct")} hint={t("radio.notifications.directHint")} checked={prefs.direct} onChange={(v) => void change({ direct: v }, v)} />
        <SelectRow
          label={t("radio.notifications.chats")}
          hint={
            {
              all: t("radio.notifications.chatsAll"),
              mentions: t("radio.notifications.chatsMentions", { name: session.getState().self?.name ?? t("radio.notifications.yourName") }),
              off: t("radio.notifications.quiet"),
            }[prefs.chats]
          }
          value={prefs.chats}
          options={[
            { value: "all", label: t("radio.notifications.all") },
            { value: "mentions", label: t("radio.notifications.mentions") },
            { value: "off", label: t("common.off") },
          ]}
          onChange={(v) => void change({ chats: v }, v !== "off")}
        />
      </Group>
      <Group title={t("radio.notifications.mesh")}>
        <SelectRow
          label={t("radio.notifications.nodes")}
          hint={{ people: t("radio.notifications.nodesPeople"), all: t("radio.notifications.nodesAll"), off: t("radio.notifications.quiet") }[prefs.nodes]}
          value={prefs.nodes}
          options={[
            { value: "people", label: t("radio.notifications.people") },
            { value: "all", label: t("radio.notifications.all") },
            { value: "off", label: t("common.off") },
          ]}
          onChange={(v) => void change({ nodes: v }, v !== "off")}
        />
      </Group>
      <Group title={t("radio.notifications.popups")} note={t("radio.notifications.popupsNote")}>
        <SelectRow
          label={t("radio.notifications.shownBy")}
          hint={shownHint}
          value={prefs.shownBy}
          options={[{ value: "system", label: windows ? "Windows" : t("radio.notifications.system") }, { value: "app", label: app }]}
          onChange={(v) => setNoticePrefs({ shownBy: v })}
        />
        {desktop && own ? <CornerRow value={prefs.corner} onChange={(corner) => setNoticePrefs({ corner })} /> : null}
        <LinkRow label={t("radio.titles.sound")} value={one ? signalName(one) : t("radio.sound.mixed")} onClick={() => push({ kind: "radio", page: "sound" })} />
        {hasNoticeSettings() ? (
          <LinkRow
            label={windows ? t("radio.notifications.windowsSettings") : t("radio.notifications.systemSettings")}
            hint={phone ? t("radio.notifications.settingsPhoneHint") : t("radio.notifications.settingsHint")}
            onClick={() => void openNoticeSettings().catch(() => toast(t("radio.notifications.settingsFailed"), "error"))}
          />
        ) : null}
      </Group>
    </>
  );
}

/** Where a computer's own cards stack: a small screen with its four corners to pick from. */
function CornerRow({ value, onChange }: { value: Corner; onChange: (corner: Corner) => void }) {
  // Each corner by name for its button, and in a sentence for the line under the label.
  const names: Record<Corner, [Key, Key]> = {
    tl: ["radio.corner.tl", "radio.corner.tlOfScreen"],
    tr: ["radio.corner.tr", "radio.corner.trOfScreen"],
    bl: ["radio.corner.bl", "radio.corner.blOfScreen"],
    br: ["radio.corner.br", "radio.corner.brOfScreen"],
  };
  return (
    <div className="line">
      <span className="line-text">
        <span>{t("radio.corner.label")}</span>
        <small>{t(names[value][1])}</small>
      </span>
      <span className="corner-pick" role="radiogroup" aria-label={t("radio.corner.label")}>
        {(Object.keys(names) as Corner[]).map((corner) => (
          <button key={corner} type="button" role="radio" aria-checked={corner === value} aria-label={t(names[corner][0])} className={`corner-${corner}`} onClick={() => onChange(corner)} />
        ))}
      </span>
    </div>
  );
}

/** Each kind of notice, its name and the page where its sound is picked. */
const SOUND_KINDS: { kind: NoticeKind; label: Key; page: RadioPage }[] = [
  { kind: "direct", label: "radio.notifications.direct", page: "soundDirect" },
  { kind: "chats", label: "radio.notifications.chats", page: "soundChats" },
  { kind: "nodes", label: "radio.notifications.nodes", page: "soundNodes" },
];

/** The sound of each kind of notice, and of the chats that have one of their own (gh #73). */
function SoundPage() {
  const prefs = useNoticePrefs();
  const state = useSession();
  const note =
    shell() === "tauri"
      ? t("radio.sound.desktop")
      : shell() === "capacitor"
        ? nativePlatform() === "android"
          ? t("radio.sound.android")
          : t("radio.sound.ios")
        : t("radio.sound.web");
  const own = Object.keys(prefs.chatSound);
  return (
    <>
      <Group note={note}>
        {SOUND_KINDS.map((k) => (
          <LinkRow key={k.kind} label={t(k.label)} value={signalName(prefs.sounds[k.kind])} onClick={() => push({ kind: "radio", page: k.page })} />
        ))}
      </Group>
      {own.length > 0 ? (
        <Group title={t("radio.sound.chats")}>
          {own.map((conversation) => (
            <ChatSoundRow key={conversation} conversation={conversation} direct={isDirect(state, conversation)} name={titleOf(state, conversation)} />
          ))}
        </Group>
      ) : null}
    </>
  );
}

/** One kind's sound, to pick and hear. */
function KindSoundPage({ kind }: { kind: NoticeKind }) {
  const prefs = useNoticePrefs();
  return (
    <Group>
      {SIGNALS.map((s) => (
        <ChoiceRow
          key={s.id}
          label={t(s.label)}
          hint={t(s.hint)}
          checked={prefs.sounds[kind] === s.id}
          onSelect={() => {
            setNoticePrefs({ sounds: { ...prefs.sounds, [kind]: s.id } });
            previewSignal(s.id);
          }}
        />
      ))}
    </Group>
  );
}

/** What `n` tries come to, and what follows them, in one sentence. */
function triesHint(n: number): string {
  const span = triesSpanMs(n);
  return span < 60_000 ? t("radio.messages.triesMinute", { count: n }) : t("radio.messages.triesOver", { count: n, minutes: Math.round(span / 60_000) });
}

function MessagesPage() {
  const state = useSession();
  const lookalikes = useLookalikePrefs();
  const openAtUnread = useOpenAtUnread();
  const sendTries = useSendTries();
  return (
    <>
      <Group>
        <SwitchRow
          label={t("radio.messages.openAtUnread")}
          hint={t("radio.messages.openAtUnreadHint")}
          checked={openAtUnread}
          onChange={setOpenAtUnread}
        />
      </Group>
      <Group>
        <SwitchRow
          label={t("radio.messages.lookalikes")}
          hint={t("radio.messages.lookalikesHint")}
          checked={lookalikes.on}
          onChange={(v) => setLookalikePrefs({ on: v })}
        />
        {lookalikes.on ? <SwitchRow label={t("radio.messages.near")} hint={t("radio.messages.nearHint")} checked={lookalikes.near} onChange={(v) => setLookalikePrefs({ near: v })} /> : null}
      </Group>
      <Group note={t("radio.messages.triesNote")}>
        <StepperRow
          label={t("radio.messages.sendTries")}
          hint={sendTries === 1 ? t("radio.messages.sentOnce") : triesHint(sendTries)}
          value={sendTries}
          min={1}
          max={SEND_TRIES_MAX}
          format={(n) => (n === 1 ? t("radio.messages.once") : String(n))}
          onChange={setSendTries}
        />
      </Group>
      <Group note={state.self ? t("radio.messages.routesNote") : t("radio.messages.routesOffline")}>
        <SelectRow
          label={t("radio.messages.forgetRoutes")}
          value={limitValue(state.routing.resetAfterMin)}
          disabled={!state.self}
          options={ROUTE_LIMITS.map((m) => ({ value: limitValue(m), label: limitLabel(m) }))}
          onChange={(v) => session.setDefaultRouteReset(parseLimit(v) ?? null)}
        />
      </Group>
    </>
  );
}

/** Each language in its own words, so a reader lost in a foreign one still finds theirs. */
function LanguageGroup() {
  const preference = useSyncExternalStore(subscribeLanguage, getLanguagePreference);
  const options = [
    { value: "system", label: t("common.systemLanguage", { language: languageName(systemLanguage()) }) },
    ...languages().map((code) => ({ value: code, label: languageName(code) })),
  ];
  return (
    <Group>
      <SelectRow label={t("common.language")} value={preference} options={options} onChange={(v) => void setLanguagePreference(v)} />
    </Group>
  );
}

function AppearancePage() {
  const preference = useSyncExternalStore(subscribeTheme, getPreference);
  const active = useSyncExternalStore(subscribeTheme, getActiveTheme);
  const following = preference === "system";
  const textSize = useSyncExternalStore(subscribeTextSize, getTextSizePreference);
  const scale = useSyncExternalStore(subscribeTextSize, getTextScale);
  const system = useSyncExternalStore(subscribeTextSize, getSystemTextScale);
  const largeEmoji = useJumboEmoji();
  const background = useBackgroundPrefs().background;
  // The step nearest the size drawn now; the system's own size may fall between two.
  const step = TEXT_STEPS.reduce((best, s, i) => (Math.abs(s - scale) < Math.abs((TEXT_STEPS[best] ?? 1) - scale) ? i : best), 0);
  const percent = (s: number) => `${Math.round(s * 100)}%`;
  return (
    <>
      <LanguageGroup />
      <Group title={t("radio.appearance.theme")}>
        {/* Turned off, the theme drawn now stays, so the screen does not change under the finger. */}
        <SwitchRow label={t("common.followSystem")} hint={t("radio.appearance.themeHint")} checked={following} onChange={(v) => setPreference(v ? "system" : active.id)} />
        <Block className={["theme-tiles", following ? "following" : ""].join(" ")}>
          {listThemes().map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="theme-tile"
              aria-pressed={!following && active.id === theme.id}
              onClick={() => setPreference(theme.id)}
              style={{ "--swatch-bg": theme.tokens.bg, "--swatch-in": theme.tokens.bubbleIn, "--swatch-out": theme.tokens.bubbleOut } as React.CSSProperties}
            >
              <span className="theme-swatch" aria-hidden="true">
                <i />
                <i />
              </span>
              {t(theme.name)}
            </button>
          ))}
        </Block>
        <LinkRow label={radioTitle("background")} value={t(BACKGROUND_NAMES[background])} onClick={() => push({ kind: "radio", page: "background" })} />
      </Group>
      <Group title={t("radio.appearance.textSize")}>
        {hasSystemTextSize() ? (
          <SwitchRow label={t("common.followSystem")} hint={t("radio.appearance.phoneTextSize", { percent: percent(system) })} checked={textSize === "system"} onChange={(v) => setTextSizePreference(v ? "system" : String(TEXT_STEPS[step] ?? 1))} />
        ) : null}
        <Block className="text-size">
          <span className="text-size-a" aria-hidden="true">
            A
          </span>
          <input
            type="range"
            min={0}
            max={TEXT_STEPS.length - 1}
            step={1}
            value={step}
            aria-label={t("radio.appearance.textSize")}
            aria-valuetext={percent(scale)}
            onChange={(e) => setTextSizePreference(String(TEXT_STEPS[Number(e.target.value)] ?? 1))}
          />
          <span className="text-size-a large" aria-hidden="true">
            A
          </span>
          <span className="text-size-value">{percent(scale)}</span>
        </Block>
        {/* What a chat looks like at this size, drawn by the chat's own rules. */}
        <Block className="text-sample">
          <ChatBackdrop />
          <SampleMessages />
          <div className="msg in">
            <span className="msg-avatar">
              <Avatar name="Ridge" size={28} />
            </span>
            <div className="msg-col">
              <div className={largeEmoji ? "jumbo jumbo-1" : "bubble"}>
                <SenderName name="Ridge" />
                <span className="msg-text">👍</span>
                <span className="msg-meta">
                  <span>18:05</span>
                </span>
              </div>
            </div>
          </div>
        </Block>
        <SwitchRow label={t("radio.appearance.largeEmoji")} hint={t("radio.appearance.largeEmojiHint")} checked={largeEmoji} onChange={setJumboEmoji} />
      </Group>
    </>
  );
}

/** Someone's message and an answer, as a chat draws them, for a sample of how chats look. */
function SampleMessages() {
  return (
    <>
      <div className="msg in">
        <span className="msg-avatar">
          <Avatar name="Ridge" size={28} />
        </span>
        <div className="msg-col">
          <div className="bubble">
            <SenderName name="Ridge" />
            <span className="msg-text">{t("radio.appearance.sampleIn")}</span>
            <span className="msg-meta">
              <span>18:04</span>
            </span>
          </div>
        </div>
      </div>
      <div className="msg out">
        <div className="msg-col">
          <div className="bubble">
            <span className="msg-text">{t("radio.appearance.sampleOut")}</span>
            <span className="msg-meta">
              <span>18:05</span>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The picture behind every chat, as in Telegram: a sample chat on top, then the pictures,
 * each a patch of itself in the theme drawn now. A chat picks its own on its page.
 */
function BackgroundPage() {
  const prefs = useBackgroundPrefs();
  const shown = prefs.background !== "none" || Object.values(prefs.chat).some((b) => b !== "none");
  return (
    <>
      <Group>
        <Block className="text-sample bg-sample">
          <ChatBackdrop />
          <SampleMessages />
        </Block>
      </Group>
      <Group note={t("radio.background.chatNote")}>
        <Block className="theme-tiles bg-tiles">
          {BACKGROUNDS.map((b) => (
            <button key={b} type="button" className="theme-tile" aria-pressed={prefs.background === b} onClick={() => setBackground(b)}>
              <span className="bg-swatch" aria-hidden="true">
                <ChatBackdrop background={b} scale={0.5} swatch />
              </span>
              {t(BACKGROUND_NAMES[b])}
            </button>
          ))}
        </Block>
      </Group>
      {shown ? (
        <Group>
          <Block className="bg-control-label">{t("radio.background.strength")}</Block>
          <Block className="text-size">
            <span className="text-size-a" aria-hidden="true">
              <PictureIcon size={14} />
            </span>
            <input type="range" min={0} max={100} step={5} value={prefs.strength} aria-label={t("radio.background.strength")} aria-valuetext={`${prefs.strength}%`} onChange={(e) => setBackgroundStrength(Number(e.target.value))} />
            <span className="text-size-a large" aria-hidden="true">
              <PictureIcon size={20} />
            </span>
            <span className="text-size-value">{prefs.strength}%</span>
          </Block>
          <Block className="bg-control-label">{t("radio.background.scale")}</Block>
          <Block className="text-size">
            <span className="text-size-a" aria-hidden="true"><PictureIcon size={14} /></span>
            <input type="range" min={80} max={160} step={5} value={prefs.scale} aria-label={t("radio.background.scale")} aria-valuetext={`${prefs.scale}%`} onChange={(e) => setBackgroundScale(Number(e.target.value))} />
            <span className="text-size-a large" aria-hidden="true"><PictureIcon size={20} /></span>
            <span className="text-size-value">{prefs.scale}%</span>
          </Block>
        </Group>
      ) : null}
    </>
  );
}

function AboutPage() {
  const info = useDesktopUpdateInfo();
  const [stops, setStops] = useState<AppStop[]>([]);
  useEffect(() => {
    recentStops().then(setStops, () => setStops([]));
  }, []);
  return <>
    <Group note={t("radio.about.note")}>
      <InfoRow label="Ommesh" icon={<img src="./icon.svg" alt="" width={24} height={24} />}>{info.version}</InfoRow>
      <NewsRow />
      <NewBuildRow />
      <InfoRow label={t("radio.about.runningIn")}>{shell() === "tauri" ? t("radio.about.desktop") : shell() === "capacitor" ? t("radio.about.phone") : t("radio.about.browser")}</InfoRow>
      <PrivacyButton row />
      <ReportRow />
    </Group>
    <Group>
      <PeopleRow />
    </Group>
    {stops.length > 0 ? (
      <Group title={t("radio.about.stopped")} note={t("radio.about.stoppedNote")}>
        {stops.map((stop) => (
          <InfoRow key={`${stop.at}-${stop.what}`} label={`${dayLabel(stop.at / 1000)} ${timeOfDay(stop.at / 1000)}`} hint={stop.detail ?? undefined}>
            {stop.what === "page" ? t("radio.about.pageStopped", { reason: stop.reason }) : stop.reason}
          </InfoRow>
        ))}
      </Group>
    ) : null}
    <UpdateButton />
  </>;
}

function ConnectionPage() {
  const state = useSession();
  const link = useLink();
  const [auto, setAuto] = useState(autoConnectWanted);
  const [lend, setLend] = useState(relayWanted);
  const relay = useRelay();
  // Asked of the shell, since the entry can be removed outside the app; null until it answers.
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  useEffect(() => {
    if (!hasAutostart()) return;
    autostartEnabled().then(setAtLogin, () => setAtLogin(null));
  }, []);
  return (
    <>
      <Group>
        <InfoRow label={t("radio.connection.connected")}>{state.status === "ready" ? (state.link?.label ?? t("radio.connection.yes")) : link.phase === "connecting" ? t("radio.connection.reconnecting") : t("radio.connection.no")}</InfoRow>
        <SwitchRow
          label={t("radio.connection.reconnectAtLaunch")}
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            setAutoConnect(v);
          }}
        />
        {atLogin !== null ? (
          <SwitchRow
            label={autostartLabel()}
            hint={auto ? t("radio.connection.minimisedConnects") : t("radio.connection.minimised")}
            checked={atLogin}
            onChange={async (v) => {
              try {
                await setAutostart(v);
                setAtLogin(v);
              } catch (err) {
                toast(t("radio.connection.changeFailed", { error: errorText(err) }), "error");
              }
            }}
          />
        ) : null}
      </Group>
      {relayAvailable() && state.link?.kind === "ble" ? (
        <Group note={t("radio.connection.shareNote")}>
          <SwitchRow
            label={t("radio.connection.share")}
            hint={!lend ? undefined : relay.computer ? t("radio.connection.computerConnected") : t("radio.connection.waiting")}
            checked={lend}
            disabled={state.status !== "ready"}
            onChange={async (v) => {
              setLend(v);
              setRelayWanted(v);
              try {
                // The page already goes through the phone's link: only the computer's side changes.
                await setSharing(v);
              } catch (err) {
                toast(t("radio.connection.changeFailed", { error: errorText(err) }), "error");
              }
            }}
          />
        </Group>
      ) : null}
      {canOpenAnother() ? (
        <Group note={t("radio.connection.anotherNote")}>
          <ActionRow
            label={t("radio.connection.another")}
            onClick={() => openAnother().catch((err) => toast(t("radio.connection.changeFailed", { error: errorText(err) }), "error"))}
          />
        </Group>
      ) : null}
      <Group note={t("radio.connection.disconnectNote")}>
        <ActionRow label={t("radio.connection.disconnect")} onClick={() => void disconnect()} />
      </Group>
    </>
  );
}

function PowerPage() {
  const state = useSession();
  const online = state.status === "ready";
  const [ask, setAsk] = useState<"reboot" | "reset" | "forget" | null>(null);
  return (
    <>
      <Group>
        <ActionRow label={t("radio.power.reboot")} disabled={!online} onClick={() => setAsk("reboot")} />
      </Group>
      <Group note={t("radio.power.note")}>
        <ActionRow label={t("radio.power.reset")} danger disabled={!online} onClick={() => setAsk("reset")} />
        <ActionRow label={t("radio.power.forget")} danger disabled={!state.self} onClick={() => setAsk("forget")} />
      </Group>
      <Confirm
        open={ask === "reboot"}
        title={t("radio.power.rebootTitle")}
        body={<p>{t("radio.power.rebootBody")}</p>}
        confirmLabel={t("radio.power.rebootConfirm")}
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await act(() => session.reboot());
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "reset"}
        title={t("radio.power.resetTitle")}
        body={<p>{t("radio.power.resetBody")}</p>}
        confirmLabel={t("radio.power.resetConfirm")}
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await act(() => session.factoryReset());
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "forget"}
        title={t("radio.power.forgetTitle")}
        body={<p>{t("radio.power.forgetBody")}</p>}
        confirmLabel={t("common.delete")}
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          const self = session.getState().self;
          if (self) await storage.forget(self.key);
          for (const conv of new Set(session.getState().messages.map((m) => m.conversation))) session.deleteConversation(conv);
          setAsk(null);
          toast(t("radio.power.forgotten"));
        }}
      />
    </>
  );
}
