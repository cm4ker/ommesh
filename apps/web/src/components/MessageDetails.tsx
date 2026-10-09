import { Fragment, useState, type ReactNode } from "react";
import type { ContactRecord, MessageEcho, MessageRecord } from "@meshnet/meshcore";
import { candidatesOfHash, spreadOf } from "../lib/echoes.js";
import { ago, utf8Length } from "../lib/format.js";
import { quality } from "../lib/los.js";
import { openProfile } from "../lib/nav.js";
import { heardAt } from "../lib/nodes.js";
import { session, useSession } from "../lib/session.js";
import { ReactionNames } from "./Reactions.js";
import { locale, t } from "../i18n/index.js";
import { tx } from "../i18n/rich.js";

/**
 * What is known of how a message travelled, shown under its bubble once it is
 * tapped. `peer` names the other end: the contact, or a channel message's
 * sender. Each thing takes one line: who heard it and how loud, and how far
 * it went; the chains of relays open on a tap. `clockOff` says the chat shows
 * when it came, the sender's stamp being off.
 */
export function MessageDetails({ message, peer, clockOff = false }: { message: MessageRecord; peer: string; clockOff?: boolean }) {
  const { contacts } = useSession();
  const [pick, setPick] = useState<string | null>(null);
  const out = message.direction === "out";
  const channel = message.conversation.startsWith("ch:");
  const chain = (from: string, hashes: string[], to: string) => <HopChain from={from} hashes={hashes} to={to} contacts={contacts} pick={pick} onPick={setPick} />;
  const relay = (hash: string) => <Relay hash={hash} contacts={contacts} pick={pick} onPick={setPick} />;

  let body: ReactNode = null;
  if (out && channel) {
    body = message.echoes.some((e) => e.path.length > 0) ? <Spread echoes={message.echoes} relay={relay} /> : <Unheard message={message} />;
  } else if (out) {
    if (message.flood) {
      body = message.route ? (
        <>
          <span className="details-lead">{t("chats.details.floodedRoute")}</span>
          {chain(t("chats.details.you"), message.route, peer)}
        </>
      ) : (
        <span>
          {t("chats.details.floodedNoRoute")} {message.status === "delivered" ? t("chats.details.noRouteBack") : t("chats.details.routeComesBack")}
        </span>
      );
    } else if (message.route) {
      body = (
        <>
          <span className="details-label">{t("chats.details.sentAlong")}</span>
          {chain(t("chats.details.you"), message.route, peer)}
        </>
      );
    }
  } else if (message.echoes.length > 0) {
    body = <Arrived echoes={message.echoes} relay={relay} />;
  } else if (message.hops === null) {
    body = (
      <>
        <span className="details-lead">{t("chats.details.directRoute")}</span>
        <span>{t("chats.details.directRouteWhy")}</span>
      </>
    );
  } else {
    body = (
      <>
        <span className="details-lead">{t("chats.details.routeUnknown")}</span>
        <span>{t("chats.details.hopCountOnly", { hops: message.hops })}</span>
      </>
    );
  }

  const bytes = t("chats.details.bytes", { count: utf8Length(message.text) });
  const facts = out
    ? [
        message.original ? `${bytes} · ${t("chats.details.lookalikes", { count: utf8Length(message.original) })}` : bytes,
        message.roundTripMs ? t("chats.details.ackIn", { seconds: (message.roundTripMs / 1000).toFixed(1) }) : null,
        message.attempt > 0 ? t("chats.details.attempts", { count: message.attempt + 1 }) : null,
      ]
    : [
        // A stamp on another day than it came, as a radio that lost its clock gives, carries its date.
        sameDay(message.timestamp * 1000, message.receivedAt)
          ? t("chats.details.sentAt", { time: clock(message.timestamp * 1000) })
          : t("chats.details.sentOnDay", { time: dateAndClock(message.timestamp * 1000) }),
        t("chats.details.receivedAt", { time: clock(message.receivedAt) }),
        clockOff ? t("chats.details.clockOff") : null,
        bytes,
      ];

  const candidates = pick ? candidatesOfHash(pick, contacts) : [];
  return (
    <div className="msg-details" onClick={(e) => e.stopPropagation()}>
      {body}
      {candidates.length > 1 ? (
        <div className="cands">
          <span>{tx("chats.details.couldBe", { hash: <b>{pick}</b>, count: candidates.length })}</span>
          {candidates.map((c) => (
            <button key={c.key} type="button" className="link" onClick={() => openProfile(c.key)}>
              {t("chats.details.candidate", { name: c.name || c.prefix, time: ago(heardAt(c) || null) })}
            </button>
          ))}
        </div>
      ) : null}
      <ReactionNames message={message} />
      <span className="details-meta">{facts.filter(Boolean).join(" · ")}</span>
    </div>
  );
}

/** How loud a copy was here, coloured by the same words as a route's legs. */
function Snr({ snr }: { snr: number | null }) {
  if (snr === null) return <span className="heard-snr none">—</span>;
  return (
    <span className={`heard-snr ${quality(snr)}`}>
      {snr > 0 ? "+" : ""}
      {snr.toFixed(1)} <small>{t("chats.details.db")}</small>
    </span>
  );
}

/**
 * Ours on a channel, as the copies heard back tell it: the repeaters that
 * heard it from us, each with how loud its copy was here, and in one line how
 * many carried it further and how far; that line opens the chains.
 */
function Spread({ echoes, relay }: { echoes: MessageEcho[]; relay: (hash: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const spread = spreadOf(echoes);
  const n = spread.first.length;
  const more = spread.further.length;
  return (
    <>
      <span className="heard-head">
        {t("chats.details.heardYou")} <span className="muted">· {t("chats.details.repeaters", { count: n })}</span>
      </span>
      <div className="heard-rows">
        {spread.first.map((f) => (
          <div className="heard-row" key={f.hash}>
            <span className="heard-name">{relay(f.hash)}</span>
            <Snr snr={f.snr} />
          </div>
        ))}
      </div>
      {more > 0 ? (
        <>
          <button type="button" className="heard-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t("chats.details.wentOn", { count: more })}
            <span className="muted">
              {" "}
              · {t("chats.details.hopsOut", { count: spread.farthest })} {open ? "▴" : "›"}
            </span>
          </button>
          {open
            ? spread.chains.map((c, i) => (
                <span className="heard-chain" key={i}>
                  {c.map((hash, j) => (
                    <Fragment key={j}>
                      {j > 0 ? <span className="sep"> › </span> : null}
                      {relay(hash)}
                    </Fragment>
                  ))}
                </span>
              ))
            : null}
        </>
      ) : null}
    </>
  );
}

/** Someone else's message: the way the copy it was read from came, in one line, and the other copies behind a tap. */
function Arrived({ echoes, relay }: { echoes: MessageEcho[]; relay: (hash: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = (echo: MessageEcho) =>
    echo.path.length === 0 ? (
      <span className="muted">{t("chats.details.heardDirect")}</span>
    ) : (
      echo.path.map((hash, j) => (
        <Fragment key={j}>
          {j > 0 ? <span className="sep"> › </span> : null}
          {relay(hash)}
        </Fragment>
      ))
    );
  const [first, ...rest] = echoes;
  return (
    <>
      <div className="heard-row">
        <span className="heard-name wrap">
          <span className="muted">{first!.path.length ? `${t("chats.details.cameVia")} ` : ""}</span>
          {path(first!)}
        </span>
        <Snr snr={first!.snr} />
      </div>
      {rest.length > 0 ? (
        <>
          <button type="button" className="heard-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t("chats.details.moreCopies", { count: rest.length })} <span className="muted">{open ? "▴" : "›"}</span>
          </button>
          {open ? (
            <div className="heard-rows">
              {rest.map((echo, i) => (
                <div className="heard-row" key={i}>
                  <span className="heard-name wrap">{path(echo)}</span>
                  <Snr snr={echo.snr} />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** A relay by name: its contact opens on a tap, and a hash several contacts share lists them. */
function Relay({ hash, contacts, pick, onPick }: { hash: string; contacts: Record<string, ContactRecord>; pick: string | null; onPick: (hash: string | null) => void }) {
  const matches = candidatesOfHash(hash, contacts);
  if (matches.length === 1) {
    return (
      <button type="button" className="relay" onClick={() => openProfile(matches[0]!.key)}>
        {matches[0]!.name || matches[0]!.prefix}
      </button>
    );
  }
  if (matches.length > 1) {
    return (
      <button type="button" className={["relay amb", pick === hash ? "on" : ""].join(" ")} title={t("chats.details.shareHash", { count: matches.length })} onClick={() => onPick(pick === hash ? null : hash)}>
        <span className="hop-hash">{hash}</span>?
      </button>
    );
  }
  return (
    <span className="relay unknown" title={t("chats.details.noHash")}>
      <span className="hop-hash">{hash}</span>
    </span>
  );
}

/**
 * Ours on a channel with no echo yet. Worded around the repeaters only: a node
 * in direct range hears the message and sends nothing back, so silence is not
 * a miss.
 */
function Unheard({ message }: { message: MessageRecord }) {
  const plan = message.retryPlan;
  if (plan && plan.made < plan.total) {
    return (
      <>
        <span className="details-lead">{t("chats.details.tryingAgain", { made: plan.made, total: plan.total })}</span>
        <span>{plan.nextAt === null ? t("chats.details.waitingRadio") : t("chats.details.stopsAtFirst")}</span>
      </>
    );
  }
  if (message.status === "unheard") {
    return (
      <>
        <span className="details-lead">{plan ? t("chats.details.triesNone", { count: plan.total }) : t("chats.details.noRepeater20")}</span>
        <span>{t("chats.details.mayHaveIt")}</span>
      </>
    );
  }
  // Too long for any copy of it to reach the app: nobody can be seen sending it on (#84).
  if (!session.canHearRelays(message)) return <span>{t("chats.details.tooLongToHear")}</span>;
  return <span>{t("chats.details.noRepeater")}</span>;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dateAndClock(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** A route as a chain of chips: named relays open their contact, a hash several contacts share lists them. */
function HopChain({
  from,
  hashes,
  to,
  contacts,
  pick,
  onPick,
}: {
  from: string;
  hashes: string[];
  to: string;
  contacts: Record<string, ContactRecord>;
  pick: string | null;
  onPick: (hash: string | null) => void;
}) {
  return (
    <span className="hops">
      <span className="hop end">{from}</span>
      {hashes.map((hash, i) => {
        const matches = candidatesOfHash(hash, contacts);
        return (
          <Fragment key={i}>
            <span className="sep">›</span>
            {matches.length === 1 ? (
              <button type="button" className="hop" title={t("chats.details.openContact")} onClick={() => openProfile(matches[0]!.key)}>
                {matches[0]!.name} <span className="hop-hash">{hash}</span>
              </button>
            ) : matches.length > 1 ? (
              <button type="button" className={["hop amb", pick === hash ? "on" : ""].join(" ")} title={t("chats.details.shareHash", { count: matches.length })} onClick={() => onPick(pick === hash ? null : hash)}>
                <span className="hop-hash">{hash}</span>?
              </button>
            ) : (
              <span className="hop" title={t("chats.details.noHash")}>
                <span className="hop-hash">{hash}</span>
              </span>
            )}
          </Fragment>
        );
      })}
      <span className="sep">›</span>
      <span className="hop end">{to}</span>
    </span>
  );
}
