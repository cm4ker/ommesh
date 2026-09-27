import { useRef, useState } from "react";
import { readOfficialHistory, type OfficialHistory } from "../lib/officialImport.js";
import { session, useSession } from "../lib/session.js";
import { unsavedKeepMs } from "../lib/tidy.js";
import { toast } from "../lib/toast.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Group } from "../ui/List.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/**
 * Brings in the history the official MeshCore app exported for this radio:
 * a file is picked, read here, shown in numbers, and added once confirmed.
 */
export function OfficialImportGroup() {
  const state = useSession();
  const self = state.self;
  const picker = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [found, setFound] = useState<OfficialHistory | null>(null);

  const read = async (file: File) => {
    if (!self) return;
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Let the spinner show before the file is read, which holds the page for a moment.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const now = session.getState();
      let history: OfficialHistory;
      try {
        history = readOfficialHistory(bytes, { self, channels: now.channels, contacts: now.contacts, heardKeepMs: unsavedKeepMs(self.key), now: Date.now() });
      } catch (error) {
        toast(t("radio.messages.importNotOfficial"), "error", undefined, errorText(error));
        return;
      }
      if (history.radioKey && history.radioKey !== self.key) {
        toast(t("radio.messages.importOtherRadio", { key: history.radioKey.slice(0, 8) }), "error");
        return;
      }
      setFound(history);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setReading(false);
    }
  };

  const skipped = found?.skipped.channels ?? [];
  return (
    <Group note={self ? t("radio.messages.importNote") : t("radio.messages.importOffline")}>
      <ActionRow
        label={t("radio.messages.importOfficial")}
        hint={t("radio.messages.importOfficialHint")}
        disabled={!self}
        busy={reading}
        onClick={() => picker.current?.click()}
      />
      <input
        ref={picker}
        type="file"
        accept=".db,.sqlite,.sqlite3,application/x-sqlite3,application/vnd.sqlite3,application/octet-stream"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Cleared, so the same file can be picked again.
          e.currentTarget.value = "";
          if (file) void read(file);
        }}
      />
      <Confirm
        open={found !== null}
        title={t("radio.messages.importTitle")}
        body={
          found ? (
            <>
              <p>
                {[
                  t("radio.messages.importMessages", { count: found.messages.length }),
                  t("radio.messages.importContacts", { count: found.contacts.length }),
                  t("radio.messages.importHeard", { count: found.heard.length }),
                ].join(" · ")}
              </p>
              <p>{t("radio.messages.importBody")}</p>
              {found.skipped.oldMessages > 0 ? <p className="muted">{t("radio.messages.importOld", { count: found.skipped.oldMessages })}</p> : null}
              {skipped.length > 0 ? (
                <p className="muted">
                  {t("radio.messages.importSkippedChannels", { channels: skipped.map((c) => `${c.name} (${c.messages})`).join(", ") })}
                </p>
              ) : null}
            </>
          ) : null
        }
        confirmLabel={t("radio.messages.importConfirm")}
        onCancel={() => setFound(null)}
        onConfirm={async () => {
          const history = found;
          setFound(null);
          if (!history) return;
          try {
            const summary = session.importHistory(history);
            await session.flush();
            const done = t("radio.messages.importDone", { count: summary.messages });
            toast(summary.already > 0 ? `${done} ${t("radio.messages.importAlready", { count: summary.already })}` : done);
          } catch (error) {
            toast(errorText(error), "error");
          }
        }}
      />
    </Group>
  );
}
