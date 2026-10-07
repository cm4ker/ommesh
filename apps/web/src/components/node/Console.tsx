import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { ConsoleEntry, ContactRecord } from "@meshnet/meshcore";
import { t } from "../../i18n/index.js";
import { suggest } from "../../lib/cli.js";
import { dayLabel, timeOfDay } from "../../lib/format.js";
import { hasSavedPassword, readPassword } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { errorText } from "../../i18n/errors.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { showMenu, type MenuItem } from "../../ui/Menu.js";
import { CopyIcon, RefreshIcon, SendIcon } from "../Icons.js";
import { SignIn } from "./SignIn.js";

/** Commands that take a node down, move it, or lock people out. */
const DANGEROUS = /^(reboot|clkreboot|erase|start ota|poweroff|shutdown|set radio |set pin |password |set prv\.key|set guest\.password|setperm |set wifi\.(ssid|pwd) )/;

/** When the app started; the console keeps what came before it. */
const STARTED = Date.now();

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * A node's console over the air, or with `own` the connected radio's own (protocol 14):
 * the same log and field, sent straight down the link with nothing to sign in to.
 */
export function Console(props: { contact: ContactRecord } | { own: true }) {
  const state = useSession();
  const contact = "contact" in props ? props.contact : null;
  const key = contact?.key ?? state.self?.key ?? "";
  const name = contact ? contact.name || contact.prefix : (state.self?.name ?? "");
  const entries = state.consoles[key] ?? [];
  const online = state.status === "ready";
  const [draft, setDraft] = useState("");
  // A command to send once the reader agrees; `typed` when it came from the field, which then empties.
  const [confirming, setConfirming] = useState<{ command: string; typed: boolean } | null>(null);
  const [recall, setRecall] = useState<number | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState(false);
  const [relearning, setRelearning] = useState(false);
  const [focused, setFocused] = useState(false);
  // The last command went unanswered: the node may no longer know its way back to us. One kept
  // from before the app started says nothing of the way now.
  const last = entries.at(-1);
  const lost = contact !== null && last?.status === "timeout" && last.at >= STARTED;

  /** A sign-in by flood with the saved password, or the sheet to type one. */
  const relearn = async () => {
    if (!hasSavedPassword(key)) return setAsking(true);
    const password = await readPassword(key);
    if (password === null) return setAsking(true);
    setRelearning(true);
    try {
      const login = await session.relearnReturnPath(key, password);
      toast(login.ok ? t("node.console.relearned", { name }) : t("node.signIn.refused"), login.ok ? "" : "error");
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

  const run = (command: string) => {
    // The entry shows how it went; nothing to add here.
    (contact ? session.runCli(key, command) : session.runOwnCli(command)).catch(() => undefined);
  };

  const send = (command: string) => {
    setDraft("");
    setRecall(null);
    run(command);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const command = draft.trim();
    if (!command) return;
    if (DANGEROUS.test(command)) setConfirming({ command, typed: true });
    else send(command);
  };

  /** A command from the log sent again: asked about as when typed, and the field left as it is. */
  const again = (command: string) => {
    if (DANGEROUS.test(command)) setConfirming({ command, typed: false });
    else run(command);
  };

  /** What can be done with an entry, as in the MeshCore app: copy the command or its answer, or send it again. */
  const menuOf = (entry: ConsoleEntry, e: MouseEvent<HTMLButtonElement>) => {
    // A masked command's text here is not the command, so it is neither copied nor sent.
    const command = entry.command && !entry.command.includes("••") ? entry.command : "";
    const reply = entry.status === "done" ? entry.reply : null;
    const settled = entry.status !== "queued" && entry.status !== "waiting";
    const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => toast(t("common.copied")));
    const items: (MenuItem | null)[] = [
      command ? { label: t("node.console.copyCommand"), icon: <CopyIcon size={17} />, onSelect: () => copy(command) } : null,
      reply ? { label: t("node.console.copyReply"), icon: <CopyIcon size={17} />, onSelect: () => copy(reply) } : null,
      command && settled ? { label: t("node.console.sendAgain"), icon: <RefreshIcon size={17} />, air: true, group: true, disabled: !online, onSelect: () => again(command) } : null,
    ];
    // A click or a right click puts the menu where it was; Enter on the row, under the row.
    const row = e.currentTarget.getBoundingClientRect();
    const at = e.detail > 0 || e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : { x: row.left, y: row.bottom };
    showMenu(
      items.filter((x): x is MenuItem => x !== null),
      { title: command || undefined, at },
    );
  };

  const typed = draft.trim();
  const { chips, hint } = suggest(draft, contact ? "node" : "radio");

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
        {entries.map((entry, i) => (
          <Fragment key={entry.id}>
            {/* The console is kept from one day to the next: each day opens with its date, as in a chat. */}
            {i === 0 || !sameDay(entries[i - 1]!.at, entry.at) ? <div className="day">{dayLabel(entry.at / 1000)}</div> : null}
            <Entry entry={entry} onRetry={() => again(entry.command)} onMenu={(e) => menuOf(entry, e)} />
          </Fragment>
        ))}
        {lost ? (
          <div className="c-wayback">
            <span className="muted small">{t("node.console.wayBack")}</span>
            <Button size="sm" busy={relearning} disabled={!online || relearning} onClick={() => void relearn()}>
              {t("node.console.relearn")}
            </Button>
          </div>
        ) : null}
      </div>
      {/* The same frame as a chat's composer, so a command is written the way a message is. */}
      <form className={["compose", "console-compose", focused ? "focus" : "", draft ? "has" : "", online ? "" : "waiting"].join(" ")} onSubmit={submit}>
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
        <div className="compose-box">
          <div className="compose-row">
            <div className="compose-field">
              <input
                ref={input}
                aria-label={t("node.console.command")}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="send"
                placeholder={online ? undefined : t("node.console.disconnected")}
                value={draft}
                disabled={!online}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              />
            </div>
            <button
              type="submit"
              className={["compose-send", online && typed ? "ready" : "idle"].join(" ")}
              aria-label={t("common.send")}
              disabled={!online || !typed}
              onMouseDown={(e) => e.preventDefault()}
            >
              <SendIcon size={18} />
            </button>
          </div>
        </div>
      </form>
      {contact ? (
        <SignIn
          open={asking}
          nodeKey={key}
          relearn
          onClose={() => setAsking(false)}
          onSignedIn={() => {
            setAsking(false);
            toast(t("node.console.relearned", { name }));
          }}
        />
      ) : null}
      <Confirm
        open={confirming !== null}
        title={t("node.console.sendTitle", { command: confirming?.command ?? "" })}
        body={
          <p>
            {confirming?.command.startsWith("set radio")
              ? t(contact ? "node.console.radioWarn" : "radio.console.radioWarn")
              : confirming?.command.startsWith("password") || confirming?.command.startsWith("set guest.password")
                ? t("node.console.passwordWarn")
                : t("node.console.actsAtOnce", { name })}
          </p>
        }
        confirmLabel={t("common.send")}
        danger
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const { command, typed } = confirming!;
          setConfirming(null);
          if (typed) send(command);
          else run(command);
        }}
      />
    </>
  );
}

function Entry({ entry, onRetry, onMenu }: { entry: ConsoleEntry; onRetry: () => void; onMenu: (e: MouseEvent<HTMLButtonElement>) => void }) {
  // The head is a button when its menu has something in it: a command that is not masked, or an answer.
  const menu = (entry.command !== "" && !entry.command.includes("••")) || (entry.status === "done" && !!entry.reply);
  const head = entry.command ? (
    <>
      <span className="c-prompt">›</span>
      <span>{entry.command}</span>
      <span className="c-tag" title={t("node.console.tag")}>
        {entry.tag}|
      </span>
      <span className="c-time">{timeOfDay(entry.at / 1000)}</span>
    </>
  ) : (
    <>
      <span className="c-prompt">‹</span>
      <span>{t("node.console.unasked")}</span>
      <span className="c-time">{timeOfDay(entry.at / 1000)}</span>
    </>
  );
  return (
    <div className="c-entry">
      {menu ? (
        <button
          type="button"
          className={["c-cmd", entry.command ? "" : "muted"].join(" ")}
          onClick={onMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(e);
          }}
        >
          {head}
        </button>
      ) : (
        <div className={["c-cmd", entry.command ? "" : "muted"].join(" ")}>{head}</div>
      )}
      {entry.status === "queued" ? (
        <div className="c-out c-wait">{t("node.console.queued")}</div>
      ) : entry.status === "waiting" ? (
        <div className="c-out c-wait">
          <span className="spinner" aria-hidden="true" /> {t("node.console.waiting")}
        </div>
      ) : entry.status === "timeout" ? (
        <div className="c-out c-err">
          {t("node.console.noReply")}
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
        <div className="c-out c-err">{entry.error}</div>
      ) : (
        <div className="c-out">{entry.reply}</div>
      )}
    </div>
  );
}
