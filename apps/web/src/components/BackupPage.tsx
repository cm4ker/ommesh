import { useMemo, useState } from "react";
import { TxtType, type RestoreStep, type SessionState } from "@meshnet/meshcore";
import { chooseBackup, forgetMove, putAwayBlank, restoreBackup, saveBackup, useBackupSaved, useBlankRadio, useMovedFrom, usePickedBackup, useRestoreRun, type RestoreRun } from "../lib/backup/run.js";
import { overflow, partsAvailable, RESTORE_PARTS, type RestorePart, type RestorePlan } from "../lib/backup/plan.js";
import { agoPhrase } from "../lib/format.js";
import { push, setStack } from "../lib/nav.js";
import { saveKey, useKeyNote } from "../lib/radioKey.js";
import { useSession } from "../lib/session.js";
import { Button, IconButton } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Group, InfoRow, LinkRow, SwitchRow } from "../ui/List.js";
import { CheckIcon, CloseIcon, DownIcon, FileIcon, KeyIcon, UpIcon } from "./Icons.js";
import { presetName, ResetQuestion } from "./RadioPages.js";
import { t, type Key } from "../i18n/index.js";

type Self = NonNullable<SessionState["self"]>;

/**
 * Copy and move: the whole radio saved to one file, and written back from
 * one onto this radio or another. The key and the chat history alone stay
 * below, as they were before the copy held both.
 */
export function BackupPage({ self, online }: { self: Self; online: boolean }) {
  const state = useSession();
  const saved = useBackupSaved(self.key);
  const note = useKeyNote(self.key);
  const [saving, setSaving] = useState<"copy" | "key" | null>(null);
  const held = useMemo(() => {
    const messages = state.messages.filter((m) => m.txtType !== TxtType.CliData && m.txtType !== TxtType.CliCommand).length;
    return { messages, contacts: Object.values(state.contacts).filter((c) => !c.unsaved).length };
  }, [state.messages, state.contacts]);
  const contents = [
    note.closed ? t("radio.backup.hasNoKey") : t("radio.backup.hasKey"),
    t("radio.backup.channels", { count: state.channels.length }),
    t("radio.backup.contacts", { count: held.contacts }),
    t("radio.backup.messages", { count: held.messages }),
  ].join(", ");
  const save = (what: "copy" | "key") => {
    setSaving(what);
    void (what === "copy" ? saveBackup() : saveKey()).finally(() => setSaving(null));
  };
  return (
    <>
      <Group title={self.name} note={[saved ? t("radio.backup.savedOn", { when: agoPhrase(saved) }) : null, t("radio.backup.note", { name: self.name })].filter(Boolean).join(" ")}>
        <ActionRow icon={<DownIcon size={17} />} label={t("radio.backup.save")} hint={contents} disabled={!online} busy={saving === "copy"} onClick={() => save("copy")} />
        <ActionRow icon={<UpIcon size={17} />} label={t("radio.backup.restore")} hint={t("radio.backup.restoreHint")} disabled={!online} onClick={chooseBackup} />
      </Group>
      <Group title={t("radio.backup.part")} note={note.closed ? t("radio.key.closedNote") : undefined}>
        <ActionRow
          icon={<KeyIcon size={17} />}
          label={t("radio.key.save")}
          hint={note.closed ? t("radio.key.closed") : note.saved ? t("radio.key.savedOn", { when: agoPhrase(note.saved) }) : t("radio.key.neverSaved")}
          disabled={!online}
          busy={saving === "key"}
          onClick={() => save("key")}
        />
        <LinkRow icon={<UpIcon size={17} />} label={t("radio.titles.key")} hint={t("radio.key.restoreHint")} onClick={() => push({ kind: "radio", page: "key" })} />
        <LinkRow icon={<FileIcon size={17} />} label={t("radio.titles.history")} hint={t("radio.backup.historyHint")} onClick={() => push({ kind: "radio", page: "history" })} />
      </Group>
    </>
  );
}

/**
 * A picked copy, part by part, before it is written onto the radio: what
 * each part brings and what the radio has now. Every part is on to begin
 * with. While it is written, the same page shows how far it has got.
 */
export function RestorePage({ self, online }: { self: Self; online: boolean }) {
  const plan = usePickedBackup();
  const running = useRestoreRun();
  if (running) return <RestoreSteps run={running} plan={plan} />;
  if (!plan) {
    return (
      <Group note={t("radio.restore.pickNote")}>
        <ActionRow icon={<FileIcon size={17} />} label={t("radio.restore.pick")} disabled={!online} onClick={chooseBackup} />
      </Group>
    );
  }
  return <RestoreParts plan={plan} self={self} online={online} />;
}

function RestoreParts({ plan, self, online }: { plan: RestorePlan; self: Self; online: boolean }) {
  const { device } = useSession();
  const [chosen, setChosen] = useState<ReadonlySet<RestorePart>>(() => new Set(RESTORE_PARTS));
  const [refused, setRefused] = useState(false);
  const parts = partsAvailable(plan, chosen);
  const on = (part: RestorePart) => parts.has(part) && chosen.has(part);
  const flip = (part: RestorePart) => (next: boolean) => {
    const set = new Set(chosen);
    if (next) set.add(part);
    else set.delete(part);
    setChosen(set);
  };
  const { file } = plan;
  const radio = file.radio.settings.radio;
  const tx = file.radio.settings.txPower;
  const now = (value: string) => t("radio.restore.now", { value });
  const over = overflow(plan);
  const anything = RESTORE_PARTS.some(on);
  const go = async (picked: ReadonlySet<RestorePart>) => {
    const result = await restoreBackup(plan, picked);
    if (result === "keyRefused") setRefused(true);
    else if (result === "done") {
      setStack("radio", []);
      setStack("chats", []);
    }
  };

  return (
    <>
      <Group title={t("radio.restore.whose", { name: file.radio.name })} note={t("radio.restore.from", { when: agoPhrase(plan.saved), app: file.by })}>
        {plan.same ? (
          <InfoRow label={t("radio.restore.same", { name: file.radio.name })} hint={t("radio.restore.sameHint")}>
            {""}
          </InfoRow>
        ) : file.key ? (
          <SwitchRow label={t("radio.restore.key", { name: file.radio.name })} hint={now(self.name)} checked={on("key")} onChange={flip("key")} />
        ) : (
          <SwitchRow label={t("radio.restore.noKey")} hint={t("radio.restore.noKeyHint", { name: self.name })} checked={false} disabled onChange={() => undefined} />
        )}
        <SwitchRow
          label={radio ? t("radio.restore.settings", { value: [presetName(radio), tx !== undefined ? t("radio.restore.dbm", { tx }) : null].filter(Boolean).join(" · ") }) : t("radio.restore.settingsOnly")}
          hint={now(`${presetName(self)} · ${t("radio.restore.dbm", { tx: self.txPower })}`)}
          checked={on("settings")}
          onChange={flip("settings")}
        />
        {parts.has("channels") ? (
          <SwitchRow
            label={t("radio.backup.channels", { count: file.radio.channels.length })}
            hint={file.radio.channels.map((c) => c.name).join(", ")}
            checked={on("channels")}
            onChange={flip("channels")}
          />
        ) : null}
        {parts.has("contacts") ? (
          <SwitchRow
            label={over > 0 ? t("radio.restore.contactsFit", { fit: plan.contacts.length - over, count: plan.contacts.length }) : t("radio.backup.contacts", { count: plan.contacts.length })}
            hint={over > 0 ? t("radio.restore.contactsOver", { count: over }) : device ? t("radio.restore.contactsRoom", { count: device.maxContacts }) : t("radio.restore.contactsHint")}
            checked={on("contacts")}
            onChange={flip("contacts")}
          />
        ) : null}
        {plan.messages > 0 ? (
          <SwitchRow
            label={t("radio.backup.messages", { count: plan.messages })}
            hint={parts.has("chats") ? t("radio.restore.messagesHint", { count: plan.chats }) : t("radio.restore.messagesKey")}
            checked={on("chats")}
            disabled={!parts.has("chats")}
            onChange={flip("chats")}
          />
        ) : null}
        <SwitchRow label={t("radio.restore.app")} hint={t("radio.restore.appHint")} checked={on("app")} onChange={flip("app")} />
      </Group>
      {on("key") ? (
        <div className="memory-strip warn" role="note">
          {t("radio.restore.oldRadio", { name: file.radio.name })}
        </div>
      ) : null}
      <div className="page-actions">
        <Button variant="primary" size="lg" disabled={!online || !anything} onClick={() => void go(chosen)}>
          <UpIcon size={17} />
          {t("radio.restore.apply")}
        </Button>
      </div>
      <Confirm
        open={refused}
        title={t("radio.restore.refusedTitle")}
        body={
          <>
            <p>{t("radio.restore.refusedBody")}</p>
            <p>{t("radio.restore.refusedRest", { name: self.name, old: file.radio.name })}</p>
          </>
        }
        confirmLabel={t("radio.restore.withoutKey")}
        onCancel={() => setRefused(false)}
        onConfirm={async () => {
          setRefused(false);
          const without = new Set(chosen);
          without.delete("key");
          without.delete("chats");
          setChosen(without);
          await go(without);
        }}
      />
    </>
  );
}

const STEP_LABELS: Record<RestoreStep, Key> = {
  key: "radio.restore.stepKey",
  settings: "radio.restore.stepSettings",
  channels: "radio.restore.stepChannels",
  contacts: "radio.restore.stepContacts",
  reboot: "radio.restore.stepReboot",
};

/** How far the copy has got: each step done, the one under way with its count, and those to come. */
function RestoreSteps({ run, plan }: { run: RestoreRun; plan: RestorePlan | null }) {
  const at = run.phase === "back" ? run.steps.length : run.steps.indexOf(run.step);
  return (
    <Group title={plan ? t("radio.restore.writing", { name: plan.file.radio.name }) : undefined} note={t("radio.restore.keepNear")}>
      {run.steps.map((step, i) => (
        <InfoRow key={step} label={t(STEP_LABELS[step])} icon={i < at ? <CheckIcon size={17} /> : <span />}>
          {i < at ? t("radio.restore.stepDone") : i === at && run.phase === "writing" ? (run.step === "contacts" || run.step === "channels" ? t("radio.restore.stepCount", { done: run.done, total: run.total }) : t("radio.restore.stepNow")) : ""}
        </InfoRow>
      ))}
      <InfoRow label={t("radio.restore.stepChats")} icon={<span />}>{run.phase === "back" ? t("radio.restore.stepBack") : ""}</InfoRow>
    </Group>
  );
}

/** Over the chat list on a radio with nothing on it: a copy of an old radio may be what it waits for. */
export function BlankRadioStrip() {
  const state = useSession();
  const blank = useBlankRadio(state);
  if (!blank || !state.self) return null;
  const key = state.self.key;
  return (
    <div className="memory-strip news" role="status">
      <span className="grow">{t("radio.backup.blank")}</span>
      <button type="button" className="memory-act" onClick={chooseBackup}>
        {t("radio.backup.restore")}
      </button>
      <IconButton className="strip-close" label={t("common.close")} onClick={() => putAwayBlank(key)}>
        <CloseIcon size={16} />
      </IconButton>
    </div>
  );
}

/** On the old radio a node moved from, connected again: it holds the same key as the new one. */
export function MovedStrip() {
  const state = useSession();
  const moved = useMovedFrom(state);
  const [resetting, setResetting] = useState(false);
  if (moved === null || !state.self) return null;
  const key = state.self.key;
  return (
    <>
      <div className="memory-strip warn" role="status">
        <span className="grow">{t("radio.backup.moved", { name: state.self.name, when: agoPhrase(moved) })}</span>
        <button type="button" className="memory-act" onClick={() => setResetting(true)}>
          {t("radio.backup.resetOld")}
        </button>
        <button type="button" className="memory-act" onClick={() => forgetMove(key)}>
          {t("radio.backup.keepOld")}
        </button>
      </div>
      <ResetQuestion
        open={resetting}
        onClose={() => setResetting(false)}
        onReset={() => forgetMove(key)}
      />
    </>
  );
}
