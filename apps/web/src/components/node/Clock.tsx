import { useState } from "react";
import { ClockAheadError, NodeCommandError, type ContactRecord } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t } from "../../i18n/index.js";
import { agoPhrase, fullDate, span } from "../../lib/format.js";
import { isAdmin, nodeClock, type NodeClock } from "../../lib/nodes.js";
import { session, useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { Confirm } from "../../ui/Dialog.js";
import { ActionRow, Group, InfoRow, LinkRow } from "../../ui/List.js";
import { Sheet } from "../../ui/Sheet.js";
import { AlertIcon, CheckIcon, ClockIcon } from "../Icons.js";

/** A node's clock this far off ours is worth setting. */
const DRIFT_WORTH_FIXING_S = 30;

/**
 * Where the node's clock stands. The sign-in's word stays "in sync" when close, since it may be
 * hours old; a reading since gives the seconds. A clock a day or more off says its date instead.
 */
function ClockPill({ clock, checking }: { clock: NodeClock; checking: boolean }) {
  if (checking)
    return (
      <span className="pill">
        <span className="spinner" aria-hidden="true" />
        {t("node.status.checking")}
      </span>
    );
  const shows = fullDate(clock.at / 1000 - clock.drift);
  const off = Math.abs(clock.drift) > DRIFT_WORTH_FIXING_S;
  const text =
    clock.from === "reset"
      ? t("node.status.resetTo", { date: shows })
      : Math.abs(clock.drift) >= 86_400
        ? t("node.status.shows", { date: shows })
        : !off && clock.from === "login"
          ? t("node.status.inSync")
          : Math.abs(clock.drift) <= 1
            ? t("node.status.onTime")
            : t(clock.drift > 0 ? "node.status.behind" : "node.status.ahead", { span: span(clock.drift) });
  return (
    <span className={off ? "pill warn" : "pill ok"}>
      {off ? <AlertIcon size={11} /> : <CheckIcon size={11} />}
      {text}
    </span>
  );
}

function clockHint(clock: NodeClock): string {
  const time = agoPhrase(clock.at);
  if (clock.from === "reset") return t("node.status.clockResetAgo", { time });
  if (clock.from === "reply") return t("node.status.clockChecked", { time });
  return t("node.clock.fromSignIn", { time });
}

/**
 * A node's clock, first in its Manage group: how it stands, at a glance. The sign-in brings the
 * first reading, so the row is there as soon as someone is signed in. An admin's tap opens what
 * reads it again and sets it; a guest has no console, so only the sign-in says.
 */
export function ClockRow({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const name = contact.name || contact.prefix;
  const online = state.status === "ready";
  const login = state.logins[key];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"check" | "set" | "reset" | null>(null);
  const [askReset, setAskReset] = useState(false);
  const clock = nodeClock(login);
  if (!clock) return null;
  const off = Math.abs(clock.drift) > DRIFT_WORTH_FIXING_S;

  // Each clock command is one send on a tap. The node stamps its reply with its clock, which
  // moves the reading in the session, so the sheet redraws from there and says nothing more.
  const check = async () => {
    setBusy("check");
    try {
      await session.checkNodeClock(key);
    } catch (e) {
      toast(e instanceof NodeCommandError ? t("node.nodeSaid", { reply: e.reply }) : errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  // The node answers `clock sync` whatever it did, so its reply decides what is said. It takes
  // only a time later than its clock when the command lands, seconds after we stamped it, so a
  // clock already right refuses as well as one that runs ahead. The refusal is stamped with the
  // node's clock, and that reading tells the two apart. Ahead, the sheet has turned Set into the
  // reset that brings it back, which says why; nothing more is said over it.
  const sync = async () => {
    setBusy("set");
    try {
      await session.syncNodeClock(key);
      toast(t("node.status.clockSet"));
    } catch (e) {
      const now = e instanceof ClockAheadError ? nodeClock(session.getState().logins[key]) : null;
      if (now && Math.abs(now.drift) <= DRIFT_WORTH_FIXING_S) toast(t("node.status.clockRight"));
      else if (!now || now.drift > 0) toast(e instanceof NodeCommandError ? t("node.nodeSaid", { reply: e.reply }) : errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setAskReset(false);
    setBusy("reset");
    try {
      await session.resetNodeClock(key);
      toast(t("node.status.clockReset", { name }), "", undefined, t("node.status.clockResetDetail"));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!isAdmin(login))
    return (
      <InfoRow icon={<ClockIcon size={17} />} label={t("node.status.clock")} hint={clockHint(clock)}>
        <ClockPill clock={clock} checking={false} />
      </InfoRow>
    );
  return (
    <>
      <LinkRow icon={<ClockIcon size={17} />} label={t("node.status.clock")} value={<ClockPill clock={clock} checking={busy === "check"} />} onClick={() => setOpen(true)} />
      <Confirm
        open={askReset}
        title={t("node.status.resetTitle", { name })}
        body={
          <>
            {clock.drift < 0 ? <p>{t("node.status.resetLead", { span: span(clock.drift) })}</p> : null}
            <p>{t("node.status.resetBody")}</p>
            {clock.drift < 0 ? <p>{t("node.status.resetAdverts", { span: span(clock.drift) })}</p> : null}
          </>
        }
        confirmLabel={t("node.status.resetConfirm")}
        danger
        onCancel={() => setAskReset(false)}
        onConfirm={() => void reset()}
      />
      <Sheet open={open} onClose={() => setOpen(false)} title={t("node.clock.title", { name })}>
        <Group note={t("node.clock.note")}>
          <InfoRow label={t("node.status.clock")} hint={clockHint(clock)}>
            <ClockPill clock={clock} checking={busy === "check"} />
          </InfoRow>
        </Group>
        <Group>
          {off ? (
            // Behind, our time sets it. Ahead, it will not go back, and only the reset does.
            clock.drift < 0 ? (
              <ActionRow
                label={t("node.status.resetClock")}
                hint={t("node.status.resetClockHint")}
                air
                danger
                busy={busy === "reset"}
                disabled={!online || busy !== null}
                onClick={() => {
                  setOpen(false);
                  setAskReset(true);
                }}
              />
            ) : (
              <ActionRow label={t("node.status.setClock")} air busy={busy === "set"} disabled={!online || busy !== null} onClick={() => void sync()} />
            )
          ) : null}
          <ActionRow label={t("node.clock.check")} air busy={busy === "check"} disabled={!online || busy !== null} onClick={() => void check()} />
        </Group>
      </Sheet>
    </>
  );
}
