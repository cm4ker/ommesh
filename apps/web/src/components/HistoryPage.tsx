import { useMemo, useRef, useState } from "react";
import { TxtType, type SessionState } from "@meshnet/meshcore";
import { HistoryFileError, historyFileName, writeHistory } from "../lib/history/format.js";
import { OtherRadioError, planImport, readHistorySource, type ImportPlan } from "../lib/history/plan.js";
import { dayLabel } from "../lib/format.js";
import { saveFile } from "../lib/saveFile.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Group } from "../ui/List.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

type Self = NonNullable<SessionState["self"]>;

/**
 * The radio's history in a file: saved as one, and brought in from one this
 * app saved or the official MeshCore app exported. What a file would bring
 * is shown in numbers and added once confirmed.
 */
export function HistoryPage({ self }: { self: Self }) {
  const state = useSession();
  const picker = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const held = useMemo(() => {
    const messages = state.messages.filter((m) => m.txtType !== TxtType.CliData);
    return { messages: messages.length, chats: new Set(messages.map((m) => m.conversation)).size, contacts: Object.keys(state.contacts).length + Object.keys(state.removed).length };
  }, [state.messages, state.contacts, state.removed]);

  const save = async () => {
    setSaving(true);
    try {
      const now = Date.now();
      const file = writeHistory(session.getState(), `Ommesh ${__APP_VERSION__}`, now);
      const name = historyFileName(self.name, now);
      const how = await saveFile(name, `${JSON.stringify(file, null, 2)}\n`, "application/json", t("radio.history.shareTitle"));
      if (how === "downloaded") toast(t("radio.history.downloaded"), "", undefined, name);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const read = async (file: File) => {
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Let the spinner show before the file is read, which holds the page for a moment.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const now = session.getState();
      const found = planImport(readHistorySource(bytes), { self, channels: now.channels, contacts: now.contacts, now: Date.now() });
      const { messages, contacts, removed, heard } = found.history;
      if (messages.length + contacts.length + removed.length + heard.length === 0) toast(t("radio.history.nothing"));
      else setPlan(found);
    } catch (error) {
      toast(readError(error), "error");
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <Group title={self.name} note={t("radio.history.note")}>
        <ActionRow
          label={t("radio.history.save")}
          hint={[t("radio.history.messages", { count: held.messages }), t("radio.history.chats", { count: held.chats }), t("radio.history.contacts", { count: held.contacts })].join(", ")}
          busy={saving}
          onClick={() => void save()}
        />
        <ActionRow label={t("radio.history.bringIn")} hint={t("radio.history.bringInHint")} busy={reading} onClick={() => picker.current?.click()} />
      </Group>
      <input
        ref={picker}
        type="file"
        accept=".json,.db,.sqlite,.sqlite3,application/json,application/x-sqlite3,application/vnd.sqlite3,application/octet-stream"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Cleared, so the same file can be picked again.
          e.currentTarget.value = "";
          if (file) void read(file);
        }}
      />
      <Confirm
        open={plan !== null}
        title={t("radio.history.title")}
        body={plan ? <PlanSummary plan={plan} /> : null}
        confirmLabel={t("radio.history.confirm")}
        onCancel={() => setPlan(null)}
        onConfirm={async () => {
          const found = plan;
          setPlan(null);
          if (!found) return;
          try {
            const summary = session.importHistory(found.history);
            await session.flush();
            const lines = [t("radio.history.done", { count: summary.messages })];
            if (summary.already > 0) lines.push(t("radio.history.already", { count: summary.already }));
            if (summary.removedContacts > 0) lines.push(t("radio.history.toRemoved", { count: summary.removedContacts }));
            toast(lines.join(" "));
          } catch (error) {
            toast(errorText(error), "error");
          }
        }}
      />
    </>
  );
}

function PlanSummary({ plan }: { plan: ImportPlan }) {
  const { messages, contacts, removed, heard } = plan.history;
  const source = t(plan.kind === "ommesh" ? "radio.history.fromOmmesh" : "radio.history.fromMeshcoreApp");
  const period = plan.from === null || plan.to === null ? null : [dayLabel(plan.from / 1000), dayLabel(plan.to / 1000)].filter((d, i, all) => all.indexOf(d) === i).join(" – ");
  const left = [
    ...plan.left.channels.map((c) => t("radio.history.leftChannel", { name: c.name, count: c.messages })),
    ...(plan.left.console > 0 ? [t("radio.history.leftConsole", { count: plan.left.console })] : []),
  ];
  return (
    <>
      <p className="muted">{period ? `${source} · ${period}` : source}</p>
      <p>
        {[
          t("radio.history.messages", { count: messages.length }),
          t("radio.history.chats", { count: plan.chats }),
          t("radio.history.contacts", { count: contacts.length + removed.length }),
          ...(heard.length > 0 ? [t("radio.history.heard", { count: heard.length })] : []),
        ].join(" · ")}
      </p>
      <p>{t("radio.history.body")}</p>
      {left.length > 0 ? (
        <p className="muted">
          {t("radio.history.leftOut")} {left.join("; ")}.
        </p>
      ) : null}
    </>
  );
}

/** Why a picked file could not be brought in, in the reader's words. */
function readError(error: unknown): string {
  if (error instanceof OtherRadioError) return t("radio.history.otherRadio", { key: error.radioKey.slice(0, 8) });
  if (error instanceof HistoryFileError) {
    if (error.kind === "newer") return t("radio.history.newer");
    if (error.kind === "field") return t("radio.history.badField", { path: error.path });
    return t("radio.history.notHistory");
  }
  // The SQLite reader's own complaints: a damaged database, or another app's.
  if (error instanceof Error && /SQLite|MeshCore app export|damaged/.test(error.message)) return t("radio.history.notHistory");
  return errorText(error);
}
