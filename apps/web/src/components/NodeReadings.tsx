import { useEffect, useState } from "react";
import { AdvType, NoReplyError, TelemMode, type BatterySample, type ContactRecord, type CoreStats, type LppReading, type NodeStats, type RadioStats } from "@meshnet/meshcore";
import { errorText } from "../i18n/errors.js";
import { locale, t } from "../i18n/index.js";
import { BATTERY_TYPES, batteryTypeLabel, setBatteryType, useChosenBatteryType } from "../lib/batteryType.js";
import { ago, agoPhrase, batteryPercent, errorShare, lowCharge } from "../lib/format.js";
import { openNodePage, push, showOnMap } from "../lib/nav.js";
import { clockDrift, isAdmin } from "../lib/nodes.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { ActionRow, ChoiceRow, Group, InfoRow, LinkRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { AlertIcon, CheckIcon } from "./Icons.js";
import { numberText, Readings } from "./Readings.js";
import { Sparkline } from "./node/Sparkline.js";

/** A week's fall this large says the battery is going down, and the week reads as from → to. */
const FALLING_MV = 50;
/** A node's clock this far off ours is worth setting. */
const DRIFT_WORTH_FIXING_S = 30;
/** How often the readings page asks this radio again while it is open. */
const OWN_EVERY_MS = 30_000;

interface Tile {
  id: string;
  label: string;
  value: string;
  unit?: string | undefined;
  sub?: string | undefined;
  /** The value wants a look: it turns amber, with a sign so it is not colour alone. */
  low?: boolean | undefined;
  line?: { values: number[]; times: number[]; unit: string; digits: number } | undefined;
  onClick?: (() => void) | undefined;
}

function TileView({ tile }: { tile: Tile }) {
  const body = (
    <>
      <span className="reading-label">{tile.label}</span>
      <span className={["reading-value", tile.low ? "low" : ""].join(" ")} title={tile.low ? t("node.readings.lowCharge") : undefined}>
        {tile.low ? <AlertIcon size={15} role="img" aria-hidden={false} aria-label={t("node.readings.lowCharge")} /> : null}
        {tile.value}
        {tile.unit ? <small>{tile.unit}</small> : null}
      </span>
      {tile.line && tile.line.values.length > 1 ? <Sparkline {...tile.line} /> : null}
      {tile.sub ? <span className="reading-sub">{tile.sub}</span> : null}
    </>
  );
  return tile.onClick ? (
    <button type="button" className="reading-tile tap" onClick={tile.onClick}>
      {body}
    </button>
  ) : (
    <div className="reading-tile">{body}</div>
  );
}

function volts(mv: number): string {
  return `${numberText(mv / 1000, 2)} ${t("node.unit.volt")}`;
}

/**
 * The battery, as a charge by the cell someone picked for this node, or "≈" by Li-ion when
 * nobody did; this radio's own reads without "≈". A low charge colours the number, judged by
 * the same cell. A week of answers draws its line, and a tap picks the cell.
 */
function batteryTile(mv: number, history: BatterySample[], chosen: ReturnType<typeof useChosenBatteryType>, own: boolean, onClick: () => void): Tile {
  const type = chosen ?? "liion";
  const percent = batteryPercent(mv, type);
  const first = history[0];
  const last = history.at(-1);
  const falling = !!first && !!last && history.length > 1 && first.mv - last.mv >= FALLING_MV;
  const lowest = Math.min(...history.map((s) => s.mv));
  const highest = Math.max(...history.map((s) => s.mv));
  const week =
    history.length < 2
      ? null
      : falling
        ? `${numberText(first!.mv / 1000, 2)} → ${volts(last!.mv)}`
        : highest - lowest < 10
          ? volts(last!.mv)
          : `${numberText(lowest / 1000, 2)}–${volts(highest)}`;
  const kind = chosen ? batteryTypeLabel(chosen) : own ? batteryTypeLabel("liion") : t("node.readings.typeUnknown");
  return {
    id: "battery",
    label: t("node.readings.battery"),
    value: chosen || own ? String(percent) : t("radio.readings.about", { value: percent }),
    unit: t("node.unit.percent"),
    sub: [volts(mv), kind, week ? t("node.readings.week", { range: week }) : null].filter(Boolean).join(" · "),
    low: lowCharge(mv, type),
    line: { values: history.map((s) => s.mv / 1000), times: history.map((s) => s.at), unit: t("node.unit.volt"), digits: 2 },
    onClick,
  };
}

/** Picking the cell a node runs on, with the charge each one makes of the volts it reported. */
function BatterySheet({ open, onClose, nodeKey, name, mv }: { open: boolean; onClose: () => void; nodeKey: string; name: string; mv: number }) {
  const chosen = useChosenBatteryType(nodeKey);
  return (
    <Sheet open={open} onClose={onClose} title={t("node.readings.typeTitle", { name })}>
      <Group note={t("node.readings.typeNote")}>
        <InfoRow label={t("node.readings.typeNow")}>{volts(mv)}</InfoRow>
        {BATTERY_TYPES.map((b) => (
          <ChoiceRow
            key={b.value}
            label={b.label}
            hint={t(b.hint)}
            value={`${batteryPercent(mv, b.value)} ${t("node.unit.percent")}`}
            checked={chosen === b.value}
            onSelect={() => {
              setBatteryType(nodeKey, b.value);
              onClose();
            }}
          />
        ))}
      </Group>
    </Sheet>
  );
}

/** The voltage on the channel a node reports itself on, in millivolts. */
function selfVolts(readings: LppReading[] | undefined): number | null {
  const r = readings?.find((x) => x.channel === 1 && x.type === "voltage");
  return r?.type === "voltage" ? Math.round(r.volts * 1000) : null;
}

function airTiles(stats: NodeStats, noise: { values: number[]; times: number[] }, room: boolean): Tile[] {
  const tiles: Tile[] = [
    { id: "noise", label: t("node.readings.noise"), value: String(stats.noiseFloor), unit: t("node.unit.dbm"), sub: t("node.readings.quieter"), line: { ...noise, unit: t("node.unit.dbm"), digits: 0 } },
  ];
  if (room) {
    tiles.push({ id: "posts", label: t("node.readings.posts"), value: stats.posted === null ? "—" : String(stats.posted), unit: t("node.readings.stored"), sub: stats.postPushes !== null ? t("node.status.pushes", { count: stats.postPushes }) : undefined });
  } else {
    tiles.push({
      id: "air",
      label: t("node.readings.onAir"),
      value: stats.upTimeSecs > 0 ? numberText((stats.airTimeSecs / stats.upTimeSecs) * 100, 1) : "—",
      unit: t("node.unit.percent"),
      sub: stats.rxAirTimeSecs !== null ? t("node.status.txRx", { tx: duration(stats.airTimeSecs), rx: duration(stats.rxAirTimeSecs) }) : t("node.status.tx", { time: duration(stats.airTimeSecs) }),
    });
  }
  tiles.push({ id: "uptime", label: t("node.readings.uptime"), value: duration(stats.upTimeSecs) });
  return tiles;
}

/**
 * How a node is doing, the same for a person, a repeater, a room or a sensor: its battery first,
 * then for a repeater or a room the air it sits on, then its board, its position and whatever is
 * wired to it. "Refresh" asks what the node answers: a repeater or a room its status, anyone else
 * its telemetry. A repeater's or a room's telemetry is its own request, a row of its own.
 */
export function NodeReadings({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const name = contact.name || contact.prefix;
  const online = state.status === "ready";
  const statusNode = contact.type === AdvType.Repeater || contact.type === AdvType.Room;
  const status = statusNode ? state.statuses[key] : undefined;
  const stats = status?.stats ?? null;
  const telemetry = state.telemetry[key];
  const login = state.logins[key];
  const chosen = useChosenBatteryType(key);
  const [busy, setBusy] = useState<"refresh" | "more" | null>(null);
  const [silent, setSilent] = useState(false);
  const [picking, setPicking] = useState(false);

  const history: BatterySample[] = statusNode ? (state.statusHistory[key] ?? []).map((s) => ({ at: s.at, mv: s.batteryMv })) : (state.batteryHistory[key] ?? []);
  const mv = stats?.batteryMv ?? selfVolts(telemetry?.readings);
  const noiseHistory = statusNode ? (state.statusHistory[key] ?? []) : [];
  const tiles: Tile[] = [];
  if (mv !== null && mv > 0) tiles.push(batteryTile(mv, history, chosen, false, () => setPicking(true)));
  if (stats) tiles.push(...airTiles(stats, { values: noiseHistory.map((s) => s.noiseFloor), times: noiseHistory.map((s) => s.at) }, contact.type === AdvType.Room));

  const ask = (what: "refresh" | "more", request: () => Promise<unknown>) => async () => {
    setBusy(what);
    try {
      await request();
      setSilent(false);
    } catch (e) {
      if (e instanceof NoReplyError && !statusNode) setSilent(true);
      else toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const refresh = ask("refresh", () => (statusNode ? session.requestStatus(key) : session.requestTelemetry(key)));
  const answeredAt = statusNode ? status?.at : telemetry?.at;
  const drift = clockDrift(login);
  const admin = isAdmin(login);

  return (
    <>
      <Group title={answeredAt ? t("node.readings.titleAgo", { time: ago(answeredAt) }) : t("node.readings.title")} note={silent ? t("mesh.profile.readingsSilent") : contact.type === AdvType.Sensor ? (contact.name ? t("node.status.alerts", { name: contact.name }) : t("node.status.alertsUnnamed")) : undefined}>
        {tiles.length ? (
          <div className="line-block readings">
            <div className="reading-tiles">
              {tiles.map((tile) => (
                <TileView key={tile.id} tile={tile} />
              ))}
            </div>
          </div>
        ) : null}
        {status && !stats ? <InfoRow label={t("node.readings.answer")}>{t("node.status.unreadBytes", { count: status.raw.length / 2 })}</InfoRow> : null}
        {telemetry ? (
          <>
            {statusNode ? (
              <div className="reading-part-head">
                <span>{t("node.readings.moreAgo", { time: ago(telemetry.at) })}</span>
                <button type="button" className="link" disabled={!online || busy !== null} onClick={ask("more", () => session.requestTelemetry(key))}>
                  {t("node.readings.refresh")}
                </button>
              </div>
            ) : null}
            <Readings readings={telemetry.readings} skipBattery titled from={state.self} onMap={() => showOnMap(key, true)} />
          </>
        ) : statusNode ? (
          <ActionRow label={t("node.readings.more")} hint={t("node.readings.moreHint")} air busy={busy === "more"} disabled={!online || busy !== null} onClick={ask("more", () => session.requestTelemetry(key))} />
        ) : null}
        {stats ? <PacketsAndSignal stats={stats} /> : null}
        {drift !== null ? (
          Math.abs(drift) > DRIFT_WORTH_FIXING_S ? (
            <>
              <InfoRow label={t("node.status.clock")} hint={t("node.status.clockHint", { time: agoPhrase(login!.at) })}>
                <span className="pill warn">
                  <AlertIcon size={11} />
                  {t(drift > 0 ? "node.status.behind" : "node.status.ahead", { seconds: Math.abs(drift) })}
                </span>
              </InfoRow>
              {admin ? <ActionRow label={t("node.status.setClock")} air disabled={!online} onClick={() => void act(() => session.runCli(key, "clock sync"), t("node.status.clockSet"))} /> : null}
            </>
          ) : (
            <InfoRow label={t("node.status.clock")}>
              <span className="pill ok">
                <CheckIcon size={11} />
                {t("node.status.inSync")}
              </span>
            </InfoRow>
          )
        ) : null}
        {contact.type === AdvType.Sensor && login?.ok ? <LinkRow label={t("node.page.history")} value={t("node.readings.historyHint")} onClick={() => openNodePage(key, "history")} /> : null}
        <ActionRow label={t("node.readings.refresh")} hint={statusNode ? t("node.readings.refreshStatus") : undefined} air busy={busy === "refresh"} disabled={!online || busy !== null} onClick={refresh} />
      </Group>
      {mv !== null ? <BatterySheet open={picking} onClose={() => setPicking(false)} nodeKey={key} name={name} mv={mv} /> : null}
    </>
  );
}

/**
 * This radio's readings, on their own page: its battery, the air it hears, its board, its
 * position and whatever is wired to it. All of it is asked of the radio over its link, not of
 * the air, as the page opens and every half minute while it stays open.
 */
export function OwnReadings() {
  const state = useSession();
  const self = state.self;
  const online = state.status === "ready";
  const chosen = useChosenBatteryType(self?.key);
  const [radio, setRadio] = useState<RadioStats | null>(null);
  const [core, setCore] = useState<CoreStats | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!online) return;
    const read = () => {
      void session.refreshBattery().catch(() => undefined);
      void session.requestTelemetry().catch(() => undefined);
      void session.radioStats().then(setRadio, () => undefined);
      void session.coreStats().then(setCore, () => undefined);
    };
    read();
    const timer = window.setInterval(read, OWN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [online]);

  if (!self) return null;
  const telemetry = state.telemetry["self"];
  const mv = state.battery?.mv ?? selfVolts(telemetry?.readings);
  const tiles: Tile[] = [];
  if (mv !== null && mv > 0) tiles.push(batteryTile(mv, state.batteryHistory["self"] ?? [], chosen, true, () => setPicking(true)));
  if (radio) tiles.push({ id: "noise", label: t("node.readings.noise"), value: String(radio.noiseFloor), unit: t("node.unit.dbm"), sub: t("node.readings.quieter") });
  if (radio && core) {
    tiles.push({
      id: "air",
      label: t("node.readings.onAir"),
      value: core.uptimeSecs > 0 ? numberText((radio.txAirSecs / core.uptimeSecs) * 100, 1) : "—",
      unit: t("node.unit.percent"),
      sub: t("node.status.txRx", { tx: duration(radio.txAirSecs), rx: duration(radio.rxAirSecs) }),
    });
  }
  if (core) tiles.push({ id: "uptime", label: t("node.readings.uptime"), value: duration(core.uptimeSecs) });
  const at = Math.max(state.battery?.at ?? 0, telemetry?.at ?? 0, radio?.at ?? 0);
  const mode = (value: number) => telemetryModes().find((o) => o.value === value)?.label.toLowerCase() ?? String(value);

  return (
    <>
      <Group title={at ? t("node.readings.titleAgo", { time: ago(at) }) : t("node.readings.title")} note={t("radio.sensors.read", { time: agoPhrase(at || null) })}>
        {tiles.length ? (
          <div className="line-block readings">
            <div className="reading-tiles">
              {tiles.map((tile) => (
                <TileView key={tile.id} tile={tile} />
              ))}
            </div>
          </div>
        ) : null}
        {telemetry ? <Readings readings={telemetry.readings} skipBattery titled onCopy={(text) => void navigator.clipboard?.writeText(text).then(() => toast(t("common.copied")))} /> : null}
        <ActionRow label={t("node.readings.refresh")} disabled={!online} onClick={() => void act(() => Promise.all([session.refreshBattery(), session.requestTelemetry(), session.radioStats().then(setRadio), session.coreStats().then(setCore)]))} />
      </Group>
      <Group>
        <LinkRow
          label={t("radio.sensors.who")}
          hint={t("radio.sensors.whoValue", { battery: mode(self.telemetryModeBase), location: mode(self.telemetryModeLocation), sensors: mode(self.telemetryModeEnvironment) })}
          onClick={() => push({ kind: "radio", page: "privacy" })}
        />
      </Group>
      {mv !== null ? <BatterySheet open={picking} onClose={() => setPicking(false)} nodeKey={self.key} name={self.name} mv={mv} /> : null}
    </>
  );
}

/** Who may read this radio's telemetry, as the privacy page words it. */
function telemetryModes(): { value: number; label: string }[] {
  return [
    { value: TelemMode.Deny, label: t("radio.telemetry.nobody") },
    { value: TelemMode.AllowFlags, label: t("radio.telemetry.flagged") },
    { value: TelemMode.AllowAll, label: t("radio.telemetry.anyone") },
  ];
}

/**
 * A node's counters since it last started, by direction: what it received, what it heard but
 * could not make out, what it sent and what it dropped as heard before, each total over its split
 * by flood and direct. Receive errors carry their share of everything heard, a figure people ask
 * for when they judge a repeater's spot.
 */
function PacketsAndSignal({ stats }: { stats: NodeStats }) {
  const split = (flood: number, direct: number) => t("node.status.floodDirectSplit", { flood: n(flood), direct: n(direct) });
  return (
    <details className="more reading-more">
      <summary>{t("node.status.packetsAndSignal")}</summary>
      <div className="kv-grid">
        <Kv label={t("node.status.received")} sub={split(stats.recvFlood, stats.recvDirect)}>
          {n(stats.packetsRecv)}
        </Kv>
        {stats.recvErrors !== null ? (
          <Kv label={t("node.status.recvErrors")} sub={stats.recvErrors > 0 ? t("node.status.heard", { total: n(stats.packetsRecv + stats.recvErrors) }) : undefined}>
            {errorsText(stats.recvErrors, stats.packetsRecv)}
          </Kv>
        ) : null}
        <Kv label={t("node.status.sent")} sub={split(stats.sentFlood, stats.sentDirect)}>
          {n(stats.packetsSent)}
        </Kv>
        <Kv label={t("node.status.duplicates")} sub={split(stats.floodDups, stats.directDups)}>
          {n(stats.floodDups + stats.directDups)}
        </Kv>
        <Kv label={t("node.status.lastSignal")}>{t("node.status.signal", { rssi: stats.lastRssi, snr: numberText(stats.lastSnr, 2) })}</Kv>
        <Kv label={t("node.status.sendQueue")}>{stats.txQueueLen === 0 ? t("node.status.empty") : t("node.status.queuePackets", { count: stats.txQueueLen })}</Kv>
      </div>
    </details>
  );
}

/** The errors with their share in brackets; a share under a tenth of a percent reads "< 0.1". */
function errorsText(errors: number, received: number): string {
  const share = errorShare(errors, received);
  if (share === null) return n(errors);
  return t("node.status.errorsShare", { errors: n(errors), share: share < 0.1 ? `< ${numberText(0.1, 1)}` : numberText(share, 1) });
}

function Kv({ label, sub, children }: { label: string; sub?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className="kv-value">
        {sub ? (
          <span className="kv-stack">
            <span>{children}</span>
            <span className="kv-sub">{sub}</span>
          </span>
        ) : (
          children
        )}
      </span>
    </div>
  );
}

function n(value: number): string {
  return value.toLocaleString(locale());
}

export function duration(secs: number): string {
  if (secs >= 86_400) return t("node.duration.days", { days: Math.floor(secs / 86_400), hours: Math.floor((secs % 86_400) / 3600) });
  if (secs >= 3600) return t("node.duration.hours", { hours: Math.floor(secs / 3600), minutes: Math.floor((secs % 3600) / 60) });
  return t("node.duration.minutes", { minutes: Math.floor(secs / 60) });
}
