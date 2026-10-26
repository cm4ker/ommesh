/**
 * The route to a contact, in a sheet over the map: how the next message goes,
 * as one of four ways to pick. Automatic lets the radio learn the way from
 * what comes back, and forgets it on the time limit; Direct goes with no
 * relays; My own way goes through the relays picked here; Always flood sends
 * everything to the whole mesh. A way picked is kept at once. My own way opens
 * the chain to change, by its relays or the + before its end, which picks one
 * from a list and so reaches repeaters with no place on the map, or by
 * dragging a point or tapping repeaters on the map; the button checks a change
 * and then saves it. A route set by hand is never forgotten on a timer.
 *
 * Checking the route is the ping beside its row (RoutePing.tsx); everywhere
 * else a route is one row that opens this.
 */

import { AdvType, contactRoute, isConversationType, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { nameOfHash } from "../../lib/echoes.js";
import { agoPhrase } from "../../lib/format.js";
import { buildGraph, SELF } from "../../lib/linkGraph.js";
import { linkBook } from "../../lib/links.js";
import { legId, useLegVerdicts } from "../../lib/legVerdicts.js";
import { formatSnr, quality, qualityWord, type LinkRadio } from "../../lib/los.js";
import { contactEnd, defaultHeight, relayOf, sameRelays, selfEnd } from "../../lib/mapOverlay.js";
import { setMeshTool, type LosEnd, type RouteTool } from "../../lib/meshTool.js";
import { heardAt } from "../../lib/nodes.js";
import { measuredLegs, ping, ROUNDS, settlePing, stopPing, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { relayChoices, type RelayChoice } from "../../lib/relayPick.js";
import { inMinutes, useNow } from "../../lib/routes.js";
import { session, useSession } from "../../lib/session.js";
import { act } from "../../lib/toast.js";
import { cancelRouteEdit, editRoute, forgetRoute, openLineOfSight } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { SearchField } from "../../ui/Field.js";
import { Block, Group } from "../../ui/List.js";
import { showMenu } from "../../ui/Menu.js";
import { Sheet } from "../../ui/Sheet.js";
import { AlertIcon, BackIcon, CheckIcon, ChevronRightIcon, CloseIcon, MoreIcon, PingIcon, PlusIcon, RefreshIcon, SaveIcon, StopIcon } from "../Icons.js";

export function QualityChip({ snr, numbers = true }: { snr: number; numbers?: boolean }) {
  const q = quality(snr);
  return (
    <span className={`quality ${q}`}>
      {qualityWord(q)}
      {numbers ? <small>{t("tools.unit.db", { value: formatSnr(snr) })}</small> : null}
    </span>
  );
}

/** The relays a ping went through, and the contact when it passes nothing on. */
export function relaysOf(p: Ping): string[] {
  return p.targetInChain ? p.chain.slice(0, -1) : p.chain;
}

/** Each node along the route, this radio first, by name where the hash names one contact other than the end. */
export function namesAlong(p: Ping, contact: ContactRecord, state: SessionState): string[] {
  return [t("tools.you"), ...relaysOf(p).map((h) => nameOfHash(h, state.contacts, contact.key) ?? h), contact.name || contact.prefix];
}

/** Where along a chain it broke: after the node before the leg, or at the first hop. */
export function breakWords(p: Ping, state: SessionState): string | null {
  if (!p.broken) return null;
  const { chain, at } = p.broken;
  return at === 0 ? t("tools.break.first") : t("tools.break.after", { name: nameOfHash(chain[at - 1]!, state.contacts) ?? chain[at - 1]! });
}

/** The two ends of leg `index` of the route, when both are on the map. */
export function legEnds(p: Ping, contact: ContactRecord, state: SessionState, index: number) {
  const ends = [selfEnd(state), ...relaysOf(p).map((h) => { const r = relayOf(h, state.contacts, contact.key); return r ? contactEnd(r) : null; }), contactEnd(contact)];
  const a = ends[index];
  const b = ends[index + 1];
  return a && b ? { a, b } : null;
}

type Mode = "auto" | "direct" | "own" | "flood";

export function RouteSheet({ tool, onClose }: { tool: RouteTool; onClose: () => void }) {
  const state = useSession();
  const now = useNow();
  const p = usePing(tool.key);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null);
  const contact = state.contacts[tool.key];
  const self = state.self;
  const radio: LinkRadio | null = self ? { frequencyKhz: self.frequencyKhz, bandwidthHz: self.bandwidthHz, spreadingFactor: self.spreadingFactor, codingRate: self.codingRate, txPowerDbm: self.txPower } : null;
  // The legs of a change the terrain closes, warned of before it is kept.
  const relayNode = (k: string) => state.contacts[k] ?? relayOf(k, state.contacts, tool.key);
  const draftEnds = tool.draft ? [selfEnd(state), ...tool.draft.map((k) => { const c = relayNode(k); return c ? contactEnd(c) : null; }), contact ? contactEnd(contact) : null] : [];
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
  // Messages go to a chat or a room, requests to every other node; the words follow which.
  const messaged = isConversationType(contact.type);
  const flooding = session.routePolicy(key).flood;
  const held = contactRoute(contact);
  const byHand = session.routeSetByHand(key);
  const expires = session.routeExpiresAt(key);
  const editing = tool.draft !== null;
  const mode: Mode = flooding ? "flood" : byHand && held !== null ? (held.length === 0 ? "direct" : "own") : "auto";
  const shownMode: Mode = editing ? "own" : mode;

  // A change, as the radio would hold it: hashes the size of the route it holds now.
  const size = held?.[0] ? held[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
  const hashes = (tool.draft ?? []).map((k) => k.slice(0, size * 2));
  const draftPing = tool.draft && p?.via && sameRelays(p.via, tool.draft) ? p : null;
  const running = draftPing?.running ?? false;
  const nodeOf = (k: string) => state.contacts[k] ?? relayOf(k, state.contacts, key);

  const openLeg = (index: number) => {
    if (!draftPing) return;
    const ends = legEnds(draftPing, contact, state, index);
    if (ends) openLineOfSight(ends.a, ends.b, key, measuredLegs(draftPing)[index] ?? null);
  };

  const save = async () => {
    setSaving(true);
    const ok = await act(() => session.setRoute(key, hashes), t("tools.route.saved"));
    setSaving(false);
    if (!ok) return;
    settlePing(key, hashes);
    setMeshTool({ ...tool, draft: null });
  };

  // The relays the chain shows, as contact keys where a hash names one for sure: a change starts from them.
  const hops = (editing ? tool.draft! : (held ?? [])).map((h) => (state.contacts[h] ? h : (relayOf(h, state.contacts, key)?.key ?? h)));
  const hopName = (k: string) => {
    const c = nodeOf(k);
    return c ? c.name || c.prefix : k;
  };
  const change = (next: string[]) => editRoute(key, next);
  const hopMenu = (i: number) =>
    showMenu(
      [
        { label: t("tools.route.hop.replace"), onSelect: () => setPicking({ mode: "replace", index: i }) },
        { label: t("tools.route.hop.before"), onSelect: () => setPicking({ mode: "before", index: i }) },
        { label: t("tools.route.hop.remove"), danger: true, onSelect: () => change(hops.filter((_, j) => j !== i)) },
      ],
      { title: hopName(hops[i]!) },
    );
  const picked = (k: string) => {
    if (!picking) return;
    const next = [...hops];
    if (picking.mode === "replace") next[picking.index] = k;
    else next.splice(picking.index, 0, k);
    setPicking(null);
    change(next);
  };

  // ---- a way picked is kept at once; my own way opens the chain to change and save ----

  const pick = (next: Mode) => {
    if (next === shownMode) return;
    if (editing && next !== "own") cancelRouteEdit();
    if (next === "auto") void act(() => session.useLearnedRoutes(key), t("tools.route.autoAgain"));
    else if (next === "direct")
      void act(() => session.setRoute(key, []), t("tools.route.setDirectDone")).then((ok) => {
        if (ok) settlePing(key, []);
      });
    else if (next === "flood") void act(() => session.setFloodPinned(key, true), messaged ? t("tools.route.everyToItFloods") : t("tools.route.everyRequestToItFloods"));
    else change(hops);
  };

  // What the radio holds now, said under Automatic.
  const learned = (() => {
    if (held === null) return messaged ? t("tools.route.nowUnknown") : t("tools.route.nowUnknownRequests");
    const route = held.length === 0 ? t("tools.routeWords.direct") : t("tools.viaRelays", { count: held.length });
    const said = contact.pathSince ? t("tools.route.now", { route, time: agoPhrase(contact.pathSince) }) : t("tools.route.nowRoute", { route });
    return expires !== null ? `${said} · ${t("tools.route.forgotten", { when: inMinutes(expires - now) })}` : said;
  })();

  const chain = (
    <p className="tool-line chain">
      <span className="muted">{t("tools.you")}</span>
      {hops.map((k, i) => {
        const c = nodeOf(k);
        return (
          <span key={`${i}:${k}`}>
            <span className="sep">›</span>
            <button type="button" className="chain-hop" disabled={running} onClick={() => hopMenu(i)}>
              {hopName(k)}
              {c && contactEnd(c) ? null : <i className="chain-off" title={t("tools.route.offMap")} aria-label={t("tools.route.offMap")} />}
            </button>
          </span>
        );
      })}
      <span>
        <span className="sep">›</span>
        <button type="button" className="chain-add" disabled={running} aria-label={t("tools.route.addRelay")} title={t("tools.route.addRelay")} onClick={() => setPicking({ mode: "before", index: hops.length })}>
          <PlusIcon size={14} />
        </button>
      </span>
      <span>
        <span className="sep">›</span>
        <span className="muted">{name}</span>
      </span>
    </p>
  );

  // A check is a trace, which only repeaters pass on: with no relays to anything but a repeater there is nothing
  // to check, and the change is saved as it is.
  const cameBack = !!draftPing && !draftPing.running && draftPing.runs.some((r) => r.ok);
  const nothingToCheck = hashes.length === 0 && !relaysItself;
  const own = editing ? (
    <>
      {chain}
      {draftLegs
        .filter((l) => verdicts.get(legId(l.a, l.b)) === "blocked")
        .map((l) => (
          <p key={legId(l.a, l.b)} className="tool-warn">
            <AlertIcon size={16} />
            {t("tools.route.legBlocked", { from: l.a.name, to: l.b.name })}
          </p>
        ))}
      {draftPing ? <CheckResult p={draftPing} names={namesAlong(draftPing, contact, state)} reach={draftPing.targetInChain ? null : relaysOf(draftPing).length ? namesAlong(draftPing, contact, state).at(-2)! : null} placed={!!contactEnd(contact)} onLeg={openLeg} /> : null}
      <p className="tool-credit muted">{t("tools.route.hintEditing")}</p>
    </>
  ) : (
    chain
  );

  // What a way picked can do, as small buttons on its own line: find the route again, or check, save and drop a change.
  const ownActs = editing ? (
    running ? (
      <IconAct label={t("tools.stop")} onClick={() => stopPing(key)}>
        <StopIcon size={16} />
      </IconAct>
    ) : (
      <>
        {nothingToCheck ? null : (
          <IconAct label={t("tools.check")} primary={!cameBack} disabled={!online} onClick={() => void ping(key, hashes)}>
            <PingIcon size={16} />
          </IconAct>
        )}
        <IconAct label={t("tools.route.save")} primary={cameBack || nothingToCheck} busy={saving} disabled={!online} onClick={() => void save()}>
          <SaveIcon size={16} />
        </IconAct>
        <IconAct label={t("common.cancel")} onClick={cancelRouteEdit}>
          <CloseIcon size={16} />
        </IconAct>
      </>
    )
  ) : null;

  const modes: { mode: Mode; label: string; hint: string; acts?: ReactNode; more?: ReactNode }[] = [
    {
      mode: "auto",
      label: t("tools.route.mode.auto"),
      hint: shownMode === "auto" ? learned : t("tools.route.mode.autoHint"),
      acts:
        shownMode === "auto" && held !== null ? (
          <IconAct label={t("tools.route.findAgain")} disabled={!online} onClick={() => void forgetRoute(key)}>
            <RefreshIcon size={16} />
          </IconAct>
        ) : null,
    },
    { mode: "direct", label: t("tools.route.mode.direct"), hint: t("tools.route.mode.directHint") },
    { mode: "own", label: t("tools.route.mode.own"), hint: t("tools.route.mode.ownHint"), acts: shownMode === "own" ? ownActs : null, more: shownMode === "own" ? own : null },
    { mode: "flood", label: t("tools.route.alwaysFlood"), hint: messaged ? t("tools.route.mode.floodHint") : t("tools.route.mode.floodRequestsHint") },
  ];

  return (
    <div className="tool route-sheet">
      <SheetHead title={t("tools.route.to", { name })} sub={editing ? t("tools.route.notSaved") : null} onBack={onClose} />
      <Group>
        {modes.map((m) => (
          <Fragment key={m.mode}>
            <ModeRow label={m.label} hint={m.mode === shownMode && m.mode === "own" ? undefined : m.hint} checked={m.mode === shownMode} disabled={!online || running} onPick={() => pick(m.mode)} acts={m.acts} />
            {m.more ? <Block className="route-mode-more">{m.more}</Block> : null}
          </Fragment>
        ))}
      </Group>
      <RelayPicker picking={picking} hops={hops} hopName={hopName} target={contact} size={size} onPick={picked} onClose={() => setPicking(null)} />
    </div>
  );
}

/**
 * One of the route's ways: a radio as wide as the row, with what the way
 * picked can do as small buttons on the line of its name, before the check
 * mark, and what it says under them. The buttons sit over the radio, so a
 * tap on them does not pick the way again.
 */
function ModeRow({ label, hint, checked, disabled, onPick, acts }: { label: string; hint: string | undefined; checked: boolean; disabled: boolean; onPick: () => void; acts?: ReactNode }) {
  const id = useId();
  return (
    <div className={["line", "route-choice", checked ? "on" : ""].join(" ")}>
      <button type="button" role="radio" aria-checked={checked} aria-label={label} aria-describedby={hint ? id : undefined} className="route-choice-pick" disabled={disabled} onClick={onPick} />
      <span className="route-choice-label" aria-hidden="true">
        {label}
      </span>
      {acts ? <span className="route-choice-acts">{acts}</span> : null}
      <CheckIcon size={16} className="line-check" />
      {hint ? (
        <small id={id} className="route-choice-hint">
          {hint}
        </small>
      ) : null}
    </div>
  );
}

/** A small framed button with an icon alone, its name in its tooltip and for a screen reader. */
function IconAct({ label, primary = false, busy = false, disabled = false, onClick, children }: { label: string; primary?: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" variant={primary ? "primary" : "default"} className="icon-only" aria-label={label} title={label} busy={busy} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

/** Where a relay picked from the list goes: in place of relay `index`, or in before it (at the end, before the contact). */
interface Picking {
  mode: "replace" | "before";
  index: number;
}

/**
 * The repeaters to pick the next relay from, those heard next to the one
 * before it first (lib/relayPick.ts), with a field to find one by name or
 * hash. A repeater that shares no position is as easy to pick as any.
 */
function RelayPicker({ picking, hops, hopName, target, size, onPick, onClose }: { picking: Picking | null; hops: string[]; hopName: (k: string) => string; target: ContactRecord; size: number; onPick: (key: string) => void; onClose: () => void }) {
  const state = useSession();
  const [query, setQuery] = useState("");
  const open = picking !== null;
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  // The book is read as the list opens; what is heard while it is open waits for the next time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = useMemo(() => (open ? buildGraph(linkBook(), state, Date.now()) : null), [open]);
  const index = picking?.index ?? 0;
  const prev = index === 0 ? SELF : hops[index - 1]!;
  const choices = useMemo(() => (graph ? relayChoices(state, graph, { prev, target: target.key, taken: hops, query, size }) : { near: [], rest: [] }), [graph, state, prev, target.key, hops, query, size]);
  const prevName = prev === SELF ? null : hopName(prev);
  const title = !picking
    ? ""
    : picking.mode === "replace"
      ? t("tools.route.pick.instead", { name: hopName(hops[index]!) })
      : index < hops.length
        ? t("tools.route.pick.before", { name: hopName(hops[index]!) })
        : prevName
          ? t("tools.route.pick.after", { name: prevName })
          : t("tools.route.pick.afterYou");
  const targetName = target.name || target.prefix;
  const row = (c: RelayChoice) => {
    const bits: ReactNode[] = [];
    if (c.nearEnd) bits.push(<span key="end" className="pick-near">{t("tools.route.pick.nearEnd", { name: targetName })}</span>);
    if (!c.placed) bits.push(t("tools.route.offMap"));
    if (c.contact && heardAt(c.contact) > 0) bits.push(t("tools.route.pick.heard", { time: agoPhrase(heardAt(c.contact)) }));
    return (
      <li key={c.key}>
        <button type="button" className="row" onClick={() => onPick(c.key)}>
          <span className="row-main">
            <span className="row-title">{c.contact ? c.contact.name || c.contact.prefix : t("tools.route.pick.unknown")}</span>
            <span className="row-sub muted">{bits.flatMap((b, i) => (i ? [" · ", b] : [b]))}</span>
          </span>
          <span className="pick-hash mono muted">{c.key.slice(0, size * 2)}</span>
        </button>
      </li>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title={title} find={<SearchField value={query} onValue={setQuery} placeholder={t("tools.route.pick.find")} aria-label={t("tools.route.pick.find")} />}>
      {choices.near.length ? (
        <>
          <div className="group-title">{prevName ? t("tools.route.pick.near", { name: prevName }) : t("tools.route.pick.nearYou")}</div>
          <ul className="list" role="list">
            {choices.near.map(row)}
          </ul>
        </>
      ) : null}
      {choices.rest.length ? (
        <>
          {choices.near.length ? <div className="group-title">{t("tools.route.pick.rest")}</div> : null}
          <ul className="list" role="list">
            {choices.rest.map(row)}
          </ul>
        </>
      ) : null}
      {choices.near.length + choices.rest.length === 0 ? <p className="group-note">{query ? t("tools.route.pick.noneNamed") : t("tools.route.pick.none")}</p> : null}
    </Sheet>
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
        {sub ? <span className="row-sub muted">{sub}</span> : null}
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

export function Dots({ marks, total, live }: { marks: boolean[]; total: number; live: boolean }) {
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
