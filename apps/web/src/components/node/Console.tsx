import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConsoleEntry, ContactRecord } from "@meshnet/meshcore";
import { t } from "../../i18n/index.js";
import { suggest } from "../../lib/cli.js";
import { timeOfDay } from "../../lib/format.js";
import { hasSavedPassword, readPassword } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { errorText } from "../../i18n/errors.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { SignIn } from "./SignIn.js";

/** Commands that take a node down, move it, or lock people out. */
const DANGEROUS = /^(reboot|clkreboot|erase|start ota|poweroff|shutdown|set radio |password |set prv\.key|set guest\.password|setperm |set wifi\.(ssid|pwd) )/;

export function Console({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const entries = state.consoles[key] ?? [];
  const online = state.status === "ready";
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [recall, setRecall] = useState<number | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState(false);
  const [relearning, setRelearning] = useState(false);
  // The last command the node never answered: the node may no longer know its way back to us.
  const lost = [...entries].reverse().find((e) => e.status === "timeout" && !e.wayBack)?.id ?? null;
  const lastLost = entries.at(-1)?.id === lost;

  /** A sign-in by flood with the saved password, or the sheet to type one. */
  const relearn = async () => {
    if (!hasSavedPassword(key)) return setAsking(true);
    const password = await readPassword(key);
    if (password === null) return setAsking(true);
    setRelearning(true);
    try {
      const login = await session.relearnReturnPath(key, password);
      toast(login.ok ? t("node.console.relearned", { name: contact.name || contact.prefix }) : t("node.signIn.refused"), login.ok ? "" : "error");
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setRelearning(false);
    }
  };

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, entries[entries.length - 1]?.status]);

  const send = (command: string) => {
    setDraft("");
    setRecall(null);
    // The entry shows how it went; nothing to add here.
    session.runCli(key, command).catch(() => undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const command = draft.trim();
    if (!command) return;
    if (DANGEROUS.test(command)) setConfirming(command);
    else send(command);
  };

  const typed = draft.trim();
  const { chips, hint } = suggest(draft);

  const past = entries.filter((e) => e.command && !e.command.includes("••")).map((e) => e.command);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Tab takes the first suggestion, as a shell would.
    if (e.key === "Tab" && typed && chips[0]) {
      e.preventDefault();
      setDraft(chips[0].fill);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (past.length === 0) return;
    e.preventDefault();
    const at = recall ?? past.length;
    const next = Math.max(0, Math.min(past.length, at + (e.key === "ArrowUp" ? -1 : 1)));
    setRecall(next === past.length ? null : next);
    setDraft(next === past.length ? "" : past[next]!);
  };

  return (
    <>
      <div className="console" ref={log} aria-live="polite">
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} onRetry={() => send(entry.command)} />
        ))}
        {lost && lastLost ? (
          <div className="c-wayback">
            <span className="muted small">{t("node.console.wayBack")}</span>
            <Button size="sm" busy={relearning} disabled={!online || relearning} onClick={() => void relearn()}>
              {t("node.console.relearn")}
            </Button>
          </div>
        ) : null}
      </div>
      <form className="composer console-composer" onSubmit={submit}>
        <div className="chips console-chips">
          {chips.map((s) => (
            <button
              key={s.fill}
              type="button"
              className="chip mono"
              onClick={() => {
                setDraft(s.fill);
                input.current?.focus();
              }}
            >
              {s.label}
            </button>
          ))}
          {entries.length > 0 ? (
            <button type="button" className="chip" onClick={() => session.clearConsole(key)}>
              {t("common.clear")}
            </button>
          ) : null}
        </div>
        {hint ? <span className="console-hint mono">{hint}</span> : null}
        <div className="composer-row">
          <span className="prompt" aria-hidden="true">
            ›
          </span>
          <input
            ref={input}
            className="input mono"
            aria-label={t("node.console.command")}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={online ? t("node.console.placeholder") : t("node.console.disconnected")}
            value={draft}
            disabled={!online}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <Button type="submit" variant="primary" disabled={!online || !typed}>
            {t("common.send")}
          </Button>
        </div>
      </form>
      <SignIn
        open={asking}
        nodeKey={key}
        relearn
        onClose={() => setAsking(false)}
        onSignedIn={() => {
          setAsking(false);
          toast(t("node.console.relearned", { name: contact.name || contact.prefix }));
        }}
      />
      <Confirm
        open={confirming !== null}
        title={t("node.console.sendTitle", { command: confirming ?? "" })}
        body={
          <p>
            {confirming?.startsWith("set radio")
              ? t("node.console.radioWarn")
              : confirming?.startsWith("password") || confirming?.startsWith("set guest.password")
                ? t("node.console.passwordWarn")
                : t("node.console.actsAtOnce", { name: contact.name })}
          </p>
        }
        confirmLabel={t("common.send")}
        danger
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const command = confirming!;
          setConfirming(null);
          send(command);
        }}
      />
    </>
  );
}

function Entry({ entry, onRetry }: { entry: ConsoleEntry; onRetry: () => void }) {
  return (
    <div className="c-entry">
      {entry.command ? (
        <div className="c-cmd">
          <span className="c-prompt">›</span>
          <span>{entry.command}</span>
          <span className="c-tag" title={t("node.console.tag")}>
            {entry.tag}|
          </span>
          <span className="c-time">{timeOfDay(entry.at / 1000)}</span>
        </div>
      ) : (
        <div className="c-cmd muted">
          <span className="c-prompt">‹</span>
          <span>{t("node.console.unasked")}</span>
          <span className="c-time">{timeOfDay(entry.at / 1000)}</span>
        </div>
      )}
      {entry.status === "queued" ? (
        <div className="c-out c-wait">{t("node.console.queued")}</div>
      ) : entry.status === "waiting" ? (
        <div className="c-out c-wait">
          <span className="spinner" aria-hidden="true" />{" "}
          {entry.check === "checking"
            ? t("node.console.checking", { command: readBack(entry.command) })
            : entry.wayBack === "renewing"
              ? t("node.console.renewing")
              : entry.attempt && entry.attempt > 1 && entry.attempts
                ? t("node.console.try", { n: entry.attempt, of: entry.attempts })
                : t("node.console.waiting")}
        </div>
      ) : entry.status === "timeout" ? (
        <div className="c-out c-err">
          {entry.wayBack === "unreachable"
            ? t("node.console.unreachable")
            : entry.attempt && entry.attempt > 1
              ? t("node.console.noReplyTries", { count: entry.attempt })
              : t("node.console.noReply")}
          {/* A masked command cannot be sent again: its text here is not the command. */}
          {entry.command.includes("••") ? null : (
            <>
              {" · "}
              <button type="button" className="link" onClick={onRetry}>
                {t("node.console.sendAgain")}
              </button>
            </>
          )}
        </div>
      ) : entry.status === "failed" ? (
        <div className="c-out c-err">
          {entry.check === "differs" ? t("node.console.differs", { command: readBack(entry.command), value: entry.reply ?? "" }) : entry.error}
        </div>
      ) : (
        <>
          <div className="c-out">{entry.reply}</div>
          {entry.check === "applied" ? (
            <div className="c-note c-good">{t("node.console.applied", { command: readBack(entry.command) })}</div>
          ) : entry.wayBack === "renewed" ? (
            <div className="c-note">{t("node.console.afterRenew")}</div>
          ) : entry.attempt && entry.attempt > 1 ? (
            <div className="c-note">{t("node.console.answeredOnTry", { n: entry.attempt })}</div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The `get` a `set` is read back with. */
function readBack(command: string): string {
  const name = /^set\s+(\S+)/i.exec(command.trim())?.[1];
  return name ? `get ${name}` : command;
}
