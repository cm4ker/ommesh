import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";
import { buildReport, ReportError, sendReport } from "../lib/report.js";
import { toast } from "../lib/toast.js";
import { openLink } from "../lib/webLinks.js";
import { Button } from "../ui/Button.js";
import { Block, Group, LinkRow, SwitchRow } from "../ui/List.js";
import { ChevronDownIcon, ChevronUpIcon, CopyIcon, ExternalIcon, SendIcon } from "./Icons.js";

/** Where someone with a GitHub account can write on their own. */
const NEW_ISSUE = "https://github.com/cm4ker/ommesh/issues/new";

/** As much as the server takes. */
const DESCRIPTION_MAX = 4000;

/**
 * A problem or an idea, sent as an issue on GitHub through the project's
 * server: no account needed. The log and the radio's setup go along unless
 * left out, and what goes can be read first.
 */
export function ReportPage() {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(true);
  const [report, setReport] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ url: string; number: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void buildReport().then(setReport);
  }, []);

  const copy = () => {
    const out = [text.trim(), attach ? report : null].filter(Boolean).join("\n\n");
    void navigator.clipboard?.writeText(out).then(() => toast(t("common.copied")));
  };
  const send = async () => {
    setSending(true);
    setFailure(null);
    try {
      // Built again, so what happened while it was being written goes too.
      const fresh = attach ? await buildReport() : "";
      setReport(fresh || report);
      setSent(await sendReport(text.trim(), fresh || t("radio.report.noLog")));
    } catch (error) {
      const code = error instanceof ReportError ? error.code : "network";
      setFailure(t(code === "too-many" ? "radio.report.tooMany" : code === "network" ? "radio.report.offline" : "radio.report.refused"));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Group note={t("radio.report.sentNote")}>
        <LinkRow label={t("radio.report.sent", { number: sent.number })} tone="accent" trailing={<ExternalIcon size={14} className="line-chev" />} onClick={() => openLink(sent.url)} />
      </Group>
    );
  }

  return (
    <>
      <Group note={t("radio.report.note")}>
        <Block>
          <label className="field">
            <span className="field-label">{t("radio.report.what")}</span>
            <textarea className="input" rows={5} maxLength={DESCRIPTION_MAX} value={text} placeholder={t("radio.report.placeholder")} onChange={(e) => setText(e.target.value)} />
          </label>
        </Block>
        <SwitchRow label={t("radio.report.attach")} hint={t("radio.report.attachHint")} checked={attach} onChange={setAttach} />
        {attach ? (
          <LinkRow
            label={t("radio.report.preview")}
            value={report === null ? t("radio.report.building") : undefined}
            trailing={shown ? <ChevronUpIcon size={14} className="line-chev" /> : <ChevronDownIcon size={14} className="line-chev" />}
            onClick={() => setShown(!shown)}
          />
        ) : null}
        {attach && shown && report ? (
          <Block>
            <pre className="report-preview">{report}</pre>
          </Block>
        ) : null}
      </Group>
      {failure ? <p className="report-failure">{failure}</p> : null}
      <div className="page-actions">
        <Button size="sm" onClick={copy}>
          <CopyIcon size={15} />
          {t("radio.report.copy")}
        </Button>
        <Button variant="primary" size="sm" busy={sending} disabled={sending || text.trim() === "" || (attach && report === null)} onClick={() => void send()}>
          <SendIcon size={15} />
          {t("radio.report.send")}
        </Button>
      </div>
      <Group>
        <LinkRow label={t("radio.report.github")} hint={t("radio.report.githubHint")} trailing={<ExternalIcon size={14} className="line-chev" />} onClick={() => openLink(NEW_ISSUE)} />
      </Group>
    </>
  );
}
