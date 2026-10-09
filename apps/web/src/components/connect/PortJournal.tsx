import { Fragment, useLayoutEffect, useRef, useState } from "react";
import {
  applyOutcome,
  askRadio,
  clearJournal,
  closeJournal,
  linesText,
  restartRadio,
  sendText,
  setLine,
  startCheck,
  stopCheck,
  useJournal,
  type CheckOutcome,
  type JournalEntry,
  type JournalProbe,
  type JournalState,
} from "../../lib/portJournal.js";
import { hex } from "../../lib/portLog.js";
import { saveFile } from "../../lib/saveFile.js";
import { toast } from "../../lib/toast.js";
import { Button, IconButton } from "../../ui/Button.js";
import { Input, Select } from "../../ui/Field.js";
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon, FileIcon, RefreshIcon, TrashIcon } from "../Icons.js";
import { t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";

type Filter = "all" | "check" | "frames" | "text";
const FILTERS: Filter[] = ["all", "check", "frames", "text"];
const ENDINGS = ["\r\n", "\n", "\r", ""];

function shows(filter: Filter, entry: JournalEntry): boolean {
  if (filter === "check") return entry.probe !== undefined || entry.kind === "rule";
  if (filter === "frames") return entry.bytes !== undefined && !entry.words && !entry.noise;
  if (filter === "text") return entry.words === true;
  return true;
}

function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

const arrow = (entry: JournalEntry) => (entry.kind === "out" ? "→" : entry.kind === "in" ? "←" : "●");

function probeTitle(probe: JournalProbe): string {
  return probe.loader ? t("connect.journal.probe.loader") : `${probe.baud} · ${linesText(probe.lines)}`;
}

/** The log as plain text, to copy or to save: the probes' headers kept, the bytes beside each line. */
function asText(journal: JournalState): string {
  const out: string[] = [];
  let probe: number | undefined;
  for (const entry of journal.entries) {
    if (entry.probe !== undefined && entry.probe !== probe) {
      const p = journal.probes.find((x) => x.n === entry.probe);
      if (p) out.push(`— ${t("connect.journal.probe", { n: p.n })} · ${probeTitle(p)}${p.result ? ` · ${t(`connect.journal.result.${p.result}`)}` : ""}`);
    }
    probe = entry.probe;
    if (entry.kind === "rule") out.push(`== ${entry.text} ==`);
    else out.push([clock(entry.at), arrow(entry), entry.text, entry.bytes ? hex(entry.bytes, 64) : ""].join("  ").trimEnd());
  }
  return out.join("\n");
}

/** Entries run together by the probe they belong to, so each probe reads as one box. */
function grouped(entries: JournalEntry[]): { probe: number | undefined; entries: JournalEntry[] }[] {
  const out: { probe: number | undefined; entries: JournalEntry[] }[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (last && last.probe === entry.probe && entry.probe !== undefined) last.entries.push(entry);
    else out.push({ probe: entry.probe, entries: [entry] });
  }
  return out;
}

/**
 * The port's log, beside the connect screen: the check and what it found,
 * every line along the cable, and the port by hand: its lines, a restart,
 * a question to the radio, words to the port.
 */
export function PortJournal() {
  const journal = useJournal();
  const [filter, setFilter] = useState<Filter>("all");
  const [bytes, setBytes] = useState(true);
  const [text, setText] = useState("");
  const [ending, setEnding] = useState("\r\n");
  const list = useRef<HTMLDivElement>(null);
  // Kept at the newest line while the reader is there; left alone once they scroll up.
  const stick = useRef(true);
  const shown = journal.entries.filter((e) => shows(filter, e));

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, filter]);

  const { device, outcome, checking, open } = journal;
  if (!device) return null;
  const usb = device.usb ? `${device.usb.vid.toString(16).padStart(4, "0")}:${device.usb.pid.toString(16).padStart(4, "0")}`.toUpperCase() : null;
  const status = checking ? t("connect.journal.status.checking") : open ? t("connect.journal.status.open") : t("connect.journal.status.closed");

  const copy = () => void navigator.clipboard?.writeText(asText(journal)).then(() => toast(t("common.copied")));
  const save = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    void saveFile(`ommesh-port-${device.name.replace(/[^\w.-]+/g, "_")}-${stamp}.txt`, asText(journal), "text/plain", t("connect.serial.log")).catch((error: unknown) =>
      toast(errorText(error)),
    );
  };

  return (
    <aside className="port-log" aria-label={t("connect.serial.log")}>
      <header className="port-log-head">
        <div className="port-log-title">
          <h2>{t("connect.serial.log")}</h2>
          <span>{[device.name, device.detail, usb].filter(Boolean).join(" · ")}</span>
        </div>
        <span className="port-log-status">{status}</span>
        <IconButton label={t("connect.journal.close")} onClick={() => void closeJournal()}>
          <CloseIcon size={16} />
        </IconButton>
      </header>

      <div className="port-log-check">
        <div>
          <Button size="sm" onClick={() => void (checking ? stopCheck() : startCheck())}>
            <RefreshIcon size={14} />
            {checking ? t("connect.journal.checkStop") : outcome ? t("connect.journal.checkAgain") : t("connect.journal.check")}
          </Button>
        </div>
        {outcome && !checking ? <Outcome outcome={outcome} /> : null}
      </div>

      <div className="port-log-tools">
        <div className="segmented" role="radiogroup" aria-label={t("connect.journal.filter")}>
          {FILTERS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {t(`connect.journal.filter.${f}`)}
            </button>
          ))}
        </div>
        <Button size="sm" className={bytes ? "pressed" : undefined} aria-pressed={bytes} onClick={() => setBytes(!bytes)}>
          {t("connect.journal.bytes")}
        </Button>
        <span className="port-log-gap" />
        <Button size="sm" onClick={copy}>
          <CopyIcon size={14} />
          {t("connect.journal.copy")}
        </Button>
        <Button size="sm" onClick={save}>
          <FileIcon size={14} />
          {t("connect.journal.save")}
        </Button>
        <Button size="sm" onClick={clearJournal}>
          <TrashIcon size={14} />
          {t("connect.journal.clear")}
        </Button>
      </div>

      <div
        className={["port-log-lines", bytes ? "with-bytes" : ""].join(" ")}
        ref={list}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 ? <p className="port-log-empty">{t("connect.journal.empty")}</p> : null}
        {grouped(shown).map((group) => {
          const probe = group.probe === undefined ? undefined : journal.probes.find((p) => p.n === group.probe);
          const lines = group.entries.map((entry) => <Line key={entry.id} entry={entry} bytes={bytes} />);
          if (!probe) return <Fragment key={group.entries[0]!.id}>{lines}</Fragment>;
          return (
            <div key={group.entries[0]!.id} className={["port-probe", probe.result ?? "running"].join(" ")}>
              <div className="port-probe-head">
                <span className="muted">{t("connect.journal.probe", { n: probe.n })}</span>
                <span className={probe.loader ? undefined : "mono"}>{probeTitle(probe)}</span>
                {probe.current ? <span className="muted">{t("connect.journal.probe.current")}</span> : null}
                {probe.result ? <span className={["port-pill", probe.result].join(" ")}>{t(`connect.journal.result.${probe.result}`)}</span> : null}
              </div>
              {lines}
            </div>
          );
        })}
      </div>

      <footer className="port-log-manual">
        <div className="port-log-hand">
          <span className="muted">{t("connect.journal.byHand")}</span>
          <LineSwitch name="DTR" on={journal.lines.dtr} disabled={!open} onChange={(level) => void setLine("dtr", level)} />
          <LineSwitch name="RTS" on={journal.lines.rts} disabled={!open} onChange={(level) => void setLine("rts", level)} />
          <Led name="CTS" on={journal.signals?.cts ?? null} />
          <Led name="DSR" on={journal.signals?.dsr ?? null} />
          <span className="port-log-gap" />
          <Button size="sm" disabled={checking} onClick={() => void restartRadio()}>
            <RefreshIcon size={14} />
            {t("connect.journal.restart")}
          </Button>
          <Button size="sm" disabled={!open} onClick={() => void askRadio()}>
            {t("connect.journal.ask")}
          </Button>
        </div>
        <form
          className="port-log-send"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text) return;
            void sendText(text, ending);
            setText("");
          }}
        >
          <Input
            className="input mono"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("connect.journal.textPlaceholder")}
            aria-label={t("connect.journal.textLabel")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Select value={ending} aria-label={t("connect.journal.ending")} onChange={(event) => setEnding(event.target.value)}>
            {ENDINGS.map((e) => (
              <option key={e} value={e}>
                {e === "" ? t("connect.journal.ending.none") : JSON.stringify(e).slice(1, -1)}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary" disabled={!open || !text}>
            {t("connect.journal.send")}
          </Button>
        </form>
      </footer>
    </aside>
  );
}

function Line({ entry, bytes }: { entry: JournalEntry; bytes: boolean }) {
  if (entry.kind === "rule") {
    return (
      <div className="port-rule">
        <span>{entry.text}</span>
        <i />
      </div>
    );
  }
  return (
    <div className={["port-line", entry.kind, entry.words ? "words" : "", entry.noise ? "noise" : ""].join(" ")}>
      <span className="port-line-time">{clock(entry.at)}</span>
      <span className="port-line-dir">{arrow(entry)}</span>
      <span className="port-line-text">{entry.text}</span>
      {bytes ? <span className="port-line-bytes">{entry.bytes ? hex(entry.bytes) : ""}</span> : null}
    </div>
  );
}

function LineSwitch({ name, on, disabled, onChange }: { name: string; on: boolean; disabled: boolean; onChange: (level: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="button sm port-line-switch" disabled={disabled} onClick={() => onChange(!on)}>
      <span className={["switch", on ? "on" : ""].join(" ")} aria-hidden="true" />
      {name}
    </button>
  );
}

function Led({ name, on }: { name: string; on: boolean | null }) {
  return (
    <span className="port-led">
      <i className={on ? "on" : ""} aria-hidden="true" />
      {name}
    </span>
  );
}

function Outcome({ outcome }: { outcome: CheckOutcome }) {
  if (outcome.kind === "answered") {
    const who = outcome.name ? t("connect.journal.outcome.who", { name: outcome.name, firmware: outcome.firmware ?? "?" }) : null;
    const took = t("connect.journal.outcome.took", { probe: outcome.probe, total: outcome.total, seconds: Math.max(1, Math.round(outcome.ms / 1000)) });
    return (
      <div className="port-outcome good">
        <span className="port-outcome-icon">
          <CheckIcon size={20} />
        </span>
        <span className="port-outcome-text">
          <strong>{t("connect.journal.outcome.answered", { baud: outcome.baud, lines: linesText(outcome.lines) })}</strong>
          <span>{[who, took].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="port-outcome-actions">
          <Button variant="primary" size="sm" onClick={() => void applyOutcome(true)}>
            {t("connect.journal.apply")}
          </Button>
          <Button size="sm" onClick={() => void applyOutcome(false).then(() => toast(t("connect.journal.applied")))}>
            {t("connect.journal.applyOnly")}
          </Button>
        </span>
      </div>
    );
  }
  const [title, line, tone] =
    outcome.kind === "text"
      ? [t("connect.journal.outcome.text"), outcome.text.slice(0, 200), "warn"]
      : outcome.kind === "loader"
        ? [t("connect.journal.outcome.loader"), t("connect.journal.outcome.loaderLine"), "warn"]
        : outcome.kind === "garbage"
          ? [t("connect.journal.outcome.garbage"), t("connect.journal.outcome.garbageLine"), "bad"]
          : outcome.kind === "silent"
            ? [t("connect.journal.outcome.silent"), t("connect.journal.outcome.silentLine"), "bad"]
            : [t("connect.journal.outcome.busy"), outcome.error, "bad"];
  return (
    <div className={["port-outcome", tone].join(" ")}>
      <span className="port-outcome-icon">
        <AlertIcon size={20} />
      </span>
      <span className="port-outcome-text">
        <strong>{title}</strong>
        <span className={outcome.kind === "text" ? "mono" : undefined}>{line}</span>
      </span>
      {outcome.kind === "loader" ? (
        <span className="port-outcome-actions">
          <Button variant="primary" size="sm" onClick={() => void restartRadio()}>
            <RefreshIcon size={14} />
            {t("connect.journal.restart")}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
