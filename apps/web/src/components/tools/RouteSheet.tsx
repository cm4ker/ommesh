/**
 * The route to a contact, in a sheet over the map: the way the radio holds,
 * what the last check of it came to, and one button. Check traces five times
 * out along the route and back; when that stays silent it finds where the
 * route breaks and looks for a way round in what the radio has heard, and a
 * way that comes back becomes the route (lib/ping.ts). A point dragged or a
 * repeater tapped on the map starts a change, and the same button checks it
 * and then saves it. Asking the whole mesh (a flood), the way from here to
 * another repeater, and how long a learned route lasts are in ⋯.
 * Everywhere else a route is one row that opens this.
 */

import { AdvType, contactRoute, isConversationType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { useState, type ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { discover, forgetDiscovery, undoDiscovery, useDiscovery, type Discovery } from "../../lib/discovery.js";
import { nameOfHash } from "../../lib/echoes.js";
import { agoPhrase } from "../../lib/format.js";
import { legId, useLegVerdicts } from "../../lib/legVerdicts.js";
import { formatSnr, quality, qualityWord, type LinkRadio } from "../../lib/los.js";
import { contactEnd, defaultHeight, relayOf, sameRelays, selfEnd } from "../../lib/mapOverlay.js";
import { setMeshTool, type LosEnd, type RouteTool } from "../../lib/meshTool.js";
import { keepLooking, measuredLegs, ping, ROUNDS, settlePing, stopPing, undoFound, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { inMinutes, limitLabel, ROUTE_LIMITS, routeStatus, useNow } from "../../lib/routes.js";
import { session, useSession } from "../../lib/session.js";
import { act, toast } from "../../lib/toast.js";
import { cancelRouteEdit, openLineOfSight, openRoute, openSpan } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { glue, LinkRow } from "../../ui/List.js";
import { showMenu, type MenuItem } from "../../ui/Menu.js";
import { AlertIcon, BackIcon, CheckIcon, ChevronRightIcon, MoreIcon } from "../Icons.js";
import { SignIn } from "../node/SignIn.js";

export function QualityChip({ snr, numbers = true }: { snr: number; numbers?: boolean }) {
  const q = quality(snr);
  return (
    <span className={`quality ${q}`}>
      {qualityWord(q)}
      {numbers ? <small>{t("tools.unit.db", { value: formatSnr(snr) })}</small> : null}
    </span>
  );
}

/** The row that stands for a route wherever a node is shown: how it goes, and how it did last; it opens the sheet. */
export function RouteLink({ contactKey }: { contactKey: string }) {
  const state = useSession();
  const p = usePing(contactKey);
  const d = useDiscovery(contactKey);
  const contact = state.contacts[contactKey];
  if (!contact) return null;
  const status = routeStatus(contact, p, d);
  return <LinkRow label={t("tools.route.title")} value={<span className={`route-${status.tone}`}>{glue(status.text)}</span>} onClick={() => openRoute(contactKey)} />;
}

/** The relays a ping went through, and the contact when it passes nothing on. */
function relaysOf(p: Ping): string[] {
  return p.targetInChain ? p.chain.slice(0, -1) : p.chain;
}

/** Each node along the route, this radio first, by name where the hash names one contact. */
function namesAlong(p: Ping, contact: ContactRecord, state: SessionState): string[] {
  return [t("tools.you"), ...relaysOf(p).map((h) => nameOfHash(h, state.contacts) ?? h), contact.name || contact.prefix];
}

/** Where along a chain it broke: after the node before the leg, or at the first hop. */
export function breakWords(p: Ping, state: SessionState): string | null {
  if (!p.broken) return null;
  const { chain, at } = p.broken;
  return at === 0 ? t("tools.break.first") : t("tools.break.after", { name: nameOfHash(chain[at - 1]!, state.contacts) ?? chain[at - 1]! });
}

/** The two ends of leg `index` of the route, when both are on the map. */
function legEnds(p: Ping, contact: ContactRecord, state: SessionState, index: number) {
  const ends = [selfEnd(state), ...relaysOf(p).map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), contactEnd(contact)];
  const a = ends[index];
  const b = ends[index + 1];
  return a && b ? { a, b } : null;
}

interface Action {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Said beside it: what it costs. */
  cost?: string;
}

export function RouteSheet({ tool, onClose }: { tool: RouteTool; onClose: () => void }) {
  const state = useSession();
  const now = useNow();
  const p = usePing(tool.key);
  const d = useDiscovery(tool.key);
  const [signingIn, setSigningIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const contact = state.contacts[tool.key];
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  const nodeOf = (k: string) => state.contacts[k] ?? relayOf(k, state.contacts);
  // The legs of a change the terrain closes, warned of before it is kept.
  const draftEnds = tool.draft ? [selfEnd(state), ...tool.draft.map((k) => { const c = nodeOf(k); return c ? contactEnd(c) : null; }), contact ? contactEnd(contact) : null] : [];
  const draftLegs = draftEnds.slice(1).flatMap((b, i) => {
    const a = draftEnds[i];
    return a && b ? [{ a, b, ha: defaultHeight(a, state.contacts), hb: defaultHeight(b, state.contacts) }] : [];
  });
  const verdicts = useLegVerdicts(draftLegs, radio);

  if (!contact) {
    return (
      <div className="tool">
        <SheetHead title={t("tools.route.title")} sub={t("tools.contactGone")} onBack={onClose} />
      </div>
    );
  }

  const key = contact.key;
  const name = contact.name || contact.prefix;
  const online = state.status === "ready";
  const relaysItself = contact.type === AdvType.Repeater;
  const governed = isConversationType(contact.type);
  const policy = session.routePolicy(key);
  const flooding = governed && policy.flood;
  const held = contactRoute(contact);
  const byHand = session.routeSetByHand(key);
  const expires = session.routeExpiresAt(key);
  // A repeater or a room answers a flood only from a radio signed in to it.
  const needsSignIn = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[key]?.ok;
  const placed = !!contactEnd(contact);
  const editing = tool.draft !== null;

  // A change, as the radio would hold it: hashes the size of the route it holds now.
  const size = held?.[0] ? held[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
  const hashes = (tool.draft ?? []).map((k) => k.slice(0, size * 2));
  const draftPing = tool.draft && p?.via && sameRelays(p.via, tool.draft) ? p : null;
  const heldPing = p && !p.via ? p : null;
  const shownPing = editing ? draftPing : heldPing;
  const running = shownPing?.running ?? false;
  const flooded = d?.running ?? false;
  // The newer of a check and a flood says what it found.
  const shownFlood = !editing && d && (d.running || !heldPing || d.at >= heldPing.at) ? d : null;

  const openLeg = (index: number) => {
    if (!shownPing) return;
    const ends = legEnds(shownPing, contact, state, index);
    if (ends) openLineOfSight(ends.a, ends.b, key, measuredLegs(shownPing)[index] ?? null);
  };

  const flood = () => (needsSignIn ? setSigningIn(true) : void discover(key));
  const save = async () => {
    setSaving(true);
    const ok = await act(() => session.setRoute(key, hashes), t("tools.route.saved"));
    setSaving(false);
    if (!ok) return;
    settlePing(key, hashes);
    // What a flood found was measured against the route this one replaces.
    forgetDiscovery(key);
    setMeshTool({ ...tool, draft: null });
  };

  // ---- what it says about the route ----

  let sub: string;
  if (editing) sub = t("tools.route.notSaved");
  else if (flooding) sub = t("tools.route.everyFloods");
  else if (held === null) sub = relaysItself ? t("tools.route.noneWritten") : governed ? t("tools.route.noneKnown") : t("tools.route.noneKnownRequests");
  else {
    const bits = [byHand ? t("tools.route.byHand") : contact.pathSince ? t("tools.route.learned", { time: agoPhrase(contact.pathSince) }) : null, expires !== null ? t("tools.route.forgotten", { when: inMinutes(expires - now) }) : null].filter(Boolean).join(" · ");
    sub = bits ? bits[0]!.toUpperCase() + bits.slice(1) : held.length === 0 ? t("tools.route.heardDirect") : t("tools.route.keptUntil");
  }

  const relayName = (k: string) => nodeOf(k)?.name || (state.contacts[k] ? k.slice(0, 8) : (nameOfHash(k, state.contacts) ?? k));
  const shownChain = heldPing && !heldPing.running && heldPing.search?.found ? relaysOf(heldPing) : null;
  const chain: string[] | null = editing
    ? tool.draft!.map(relayName)
    : flooding
      ? null
      : shownChain
        ? shownChain.map((h) => nameOfHash(h, state.contacts) ?? h)
        : held
          ? held.map((h) => nameOfHash(h, state.contacts) ?? h)
          : relaysItself && heldPing?.chain.length && !heldPing.search
            ? relaysOf(heldPing).map((h) => nameOfHash(h, state.contacts) ?? h)
            : null;

  // ---- the one button, and a link when one is worth it ----

  let primary: (Action & { plain?: boolean }) | null = null;
  const links: Action[] = [];
  if (editing) {
    const cameBack = !!draftPing && !draftPing.running && draftPing.runs.some((r) => r.ok);
    primary = running
      ? { label: t("tools.stop"), onClick: () => stopPing(key), plain: true }
      : cameBack
        ? { label: t("tools.route.save"), onClick: () => void save(), busy: saving, disabled: !online }
        : { label: t("tools.check"), onClick: () => void ping(key, hashes), disabled: !online || !(relaysItself || hashes.length > 0) };
    if (!running) links.push({ label: t("common.cancel"), onClick: cancelRouteEdit });
  } else if (running) {
    primary = { label: t("tools.stop"), onClick: () => stopPing(key), plain: true };
  } else if (flooded) {
    primary = { label: t("tools.route.askingMesh"), onClick: () => undefined, busy: true };
  } else if (!flooding) {
    // A search that found nothing goes on from where it stopped; the flood is the last resort.
    const gaveUp = !shownFlood && !!heldPing?.search?.done && !heldPing.search.found;
    primary = gaveUp
      ? { label: t("tools.keepLooking"), onClick: () => void keepLooking(key), disabled: !online }
      : { label: held === null && !relaysItself ? t("tools.route.findWay") : t("tools.check"), onClick: () => void ping(key), disabled: !online };
    if (gaveUp) links.push({ label: t("tools.route.askMesh"), onClick: flood, disabled: !online, cost: needsSignIn ? t("tools.route.signInFirst") : t("tools.route.floods") });
  }

  const idle = !running && !shownFlood && !shownPing;
  const hint = editing
    ? t("tools.route.hintEditing")
    : flooding
      ? t("tools.route.hintFlooding")
      : !idle
        ? null
        : placed
          ? t("tools.route.hintDrag")
          : t("tools.route.hintNoPosition", { name });

  const settings = () => {
    const items: MenuItem[] = [
      {
        label: t("tools.route.askMesh"),
        hint: needsSignIn ? t("tools.route.askMeshSignIn") : t("tools.route.askMeshHint"),
        disabled: !online || flooded || running,
        onSelect: flood,
      },
    ];
    if (relaysItself) items.push({ label: t("tools.route.checkFrom"), hint: t("tools.route.checkFromHint"), disabled: !online, onSelect: () => openSpan(key) });
    if (governed) {
      items.push({
        label: flooding ? t("tools.route.useLearned") : t("tools.route.alwaysFlood"),
        hint: flooding ? undefined : t("tools.route.alwaysFloodHint"),
        disabled: !online,
        onSelect: () => void act(() => session.setFloodPinned(key, !flooding), flooding ? t("tools.route.learnedAgain") : t("tools.route.everyToItFloods")),
      });
      if (!flooding) {
        const own = state.routing.contacts[key]?.resetAfterMin;
        items.push({ label: t("tools.route.forgetAfterValue", { value: own === undefined ? t("tools.route.default") : limitLabel(own).toLowerCase() }), onSelect: () => forgetAfter(key, own, state.routing.resetAfterMin) });
      }
    }
    items.push({ label: t("tools.route.forgetNow"), danger: true, disabled: !online || held === null || flooding, onSelect: () => void act(() => session.resetPath(key), t("tools.route.forgottenToast")) });
    showMenu(items, { title: t("tools.route.to", { name }) });
  };

  return (
    <div className="tool route-sheet">
      <SheetHead title={t("tools.route.to", { name })} sub={sub} onBack={onClose} onMore={settings} />
      {chain ? (
        <p className="tool-line chain">
          <span className="muted">{t("tools.you")}</span>
          {chain.map((n, i) => (
            <span key={`${i}:${n}`}>
              <span className="sep">›</span>
              <b>{n}</b>
            </span>
          ))}
          <span className="sep">›</span>
          <span className="muted">{name}</span>
        </p>
      ) : null}
      {editing
        ? draftLegs
            .filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked")
            .map((l) => (
              <p key={legId(l.a, l.b)} className="tool-warn">
                <AlertIcon size={16} />
                {t("tools.route.legBlocked", { from: l.a.name, to: l.b.name })}
              </p>
            ))
        : null}
      {shownFlood ? (
        <SearchResult d={shownFlood} contact={contact} state={state} />
      ) : shownPing ? (
        <CheckResult p={shownPing} names={namesAlong(shownPing, contact, state)} reach={shownPing.targetInChain ? null : relaysOf(shownPing).length ? namesAlong(shownPing, contact, state).at(-2)! : null} placed={placed} onLeg={openLeg} onUndo={() => void act(() => undoFound(key), t("tools.route.putBack"))} />
      ) : null}

      {primary ? (
        <Button variant={primary.plain ? "default" : "primary"} size="lg" busy={primary.busy ?? false} disabled={primary.disabled ?? false} onClick={primary.onClick}>
          {primary.label}
        </Button>
      ) : null}
      {links.length ? (
        <div className="route-links">
          {links.map((l) => (
            <button key={l.label} type="button" className="check-link" disabled={l.disabled} onClick={l.onClick}>
              {l.label}
              {l.cost ? <small>{l.cost}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {hint ? <p className="tool-credit muted">{hint}</p> : null}

      <SignIn
        open={signingIn}
        nodeKey={key}
        onClose={() => setSigningIn(false)}
        onSignedIn={() => {
          setSigningIn(false);
          toast(t("tools.signedIn", { name }));
          void discover(key);
        }}
      />
    </div>
  );
}

export function SheetHead({ title, sub, onBack, onMore, action }: { title: string; sub: ReactNode; onBack: () => void; onMore?: () => void; action?: ReactNode }) {
  return (
    <div className="tool-head">
      <IconButton label={t("common.back")} onClick={onBack}>
        <BackIcon size={18} />
      </IconButton>
      <span className="row-main">
        <span className="row-title">{title}</span>
        <span className="row-sub muted">{sub}</span>
      </span>
      {action}
      {onMore ? (
        <IconButton label={t("tools.route.settings")} onClick={onMore}>
          <MoreIcon size={18} />
        </IconButton>
      ) : null}
    </div>
  );
}

/** How long a learned route to this contact is kept: the default, or its own. */
function forgetAfter(key: string, own: number | null | undefined, fallback: number | null): void {
  const mark = (on: boolean) => <CheckIcon size={17} style={{ visibility: on ? "visible" : "hidden" }} />;
  showMenu(
    [
      { label: t("tools.route.defaultValue", { value: limitLabel(fallback).toLowerCase() }), icon: mark(own === undefined), onSelect: () => session.setRouteReset(key, undefined) },
      ...ROUTE_LIMITS.map((m) => ({ label: limitLabel(m), icon: mark(own === m), onSelect: () => session.setRouteReset(key, m) })),
    ],
    { title: t("tools.route.forgetAfter") },
  );
}

/**
 * What asking the whole mesh came to: the flood on its way, the way it found
 * (drawn on the map with the way back and the route it replaced), or the
 * silence.
 */
function SearchResult({ d, contact, state }: { d: Discovery; contact: ContactRecord; state: SessionState }) {
  if (d.running) {
    const job = state.remote.active?.key === d.key && state.remote.active.label === "path discovery" ? state.remote.active : null;
    const total = job?.until && job.startedAt ? Math.round((job.until - job.startedAt) / 1000) : null;
    return (
      <div className="disc">
        <p className="disc-line">{total ? t("tools.search.flooding", { seconds: total }) : t("tools.search.waiting")}</p>
        {job?.until ? (
          <span className="disc-bar" aria-hidden="true">
            <i key={job.id} style={{ animationDuration: `${job.until - (job.startedAt ?? job.until)}ms` }} />
          </span>
        ) : null}
      </div>
    );
  }
  if (d.found) {
    const f = d.found;
    const flooding = isConversationType(contact.type) && session.routePolicy(contact.key).flood;
    const head = f.out.length === 0 ? t("tools.search.direct") : f.changed ? t("tools.search.found", { count: f.out.length }) : t("tools.search.same");
    return (
      <div className="disc">
        <p className="disc-line">
          <b>{head}</b> · {flooding ? t("tools.search.stillFloods") : f.changed ? t("tools.search.nowRoute") : t("tools.search.stillWorks")}
          {f.changed && !flooding ? (
            <>
              {" · "}
              <button type="button" className="check-link" disabled={state.status !== "ready"} onClick={() => void act(() => undoDiscovery(d.key), t("tools.route.putBack"))}>
                {t("common.undo")}
              </button>
            </>
          ) : null}
        </p>
        {contactEnd(contact) ? (
          <span className="disc-key">
            <span><i className="found" />{t("tools.there")}</span>
            <span><i className="back" />{t("tools.back")}</span>
            {f.changed && d.before ? <span><i className="was" />{t("tools.was")}</span> : null}
          </span>
        ) : null}
      </div>
    );
  }
  if (!d.silent) return <p className="check-note">{d.error}</p>;
  const needsSignIn = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[contact.key]?.ok;
  return (
    <p className="disc-line bad">
      <b>{t("tools.search.noAnswer", { seconds: d.waitedS })}</b> {needsSignIn ? t("tools.search.signedOnly", { name: contact.name || contact.prefix }) : t("tools.search.outOfRange")}
    </p>
  );
}

function Dots({ marks, total, live }: { marks: boolean[]; total: number; live: boolean }) {
  return (
    <span className="dots" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < marks.length ? (marks[i] ? "ok" : "lost") : i === marks.length && live ? "wait" : ""} />
      ))}
    </span>
  );
}

/**
 * What a check came to, in a line or two: how it is getting on while it
 * runs; the time, how many came back and the weakest leg in a word; where it
 * broke and the way round it found, with Undo; or that none was found. A leg
 * named in it opens its line of sight. `names` are the nodes along the way,
 * this radio first; `reach` the last a check can get to, when it stops short
 * of the contact.
 */
export function CheckResult({ p, names, reach, placed, onLeg, onUndo }: { p: Ping; names: string[]; reach: string | null; placed: boolean; onLeg: (index: number) => void; onUndo?: () => void }) {
  const state = useSession();
  if (p.error && !p.running) return <p className="check-note">{p.error}</p>;
  const broke = breakWords(p, state);

  if (p.running) {
    if (p.stage === "locate") {
      return (
        <div className="check-result">
          <Dots marks={p.runs.map((r) => r.ok)} total={ROUNDS} live={false} />
          <span className="muted">{t("tools.check.locating")}</span>
        </div>
      );
    }
    if (p.stage === "search" && p.search) {
      return (
        <>
          {broke ? (
            <p className="disc-line bad">
              <b>{t("tools.check.breaks", { where: broke })}</b>
            </p>
          ) : null}
          <div className="check-result">
            <Dots marks={p.search.tries} total={p.search.total} live />
            <span className="muted">{t(p.broken ? "tools.check.tryingOther" : "tools.check.looking", { n: Math.min(p.search.tries.length + 1, p.search.total), total: p.search.total })}</span>
          </div>
        </>
      );
    }
    const done = p.runs.length;
    return (
      <div className="check-result">
        <Dots marks={p.runs.map((r) => r.ok)} total={ROUNDS} live />
        <span className="muted">{t("tools.check.round", { n: Math.min(done + 1, ROUNDS), total: ROUNDS })}</span>
      </div>
    );
  }

  const weakest = weakestLeg(p);
  const weakRow = (lost: number) =>
    weakest && (weakest.snr < -5 || lost > 0) ? (
      <button type="button" className="check-row warn" onClick={() => onLeg(weakest.index)}>
        <AlertIcon size={18} />
        <span className="grow">
          {t("tools.check.weakest", { a: names[weakest.index] ?? "", b: names[weakest.index + 1] ?? "" })}
          <small>{t("tools.check.weakHint", { snr: formatSnr(weakest.snr) })}</small>
        </span>
        <ChevronRightIcon size={14} className="line-chev" />
      </button>
    ) : null;

  if (p.search) {
    if (p.search.found) {
      const relays = names.length - 2;
      const rtt = p.runs[0]?.rttMs;
      return (
        <>
          <div className="check-result">
            <b className="found-head">{p.broken ? t("tools.check.foundOther") : t("tools.check.found")}</b>
            <span className="muted">{rtt ? t("tools.check.backIn", { via: t("tools.viaRelays", { count: relays }), seconds: (rtt / 1000).toFixed(1) }) : t("tools.viaRelays", { count: relays })}</span>
            {weakest ? <QualityChip snr={weakest.snr} numbers={false} /> : null}
          </div>
          <p className="check-note">
            {p.search.tries.length > 1
              ? p.broken
                ? t("tools.check.onTryBroke", { n: p.search.tries.length, where: broke ?? "" })
                : t("tools.check.onTryRoute", { n: p.search.tries.length })
              : p.broken
                ? t("tools.check.oldBroke", { where: broke ?? "" })
                : t("tools.check.nowRoute")}
            {p.search.before && onUndo ? (
              <>
                {" · "}
                <button type="button" className="check-link" onClick={onUndo}>
                  {t("common.undo")}
                </button>
              </>
            ) : null}
          </p>
          {p.search.back && placed ? (
            <span className="disc-key">
              <span><i className="found" />{t("tools.there")}</span>
              <span><i className="back" />{t("tools.back")}</span>
            </span>
          ) : null}
          {weakRow(0)}
        </>
      );
    }
    const silent = p.search.tries.length;
    return (
      <p className="disc-line bad">
        <b>{t("tools.check.noWay")}</b> {broke ? `${t("tools.check.itBreaks", { where: broke })} ` : ""}
        {silent ? t("tools.check.silentWays", { count: silent }) : broke ? t("tools.check.nothingRound") : t("tools.check.notEnough")}
      </p>
    );
  }

  if (p.broken) {
    return (
      <button type="button" className="check-row bad" onClick={() => onLeg(p.broken!.at)}>
        <AlertIcon size={18} />
        <span className="grow">
          {t("tools.check.noAnswerBreaks", { where: broke ?? "" })}
          <small>{t("tools.check.tapLos")}</small>
        </span>
        <ChevronRightIcon size={14} className="line-chev" />
      </button>
    );
  }

  const done = p.runs.length;
  const good = p.runs.filter((r) => r.ok);
  if (done === 0) return null;
  if (good.length === 0) {
    return (
      <div className="check-result">
        <b className="bad">{t("tools.check.noAnswer")}</b>
        <span className="muted">{reach ? t("tools.check.noneBackFrom", { total: done, name: reach }) : t("tools.check.noneBack", { total: done })}</span>
      </div>
    );
  }
  const avg = good.reduce((s, r) => s + (r.rttMs ?? 0), 0) / good.length;
  return (
    <>
      <div className="check-result">
        <b className="mono">{t("tools.unit.ms", { value: Math.round(avg) })}</b>
        <span className="muted">{reach ? t("tools.check.cameBackReach", { good: good.length, total: done, name: reach }) : t("tools.check.cameBack", { good: good.length, total: done })}</span>
        {weakest ? <QualityChip snr={weakest.snr} numbers={false} /> : null}
      </div>
      {weakRow(done - good.length)}
    </>
  );
}

/** The ends of the legs along a traced chain, this radio first. */
export function chainEnds(chain: string[], state: SessionState, last: LosEnd | null = null): (LosEnd | null)[] {
  return [selfEnd(state), ...chain.map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), ...(last ? [last] : [])];
}
