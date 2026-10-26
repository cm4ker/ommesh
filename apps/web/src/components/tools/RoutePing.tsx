/**
 * A node's route as one row, with a ping beside it. The row says how the
 * next message goes, in a word or two, and opens the route's settings; the
 * ping sends one trace a tap and says what came back right under the row,
 * where the next taps add to it.
 *
 * A finger held on the ping brings the other ways up over it: slid onto one
 * and let go, the ping goes that way, as Telegram's send button does; let go
 * where it is, the ways stay for a tap. A mouse holds it the same way, and a
 * right click brings the ways up to click. The way picked holds while the
 * page is open. Two pings lost in a row offer the way round, and another way,
 * in the answer itself, so nobody has to know about the hold to get there.
 */

import { AdvType, contactHops, contactRoute, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back.js";
import { discover, undoDiscovery, useDiscovery, type Discovery } from "../../lib/discovery.js";
import { nameOfHash } from "../../lib/echoes.js";
import { haptic } from "../../lib/haptic.js";
import { contactEnd } from "../../lib/mapOverlay.js";
import { directKey, findWayRound, keepLooking, measuredLegs, pingOnce, settleDirect, undoFound, usePing, weakestLeg, type Ping } from "../../lib/ping.js";
import { lostInARow, newestWay, routeShort, tookText, wayChoices, type PingWay, type WayChoice } from "../../lib/pingWays.js";
import { forgetWay, pingByMessage, setWay, useMessagePing, useWay, type MessagePing } from "../../lib/quickPing.js";
import { session, useSession } from "../../lib/session.js";
import { act } from "../../lib/toast.js";
import { openLineOfSight, openRoute } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { CheckIcon, ChevronRightIcon, DirectIcon, NodesIcon, PingIcon, SearchIcon, SendIcon } from "../Icons.js";
import { CheckResult, Dots, legEnds, namesAlong, QualityChip, relaysOf } from "./RouteSheet.js";

/** How long a finger holds the ping before the ways come up, ms; shorter than a row's menu, as the ping is held on purpose. */
const HOLD_MS = 350;
/** How far a finger may wander before a hold counts as a scroll, px. */
const SLOP_PX = 8;

export function RouteRow({ contactKey }: { contactKey: string }) {
  const state = useSession();
  const way = useWay(contactKey);
  const routePing = usePing(contactKey);
  const directPing = usePing(directKey(contactKey));
  const flood = useDiscovery(contactKey);
  const message = useMessagePing(contactKey);
  const [card, setCard] = useState<{ held: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; held: boolean; x: number; y: number }>({ timer: null, held: false, x: 0, y: 0 });
  // The page closed: the next time it opens, a tap goes along the route again.
  useEffect(() => () => forgetWay(contactKey), [contactKey]);
  useEffect(() => () => {
    if (hold.current.timer) clearTimeout(hold.current.timer);
  }, []);

  const contact = state.contacts[contactKey];
  if (!contact) return null;
  const key = contact.key;
  const online = state.status === "ready";
  const flooding = session.routePolicy(key).flood;
  const held = flooding ? null : contactRoute(contact);
  const relayNames = held ? held.map((h) => nameOfHash(h, state.contacts, key) ?? h) : null;
  const choices = wayChoices(contact, relayNames, !!state.logins[key]?.ok);
  const open = (w: PingWay) => online && choices.some((c) => c.way === w && !c.disabled);
  const shown = routePing && !routePing.via ? routePing : null;
  const short = routeShort(contactHops(contact), flooding);
  const busy = !!shown?.running || !!directPing?.running || !!flood?.running || !!message?.running;

  const go = (w: PingWay) => {
    if (!online || busy) return;
    setWay(key, w);
    if (w === "route") void pingOnce(key);
    else if (w === "direct") void pingOnce(key, true);
    else if (w === "flood") void discover(key);
    else void pingByMessage(key);
  };

  const stopHold = () => {
    const h = hold.current;
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
  };
  const press = {
    onPointerDown: (e: ReactPointerEvent) => {
      // A mouse holds with its main button; the right one opens the ways from onContextMenu.
      if (!online || (e.pointerType === "mouse" && e.button !== 0)) return;
      const h = hold.current;
      stopHold();
      h.held = false;
      h.x = e.clientX;
      h.y = e.clientY;
      h.timer = setTimeout(() => {
        h.timer = null;
        h.held = true;
        haptic();
        setCard({ held: true });
      }, HOLD_MS);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const h = hold.current;
      if (h.timer && Math.hypot(e.clientX - h.x, e.clientY - h.y) > SLOP_PX) stopHold();
    },
    onPointerUp: stopHold,
    onPointerCancel: stopHold,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      // A finger's long press is timed above; Android sends this for it too.
      if ((e.nativeEvent as unknown as { pointerType?: string }).pointerType === "touch" || hold.current.held || !online) return;
      setCard({ held: false });
    },
    onClick: () => {
      // The tap that ends a hold is not a ping.
      if (hold.current.held) {
        hold.current.held = false;
        return;
      }
      go(way);
    },
  };

  return (
    <>
      <div className="route-row">
        <button type="button" className="line line-link route-row-link" onClick={() => openRoute(key)}>
          {/* Beside the word where the row has room, under it where it has not, as in the desktop's side panel. */}
          <span className="line-text">
            <span>{t("tools.route.title")}</span>
            <small className="route-row-under">{short}</small>
          </span>
          <span className="line-value route-row-beside">{short}</span>
          <ChevronRightIcon size={14} className="line-chev" />
        </button>
        <button
          ref={button}
          type="button"
          className={["ping-button", card ? "held" : ""].join(" ")}
          aria-label={t("tools.quick.ping")}
          aria-haspopup="menu"
          title={t("tools.quick.ping")}
          disabled={!online}
          {...press}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : <PingIcon size={20} />}
        </button>
      </div>
      <PingAnswer contact={contact} state={state} route={shown} direct={directPing} flood={flood} message={message} open={open} go={go} />
      {card && button.current ? (
        <WaysCard
          anchor={button.current}
          choices={choices.map((c) => ({ ...c, disabled: c.disabled || busy }))}
          current={way}
          held={card.held}
          onPick={(w) => {
            setCard(null);
            go(w);
          }}
          onClose={() => setCard(null)}
        />
      ) : null}
    </>
  );
}

interface Act {
  label: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * What the last ping came to, under the route: the newest of the four ways
 * asked. A row of pings along one way shows as dots, with the time of the
 * last and a word for its weakest leg. A check that went on to find where
 * the route breaks shows as checks do.
 */
function PingAnswer({ contact, state, route, direct, flood, message, open, go }: { contact: ContactRecord; state: SessionState; route: Ping | null; direct: Ping | null; flood: Discovery | null; message: MessagePing | null; open: (w: PingWay) => boolean; go: (w: PingWay) => void }) {
  const key = contact.key;
  const online = state.status === "ready";
  const newest = newestWay({ route: route?.at ?? null, direct: direct?.at ?? null, flood: flood?.at ?? null, message: message?.at ?? null });
  if (!newest) return null;
  const acts: Act[] = [];
  const offer = (w: PingWay, label: string, icon: ReactNode) => {
    if (open(w)) acts.push({ label, icon, run: () => go(w) });
  };
  let dots: { marks: boolean[]; live: boolean } | null = null;
  let text: string;
  let tone: "" | "muted" | "bad" = "";
  let chip: ReactNode = null;
  let note: string | null = null;

  if (newest === "route" || newest === "direct") {
    const p = (newest === "direct" ? direct : route)!;
    if (!p.quick) return <FullCheck p={p} contact={contact} state={state} open={open} go={go} />;
    const isDirect = newest === "direct";
    const last = p.chain.at(-1);
    const upTo = !isDirect && !p.targetInChain && last ? (nameOfHash(last, state.contacts, key) ?? last) : null;
    const runs = p.runs.map((r) => r.ok);
    dots = runs.length || p.running ? { marks: runs, live: p.running } : null;
    const lastRun = p.runs.at(-1);
    if (p.why === "noWay") {
      text = t("tools.quick.noWay");
      tone = "muted";
      acts.push({ label: t("tools.quick.findWay"), icon: <SearchIcon size={16} />, run: () => void findWayRound(key) });
      offer("flood", t("tools.quick.way.flood"), <NodesIcon size={16} />);
    } else if (p.why === "nothingBetween") {
      text = t("tools.quick.nothingBetween");
      tone = "muted";
      offer("message", t("tools.quick.way.message"), <SendIcon size={16} />);
    } else if (p.error) {
      text = p.error;
      tone = "bad";
    } else if (p.running) {
      text = isDirect ? t("tools.quick.waitingDirect") : upTo ? t("tools.quick.waitingUpTo", { name: upTo }) : t("tools.quick.waiting");
      tone = "muted";
    } else if (lastRun?.ok) {
      const time = tookText(lastRun.rttMs ?? 0);
      text = isDirect ? t("tools.quick.direct", { time }) : upTo ? t("tools.quick.upTo", { name: upTo, time }) : time;
      const weakest = weakestLeg(p);
      chip = weakest ? <QualityChip snr={weakest.snr} numbers={false} /> : null;
      // Heard with nothing between, while the route goes through relays: it can go straight.
      if (isDirect && (contactHops(contact) ?? 0) > 0 && !session.routePolicy(key).flood) {
        acts.push({
          label: t("tools.direct.keep"),
          icon: <DirectIcon size={16} />,
          run: () =>
            void act(() => session.setRoute(key, []), t("tools.route.saved")).then((ok) => {
              if (ok) settleDirect(key);
            }),
        });
      }
    } else {
      const lost = lostInARow(p.runs);
      text = isDirect ? t("tools.quick.directSilent") : upTo ? t("tools.quick.upToNoAnswer", { name: upTo }) : lost > 1 ? t("tools.quick.noAnswerRow", { count: lost }) : t("tools.quick.noAnswer");
      tone = "bad";
      if (!isDirect && lost > 1) {
        acts.push({ label: t("tools.quick.findWayRound"), icon: <SearchIcon size={16} />, run: () => void findWayRound(key) });
        if (contact.type === AdvType.Repeater) offer("direct", t("tools.quick.way.direct"), <DirectIcon size={16} />);
        else offer("message", t("tools.quick.way.message"), <SendIcon size={16} />);
      }
    }
  } else if (newest === "flood") {
    const d = flood!;
    if (d.running) {
      text = t("tools.quick.waitingFlood");
      tone = "muted";
    } else if (d.found) {
      const f = d.found;
      const how = !f.changed ? t("tools.quick.floodSame") : f.kept ? t("tools.quick.floodNew") : t("tools.quick.floodKept");
      text = `${t("tools.quick.flood", { time: tookText(d.tookMs ?? 0) })} · ${how}`;
      if (f.changed && f.kept) acts.push({ label: t("common.undo"), icon: null, run: () => void act(() => undoDiscovery(key), t("tools.route.putBack")) });
    } else if (d.silent) {
      text = t("tools.quick.floodSilent");
      tone = "bad";
      const name = contact.name || contact.prefix;
      const signedOut = (contact.type === AdvType.Repeater || contact.type === AdvType.Room) && !state.logins[key]?.ok;
      note = signedOut ? t("tools.search.signedOnly", { name }) : contact.type === AdvType.Chat ? t("tools.search.readingsOnly", { name }) : t("tools.search.outOfRange");
      offer("message", t("tools.quick.way.message"), <SendIcon size={16} />);
    } else {
      text = d.error ?? t("tools.quick.floodSilent");
      tone = "bad";
    }
  } else {
    const m = message!;
    if (m.running) {
      text = m.tryNo && m.tries ? t("tools.quick.waitingMessageTry", { n: m.tryNo, total: m.tries }) : t("tools.quick.waitingMessage");
      tone = "muted";
    } else if (m.ok) {
      text = t("tools.quick.message", { time: tookText(m.ms ?? 0) });
      chip = <span className="quality good">{t("tools.quick.arrived")}</span>;
    } else {
      text = m.error ?? t("tools.quick.messageLost");
      tone = "bad";
    }
  }

  return (
    <div className="ping-answer" aria-live="polite">
      <div className="ping-answer-line">
        {dots ? <Dots marks={dots.marks} total={dots.marks.length + (dots.live ? 1 : 0)} live={dots.live} /> : null}
        <span className={["ping-answer-text", tone].join(" ")}>{text}</span>
        {chip}
      </div>
      {note ? <p className="ping-answer-note">{note}</p> : null}
      {acts.length ? (
        <div className="ping-answer-acts">
          {acts.map((a) => (
            <Button key={a.label} size="sm" disabled={!online} onClick={a.run}>
              {a.icon}
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A ping that went on to find where the route breaks, and a way round: told
 * as a check tells it, with "Keep looking" and the whole mesh once it has
 * given up.
 */
function FullCheck({ p, contact, state, open, go }: { p: Ping; contact: ContactRecord; state: SessionState; open: (w: PingWay) => boolean; go: (w: PingWay) => void }) {
  const key = contact.key;
  const online = state.status === "ready";
  const names = namesAlong(p, contact, state);
  const gaveUp = !p.running && !!p.search?.done && !p.search.found;
  const onLeg = (index: number) => {
    const ends = legEnds(p, contact, state, index);
    if (ends) openLineOfSight(ends.a, ends.b, key, measuredLegs(p)[index] ?? null);
  };
  return (
    <div className="ping-answer full" aria-live="polite">
      <CheckResult
        p={p}
        names={names}
        reach={p.targetInChain ? null : relaysOf(p).length ? names.at(-2)! : null}
        placed={!!contactEnd(contact)}
        onLeg={onLeg}
        onUndo={() => void act(() => undoFound(key), t("tools.route.putBack"))}
      />
      {gaveUp ? (
        <div className="ping-answer-acts">
          <Button size="sm" disabled={!online} onClick={() => void keepLooking(key)}>
            <SearchIcon size={16} />
            {t("tools.keepLooking")}
          </Button>
          {open("flood") ? (
            <Button size="sm" onClick={() => go("flood")}>
              <NodesIcon size={16} />
              {t("tools.quick.way.flood")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The ways to ping, over the finger that held the ping. While that finger is
 * down the way under it lights, and letting go there picks it; let go
 * anywhere else, the card stays for a tap, and a tap past it puts it away.
 */
function WaysCard({ anchor, choices, current, held, onPick, onClose }: { anchor: HTMLElement; choices: WayChoice[]; current: PingWay; held: boolean; onPick: (w: PingWay) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const finger = useRef(held);
  const [lit, setLit] = useState<PingWay | null>(null);
  const [place, setPlace] = useState<{ right: number; top: number } | null>(null);
  useBackLayer(true, onClose);

  // Over the ping, its right edge with the ping's; under it when there is no room above.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const height = el.offsetHeight;
    const right = Math.max(8, window.innerWidth - r.right);
    const above = r.top - 10 - height;
    setPlace({ right, top: above >= 8 ? above : Math.min(window.innerHeight - height - 8, r.bottom + 10) });
  }, [anchor]);
  // Brought up by a right click or the menu key, the ways take the keyboard, starting at the way in use.
  useEffect(() => {
    if (!place || held) return;
    const items = box.current;
    (items?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? items?.querySelector<HTMLElement>("[data-way]:not(:disabled)"))?.focus();
  }, [place, held]);

  const latest = useRef({ choices, onPick, onClose });
  latest.current = { choices, onPick, onClose };
  useEffect(() => {
    const under = (x: number, y: number): WayChoice | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-way]");
      const c = el ? latest.current.choices.find((w) => w.way === el.dataset.way) : undefined;
      return c && !c.disabled ? c : null;
    };
    const move = (e: PointerEvent) => {
      if (finger.current) setLit(under(e.clientX, e.clientY)?.way ?? null);
    };
    const up = (e: PointerEvent) => {
      if (!finger.current) return;
      finger.current = false;
      setLit(null);
      const c = under(e.clientX, e.clientY);
      if (c) latest.current.onPick(c.way);
    };
    const cancel = () => {
      finger.current = false;
      setLit(null);
    };
    // While the finger slides over the ways, the sheet under them neither scrolls nor moves.
    const touch = (e: TouchEvent) => {
      if (!finger.current) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onClose();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("touchmove", touch, { capture: true, passive: false });
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("touchmove", touch, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  return createPortal(
    <>
      <div
        className="ways-scrim"
        aria-hidden="true"
        onPointerDown={() => {
          if (!finger.current) onClose();
        }}
      />
      <div ref={box} className="ways-card" role="menu" aria-label={t("tools.quick.how")} style={place ? { right: place.right, top: place.top } : { visibility: "hidden" }}>
        {choices.map((c) => (
          <button
            key={c.way}
            type="button"
            role="menuitemradio"
            aria-checked={c.way === current}
            data-way={c.way}
            className={["ways-item", lit === c.way ? "lit" : ""].join(" ")}
            disabled={c.disabled}
            onClick={() => onPick(c.way)}
          >
            <span className="ways-check">{c.way === current ? <CheckIcon size={16} /> : null}</span>
            <span className="ways-text">
              <span>{c.label}</span>
              <small>{c.hint}</small>
            </span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}
