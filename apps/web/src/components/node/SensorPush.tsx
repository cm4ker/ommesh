import { useState } from "react";
import { LPP_CHANNEL_SELF, NoReplyError, PushRefusedError, type ContactRecord, type PushThreshold } from "@meshnet/meshcore";
import { timeOfDay } from "../../lib/format.js";
import { back, openNodePage } from "../../lib/nav.js";
import { isAdmin } from "../../lib/nodes.js";
import { defaultThresholds, deltaLabel, fits, pushTargets, thresholdSteps, withThreshold, type PushTarget } from "../../lib/sensorPush.js";
import { session, useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { Group, LinkRow, SelectRow, SwitchRow } from "../../ui/List.js";
import { readingName } from "../Readings.js";
import { t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";

/** Says why a sensor did not take the ask, its console a tap away for an admin, who can give it a region. */
function told(error: unknown, contact: ContactRecord, admin: boolean): void {
  if (error instanceof PushRefusedError) {
    toast(t("node.push.refused"), "error", admin ? { label: t("node.push.console"), run: () => openNodePage(contact.key, "console") } : undefined, t("node.push.refusedDetail"));
  } else if (error instanceof NoReplyError) {
    toast(t("node.push.silent"), "error", undefined, t("node.push.silentDetail"));
  } else {
    toast(errorText(error), "error");
  }
}

/**
 * The sensor's readings sent by itself as they move (MeshCore 1.18): a switch, and when it is on,
 * what it sends on behind a tap. The thresholds start at the ones that fit, from its last readings.
 */
export function PushRows({ contact, online }: { contact: ContactRecord; online: boolean }) {
  const state = useSession();
  const key = contact.key;
  const watch = state.pushes[key];
  const on = watch?.state === "on" || watch?.state === "asking";
  const [busy, setBusy] = useState(false);
  const admin = isAdmin(state.logins[key]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (!next) return await session.unwatchSensor(key);
      let readings = state.telemetry[key]?.readings;
      // The thresholds are set on readings it has: with none known yet, it is asked for them first.
      if (!readings) {
        await session.requestTelemetry(key);
        readings = session.getState().telemetry[key]?.readings;
      }
      const thresholds = watch?.thresholds.length ? watch.thresholds : defaultThresholds(readings ?? []);
      if (!thresholds.length) return toast(t("node.push.nothing"), "error");
      await session.watchSensor(key, thresholds);
    } catch (error) {
      told(error, contact, admin);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SwitchRow
        label={t("node.push.switch")}
        hint={on && watch.until ? t("node.push.until", { time: timeOfDay(watch.until / 1000) }) : undefined}
        checked={on}
        disabled={!online || busy}
        onChange={(next) => void toggle(next)}
      />
      {on ? <LinkRow label={t("node.page.push")} value={t("node.push.count", { count: watch.thresholds.length })} onClick={() => openNodePage(key, "push")} /> : null}
    </>
  );
}

/**
 * Which readings the sensor sends on and how far each must move first. A change is one ask of the
 * sensor; taking the last one off stops it sending, as the switch does.
 */
export function PushPage({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const watch = state.pushes[key];
  const chosen: PushThreshold[] = watch?.thresholds ?? [];
  const online = state.status === "ready";
  const [busy, setBusy] = useState(false);
  const admin = isAdmin(state.logins[key]);

  // The readings it has, and any chosen before that its last telemetry left out.
  const targets: PushTarget[] = pushTargets(state.telemetry[key]?.readings ?? []);
  for (const c of chosen) if (!targets.some((x) => x.channel === c.channel && x.type === c.type)) targets.push({ channel: c.channel, type: c.type });
  const twice = new Set(targets.filter((x, i) => targets.some((y, j) => j !== i && y.type === x.type)).map((x) => x.type));

  const change = async (target: PushTarget, value: string) => {
    const next = withThreshold(chosen, target, value === "off" ? null : Number(value));
    setBusy(true);
    try {
      if (next.length === 0) {
        await session.unwatchSensor(key);
        back();
      } else {
        await session.watchSensor(key, next);
      }
    } catch (error) {
      told(error, contact, admin);
    } finally {
      setBusy(false);
    }
  };

  const full = targets.some((x) => !chosen.some((c) => c.channel === x.channel && c.type === x.type) && !fits(chosen, x));
  return (
    <div className="screen-scroll">
      <Group title={t("node.push.whenTitle")} note={full ? t("node.push.full") : undefined}>
        {targets.map((x) => {
          const kept = chosen.find((c) => c.channel === x.channel && c.type === x.type);
          // The node's own channel carries its battery: said so, as its tile says.
          const name = x.channel === LPP_CHANNEL_SELF && x.type === "voltage" ? t("radio.readings.battery") : readingName(x.type);
          const label = twice.has(x.type) && x.channel !== LPP_CHANNEL_SELF ? `${name} · ${t("node.push.channel", { channel: x.channel })}` : name;
          return (
            <SelectRow
              key={`${x.channel}:${x.type}`}
              label={label}
              value={kept ? String(kept.delta) : "off"}
              options={[{ value: "off", label: t("node.push.off") }, ...thresholdSteps(x.type).map((v) => ({ value: String(v), label: deltaLabel(x.type, v) }))]}
              disabled={!online || busy || (!kept && !fits(chosen, x))}
              onChange={(v) => void change(x, v)}
            />
          );
        })}
      </Group>
    </div>
  );
}
