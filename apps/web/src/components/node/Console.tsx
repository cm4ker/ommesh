import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { AdvType, isMeshCoreRsVersion, type ConsoleEntry, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../../i18n/index.js";
import { stepHistory, stepPick, suggest, type CliContext } from "../../lib/cli.js";
import { dayLabel, timeOfDay } from "../../lib/format.js";
import { useWide } from "../../lib/layout.js";
import { usePress } from "../../lib/press.js";
import { hasSavedPassword, readPassword } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { toast } from "../../lib/toast.js";
import { errorText } from "../../i18n/errors.js";
import { Button, IconButton } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { SearchField } from "../../ui/Field.js";
import { showMenu, type MenuItem } from "../../ui/Menu.js";
import { Sheet } from "../../ui/Sheet.js";
import { CloseIcon, CopyIcon, HelpIcon, RefreshIcon, SendIcon, TrashIcon } from "../Icons.js";
import { CommandList } from "./CommandHelp.js";
import { SignIn } from "./SignIn.js";

/** Commands that take a node down, move it, or lock people out. */
const DANGEROUS = /^(reboot|clkreboot|erase|start ota|fw (update|install|rollback|wifi|ble)\b|poweroff|shutdown|set radio |set pin |password |set prv\.key|set guest\.password|setperm |set wifi\.(ssid|pwd) |set fw\.(root|owner) |set room )/;

/** When the app started; the console keeps what came before it. */
const STARTED = Date.now();

/** What the field offers at once; the rest waits in the reference. */
const PICK_ROWS = 4;

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * A node's console over the air, or with `own` the connected radio's own (protocol 14):
 * the same log and field, sent straight down the link with nothing to sign in to.
 */
export function Console(props: { contact: ContactRecord } | { own: true }) {
  const state = useSession();
  const wide = useWide();
  const contact = "contact" in props ? props.contact : null;
  const key = contact?.key ?? state.self?.key ?? "";
  const name = contact ? contact.name || contact.prefix : (state.self?.name ?? "");
  const entries = state.consoles[key] ?? [];
  const online = state.status === "ready";
  const [draft, setDraft] = useState("");
  // A command to send once the reader agrees; `typed` when it came from the field, which then empties.
  const [confirming, setConfirming] = useState<{ command: string; typed: boolean } | null>(null);
  const [recall, setRecall] = useState<number | null>(null);
  const [saved, setSaved] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const picks = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Holds off an implicit form submit from the same Enter keypress that just filled a chosen suggestion.
  const holdSubmit = useRef(false);
  const [asking, setAsking] = useState(false);
  const [relearning, setRelearning] = useState(false);
  const [focused, setFocused] = useState(false);
  // The reference of what can be typed: a sheet on a phone, a panel beside the console on a wide screen.
  const [helping, setHelping] = useState(false);
  const [query, setQuery] = useState("");
  const [holding, setHolding] = useState(false);
  // The last command went unanswered: the node may no longer know its way back to us. One kept
  // from before the app started says nothing of the way now.
  const last = entries.at(-1);
  const lost = contact !== null && last?.status === "timeout" && last.at >= STARTED;
  // A person's radio (MeshCore 1.18) answers only those it lets control it, and there is no sign-in to find a way back with.
  const person = contact?.type === AdvType.Chat;
  const target = contact && !person ? "node" : "radio";
  const cliCtx: CliContext =
    contact === null
      ? { mcrs: state.mcrs, isRs: isMeshCoreRsVersion(state.device?.firmwareVersion) }
      : !person
        ? { mcrs: state.nodeMcrs[key] ?? null, isRs: isMeshCoreRsVersion(state.ownerInfo[key]?.firmware) }
        : {};

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

  const applyDraft = (text: string) => {
    setDraft(text);
    setPicked(null);
    setRecall(null);
    setSaved("");
    setDismissed(false);
  };

  const send = (command: string) => {
    applyDraft("");
    run(command);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (holdSubmit.current) {
      holdSubmit.current = false;
      return;
    }
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

  /** A command from the reference: the field takes it, and the reference makes room for the console again. */
  const pick = (command: string) => {
    applyDraft(command);
    setHelping(false);
    // The sheet goes first, then the field: a phone keeps the keyboard down while the sheet is up.
    setTimeout(() => input.current?.focus(), 80);
  };

  const openHelp = () => {
    setQuery("");
    setHelping(true);
  };

  // Held, the button offers what else can be done with the console; tapped, it opens the reference.
  const helpPress = usePress(
    (at) =>
      showMenu(
        [
          { label: t("cli.title"), icon: <HelpIcon size={17} />, onSelect: openHelp },
          { label: t("cli.clearHistory"), icon: <TrashIcon size={17} />, group: true, onSelect: () => session.clearConsole(key) },
        ],
        { at },
      ),
    setHolding,
  );

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
  const { chips, hint, total } = suggest(draft, target, 12, cliCtx);
  // While walking sent history or after Escape, keep suggestions out of the way until the reader edits the field.
  const shown = typed && recall === null && !dismissed ? chips.slice(0, PICK_ROWS) : [];
  const activePick = picked !== null && picked < shown.length ? picked : null;
  const activeHint = activePick !== null ? (shown[activePick]?.about ? (shown[activePick]?.hint ?? null) : hint) : hint;
  const showPick = Boolean(typed && recall === null && !dismissed && (shown.length > 0 || activeHint));

  useEffect(() => {
    if (activePick === null) return;
    picks.current?.querySelector<HTMLElement>(".on")?.scrollIntoView({ block: "nearest" });
  }, [activePick]);

  const past = entries.filter((e) => e.command && !e.command.includes("••")).map((e) => e.command);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && e.repeat && holdSubmit.current) {
      e.preventDefault();
      return;
    }
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (plain && shown.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPicked(stepPick(activePick, shown.length, e.key));
        return;
      }
      // Tab takes the chosen suggestion, or the first one, as a shell would.
      if (e.key === "Tab") {
        e.preventDefault();
        applyDraft(shown[activePick ?? 0]!.fill);
        return;
      }
      // Enter takes a row the arrows have chosen; otherwise the form submits what is typed.
      if (e.key === "Enter" && activePick !== null) {
        e.preventDefault();
        holdSubmit.current = true;
        applyDraft(shown[activePick]!.fill);
        return;
      }
    }
    if (plain && e.key === "Escape" && (activePick !== null || showPick)) {
      e.preventDefault();
      if (activePick !== null) setPicked(null);
      else setDismissed(true);
      return;
    }
    if (!plain || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const walked = stepHistory({ index: recall, draft, saved }, past, e.key);
    if (!walked) return;
    e.preventDefault();
    setRecall(walked.index);
    setDraft(walked.draft);
    setSaved(walked.saved);
    setPicked(null);
    setDismissed(false);
  };

  const body = (
    <>
      <div className="console" ref={log} aria-live="polite">
        {entries.map((entry, i) => (
          <Fragment key={entry.id}>
            {/* The console is kept from one day to the next: each day opens with its date, as in a chat. */}
            {i === 0 || !sameDay(entries[i - 1]!.at, entry.at) ? <div className="day">{dayLabel(entry.at / 1000)}</div> : null}
            <Entry entry={entry} onRetry={() => again(entry.command)} onMenu={(e) => menuOf(entry, e)} />
          </Fragment>
        ))}
        {lost && person ? (
          <div className="c-wayback">
            <span className="muted small">{t("node.console.personNoReply")}</span>
          </div>
        ) : lost ? (
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
        {/* Nothing typed: the everyday commands, a tap away. Something typed: what it can be, and what that does. */}
        {showPick ? (
          <div className="cli-pick" ref={picks}>
            {shown.length > 0 ? (
              <div className="cli-pick-list" role="listbox" aria-label={t("node.console.command")}>
                {shown.map((s, i) => (
                  <button
                    key={s.fill}
                    type="button"
                    role="option"
                    aria-selected={i === activePick}
                    className={["cli-pick-row", i === activePick ? "on" : ""].join(" ")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      applyDraft(s.fill);
                      input.current?.focus();
                    }}
                  >
                    <span className="cli-pick-cmd">{s.label}</span>
                    {s.about ? <span className="cli-pick-desc">{t(s.about)}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {total > PICK_ROWS ? <span className="cli-pick-more">{t("cli.more", { count: total - PICK_ROWS })}</span> : null}
            {activeHint ? <span className="cli-pick-hint">{t("cli.whatToEnter", { hint: activeHint })}</span> : null}
          </div>
        ) : !typed ? (
          <div className="chips console-chips">
            {chips.map((s) => (
              <button
                key={s.fill}
                type="button"
                className="chip mono"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  applyDraft(s.fill);
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
        ) : null}
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
                onChange={(e) => {
                  holdSubmit.current = false;
                  applyDraft(e.target.value);
                }}
                onKeyDown={onKey}
                onKeyUp={(e) => {
                  if (e.key === "Enter") holdSubmit.current = false;
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => {
                  holdSubmit.current = false;
                  setFocused(false);
                }}
              />
            </div>
            {/* The same quiet button as a chat's paperclip: tapped it opens the reference, held it offers the rest. */}
            <button
              type="button"
              className={["compose-send", "attach", "cli-help-btn", holding ? "holding" : ""].join(" ")}
              aria-label={t("cli.title")}
              title={t("cli.title")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openHelp}
              {...helpPress}
            >
              {holding ? (
                <svg className="hold-ring" viewBox="0 0 46 46" aria-hidden="true">
                  <circle cx="23" cy="23" r="21" />
                </svg>
              ) : null}
              <HelpIcon size={18} />
            </button>
            <button
              type="submit"
              className={["compose-send", online && typed ? "ready" : "idle"].join(" ")}
              aria-label={t("common.send")}
              disabled={!online || !typed}
              onMouseDown={(e) => {
                holdSubmit.current = false;
                e.preventDefault();
              }}
            >
              <SendIcon size={18} />
            </button>
          </div>
        </div>
      </form>
    </>
  );

  return (
    <>
      {wide && helping ? (
        <div className="console-split">
          <div className="console-pane">{body}</div>
          <aside className="cli-help">
            <div className="cli-help-head">
              <span className="cli-help-title">{t("cli.title")}</span>
              <IconButton label={t("common.close")} onClick={() => setHelping(false)}>
                <CloseIcon size={18} />
              </IconButton>
            </div>
            <SearchField
              value={query}
              onValue={setQuery}
              aria-label={t("cli.search")}
              placeholder={t("cli.search")}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <CommandList target={target} ctx={cliCtx} query={query} onPick={pick} />
          </aside>
        </div>
      ) : (
        <div className="console-pane">{body}</div>
      )}
      {!wide ? (
        <Sheet open={helping} onClose={() => setHelping(false)} title={t("cli.title")} find={<SearchField value={query} onValue={setQuery} aria-label={t("cli.search")} placeholder={t("cli.search")} />}>
          <CommandList target={target} ctx={cliCtx} query={query} onPick={pick} />
        </Sheet>
      ) : null}
      {contact && !person ? (
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
