import { useState } from "react";
import { locale, t } from "../i18n/index.js";
import { push } from "../lib/nav.js";
import { buildReport } from "../lib/report.js";
import { useSelector } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { isTraceEnabled, setTraceEnabled, useTrace } from "../lib/trace.js";
import { Button } from "../ui/Button.js";
import { Toggle } from "../ui/Field.js";
import { CopyIcon, SendIcon } from "./Icons.js";

/** The time of a line; one from an earlier day, kept from before a restart, says its day too. */
function when(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString(locale());
  return d.toLocaleString(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function LogView() {
  const log = useSelector((state) => state.log);
  const trace = useTrace();
  const [tracing, setTracing] = useState(isTraceEnabled);
  const entries = [...log].reverse();
  // The report, not the bare lines: what the app and the radio are matters as much.
  const copy = () => void buildReport().then((text) => navigator.clipboard?.writeText(text)).then(() => toast(t("common.copied")));
  return (
    <div className="card-scroll">
      <div className="section">
        <header className="section-head">
          <h2>{t("radio.log.events")}</h2>
          <div className="section-actions">
            <Button size="sm" onClick={copy}>
              <CopyIcon size={15} />
              {t("radio.log.copy")}
            </Button>
            <Button size="sm" onClick={() => push({ kind: "radio", page: "report" })}>
              <SendIcon size={15} />
              {t("radio.log.report")}
            </Button>
          </div>
        </header>
        {entries.length === 0 ? <p className="muted small">{t("radio.log.nothing")}</p> : null}
        <ul className="log">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="log-when muted">{when(e.at)}</span>
              <span className={`log-kind kind-${e.kind}`}>{e.kind}</span>
              <span className="log-text">{e.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="section">
        <header className="section-head">
          <h2>{t("radio.log.frames")}</h2>
        </header>
        <Toggle
          label={t("radio.log.record")}
          hint={t("radio.log.recordHint")}
          checked={tracing}
          onChange={(v) => {
            setTracing(v);
            setTraceEnabled(v);
          }}
        />
        {tracing ? (
          <ul className="log mono">
            {[...trace].reverse().map((f, i) => (
              <li key={`${f.at}-${i}`}>
                <span className="log-when muted">{new Date(f.at).toLocaleTimeString(locale())}</span>
                <span className={`log-kind ${f.direction}`}>{f.direction === "in" ? "←" : "→"} {f.kind}</span>
                <span className="log-text">{f.hex}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
