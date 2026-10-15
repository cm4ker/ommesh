/**
 * A repeater checked with no relays between (#95): the trace names only it,
 * so it comes back only if the repeater hears this radio from where it
 * stands and this radio hears it back. The route held to it plays no part.
 * Five rounds, as Check along the route; the result says how each way
 * sounded, and a tap opens the line of sight. Heard while the route held
 * goes through relays, it can become the route.
 */

import { contactRoute } from "@meshnet/meshcore";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import { forgetDiscovery } from "../../lib/discovery.js";
import { distanceKm, formatDistance } from "../../lib/geo.js";
import { formatSnr } from "../../lib/los.js";
import { contactEnd, selfEnd } from "../../lib/mapOverlay.js";
import type { DirectTool } from "../../lib/meshTool.js";
import { directKey, legSnr, measuredLegs, ping, ROUNDS, settleDirect, stopPing, usePing, type Ping } from "../../lib/ping.js";
import { session, useSession } from "../../lib/session.js";
import { act } from "../../lib/toast.js";
import { closeTool, openLineOfSight } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { AlertIcon, ChartIcon, ChevronRightIcon } from "../Icons.js";
import { Dots, QualityChip, SheetHead } from "./RouteSheet.js";

export function DirectSheet({ tool, onClose }: { tool: DirectTool; onClose: () => void }) {
  const state = useSession();
  const key = directKey(tool.key);
  const p = usePing(key);
  const [saving, setSaving] = useState(false);
  const contact = state.contacts[tool.key];

  if (!contact) {
    return (
      <div className="tool route-sheet">
        <SheetHead title={t("tools.route.title")} sub={t("tools.contactGone")} onBack={onClose} />
      </div>
    );
  }

  const name = contact.name || contact.prefix;
  const online = state.status === "ready";
  const running = p?.running ?? false;
  const me = selfEnd(state);
  const end = contactEnd(contact);
  const km = me && end ? distanceKm(me.lat, me.lon, end.lat, end.lon) : null;
  const openLeg = me && end ? () => openLineOfSight(me, end, tool.key, measuredLegs(p)[0] ?? null) : null;
  // Heard with no relays while the radio goes through some, or holds no route: it can go straight instead.
  const held = contactRoute(contact);
  const heard = !!p && !running && p.runs.some((r) => r.ok);
  const canKeep = heard && !session.routePolicy(tool.key).flood && (held === null || held.length > 0);
  const keep = async () => {
    setSaving(true);
    const ok = await act(() => session.setRoute(tool.key, []), t("tools.route.saved"));
    setSaving(false);
    if (!ok) return;
    settleDirect(tool.key);
    // What a flood found was measured against the route this one replaces.
    forgetDiscovery(tool.key);
    closeTool();
  };

  return (
    <div className="tool route-sheet">
      <SheetHead title={t("tools.direct.title", { name })} sub={km !== null ? t("tools.direct.sub", { distance: formatDistance(km) }) : t("tools.direct.subOffMap")} onBack={onClose} />
      {p ? <DirectResult p={p} name={name} km={km} onLeg={openLeg} /> : null}
      <Button variant={running ? "default" : "primary"} size="lg" disabled={!online && !running} onClick={() => (running ? stopPing(key) : void ping(key))}>
        {running ? t("tools.stop") : t("tools.check")}
      </Button>
      {canKeep ? (
        <div className="route-links">
          <button type="button" className="check-link" disabled={!online || saving} onClick={() => void keep()}>
            {t("tools.direct.keep")}
            {held?.length ? <small>{t("tools.direct.instead", { count: held.length })}</small> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * How the check is getting on, then what it came to: the time, how many
 * came back and the leg in a word, with how each way sounded; or that none
 * came back. The leg opens its line of sight when both ends are on the map.
 */
function DirectResult({ p, name, km, onLeg }: { p: Ping; name: string; km: number | null; onLeg: (() => void) | null }) {
  if (p.error && !p.running) return <p className="check-note">{p.error}</p>;
  if (p.running) {
    return (
      <div className="check-result">
        <Dots marks={p.runs.map((r) => r.ok)} total={ROUNDS} live />
        <span className="muted">{t("tools.check.round", { n: Math.min(p.runs.length + 1, ROUNDS), total: ROUNDS })}</span>
      </div>
    );
  }
  const done = p.runs.length;
  if (done === 0) return null;
  const good = p.runs.filter((r) => r.ok);
  const legRow = (sub: string, warn: boolean) =>
    onLeg ? (
      <button type="button" className={warn ? "check-row warn" : "check-row"} onClick={onLeg}>
        {warn ? <AlertIcon size={18} /> : <ChartIcon size={18} />}
        <span className="grow">
          {t("tools.direct.leg", { name })}
          <small>{sub}</small>
        </span>
        <ChevronRightIcon size={14} className="line-chev" />
      </button>
    ) : null;

  if (good.length === 0) {
    return (
      <>
        <p className="disc-line bad">
          <b>{t("tools.direct.notHeard")}</b> {t("tools.direct.notHeardWhy", { total: done, name })}
        </p>
        {legRow(km !== null ? `${formatDistance(km)} · ${t("tools.check.tapLos")}` : t("tools.check.tapLos"), false)}
      </>
    );
  }

  const avg = good.reduce((s, r) => s + (r.rttMs ?? 0), 0) / good.length;
  const leg = measuredLegs(p)[0] ?? null;
  const snr = leg ? legSnr(leg) : null;
  return (
    <>
      <div className="check-result">
        <b className="mono">{t("tools.unit.ms", { value: Math.round(avg) })}</b>
        <span className="muted">{t("tools.check.cameBack", { good: good.length, total: done })}</span>
        {snr !== null ? <QualityChip snr={snr} numbers={false} /> : null}
      </div>
      {leg
        ? legRow(
            leg[1] !== null ? t("tools.direct.both", { out: formatSnr(leg[0]), back: formatSnr(leg[1]) }) : t("tools.direct.out", { out: formatSnr(leg[0]) }),
            snr !== null && (snr < -5 || good.length < done),
          )
        : null}
    </>
  );
}
