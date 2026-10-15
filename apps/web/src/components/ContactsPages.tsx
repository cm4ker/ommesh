/**
 * Settings › Contacts: which new nodes the radio keeps, what it does once its
 * memory is full, the tidy-up rule, and the contacts taken off it, to be put
 * back. The first three are the radio's own settings (`manual_add_contacts`,
 * `autoadd_config`, `autoadd_max_hops` in the firmware); the rule is this app's.
 */

import { useMemo, useState } from "react";
import { AutoAdd, ContactFlag, type RemovedContact, type SessionState } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { openCleanUp } from "../lib/cleanUp.js";
import { ago, agoPhrase } from "../lib/format.js";
import { push } from "../lib/nav.js";
import { kindLabel } from "../lib/nodes.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { session, useSession } from "../lib/session.js";
import { chatKeys, isYours, memoryUse, setTidyDays, TIDY_DAYS, useTidyDays } from "../lib/tidy.js";
import { act, toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { SearchField } from "../ui/Field.js";
import { ActionRow, Group, InfoRow, LinkRow, SelectRow, SwitchRow } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { TrashIcon } from "./Icons.js";

type Self = NonNullable<SessionState["self"]>;
type Mode = "all" | "kinds" | "manual";

const KIND_BITS = AutoAdd.Chat | AutoAdd.Repeater | AutoAdd.Room | AutoAdd.Sensor;

const KINDS: { bit: number; label: Key }[] = [
  { bit: AutoAdd.Chat, label: "contacts.kind.people" },
  { bit: AutoAdd.Repeater, label: "contacts.kind.repeaters" },
  { bit: AutoAdd.Room, label: "contacts.kind.rooms" },
  { bit: AutoAdd.Sensor, label: "contacts.kind.sensors" },
];

/** `autoadd_max_hops`: 0 is any distance, 1 heard directly, N up to N-1 hops. */
const HOP_CHOICES = [0, 1, 2, 3, 4, 6];

function hopLabel(maxHops: number): string {
  if (maxHops === 0) return t("contacts.hops.any");
  if (maxHops === 1) return t("contacts.hops.direct");
  return t("contacts.hops.upTo", { count: maxHops - 1 });
}

/** The choices, and the radio's own value when it is none of them. */
function hopOptions(current: number): { value: string; label: string }[] {
  const choices = HOP_CHOICES.includes(current) ? HOP_CHOICES : [...HOP_CHOICES, current];
  return choices.map((n) => ({ value: String(n), label: hopLabel(n) }));
}

function modeOf(self: Self, config: number): Mode {
  if ((self.manualAddContacts & 1) === 0) return "all";
  return config & KIND_BITS ? "kinds" : "manual";
}

/** Only this one flag changes; the rest of the radio's settings go back as they are. */
function setManualAdd(self: Self, manual: boolean) {
  return session.setOtherParams({
    manualAddContacts: (self.manualAddContacts & ~1) | (manual ? 1 : 0),
    telemetryModeBase: self.telemetryModeBase,
    telemetryModeLocation: self.telemetryModeLocation,
    telemetryModeEnvironment: self.telemetryModeEnvironment,
    advertLocPolicy: self.advertLocPolicy,
    multiAcks: self.multiAcks,
  });
}

export function ContactsPage() {
  const state = useSession();
  const saved = useSavedPasswords();
  const self = state.self;
  const rule = useTidyDays(self?.key ?? null);
  const [askStars, setAskStars] = useState(false);
  const online = state.status === "ready";
  const autoAdd = state.autoAdd;
  const config = autoAdd?.config ?? 0;
  const use = memoryUse(state);
  const removed = Object.keys(state.removed).length;
  // Only a star keeps a contact from being replaced: the ones this app keeps for other reasons, unstarred.
  const unstarred = useMemo(() => {
    const chats = chatKeys(state);
    return Object.values(state.contacts).filter((c) => !c.unsaved && !(c.flags & ContactFlag.Favourite) && (chats.has(c.key) || isYours(state, saved, c)));
  }, [state, saved]);

  if (!self) return <div className="empty muted">{t("contacts.connectFirst")}</div>;
  const mode = modeOf(self, config);

  const setMode = (next: Mode) =>
    void act(async () => {
      await setManualAdd(self, next !== "all");
      if (autoAdd && next === "kinds" && !(config & KIND_BITS)) await session.setAutoAdd(config | AutoAdd.Chat | AutoAdd.Room, autoAdd.maxHops);
      if (autoAdd && next === "manual" && config & KIND_BITS) await session.setAutoAdd(config & ~KIND_BITS, autoAdd.maxHops);
    }, t("common.savedToRadio"));
  const setConfig = (next: number) => autoAdd && void act(() => session.setAutoAdd(next, autoAdd.maxHops), t("common.savedToRadio"));
  const setReplace = async (on: boolean) => {
    if (!autoAdd) return;
    const ok = await act(() => session.setAutoAdd(on ? config | AutoAdd.OverwriteOldest : config & ~AutoAdd.OverwriteOldest, autoAdd.maxHops), t("common.savedToRadio"));
    if (ok && on && unstarred.length) setAskStars(true);
  };

  return (
    <>
      <Group title={t("contacts.newNodes.title")} note={autoAdd ? t("contacts.newNodes.note") : t("contacts.newNodes.oldFirmware")}>
        {autoAdd ? (
          <SelectRow<Mode>
            label={t("contacts.newNodes.keep")}
            value={mode}
            disabled={!online}
            options={[
              { value: "all", label: t("contacts.newNodes.every") },
              { value: "kinds", label: t("contacts.newNodes.kinds") },
              { value: "manual", label: t("contacts.newNodes.manual") },
            ]}
            onChange={setMode}
          />
        ) : (
          <SelectRow<Mode>
            label={t("contacts.newNodes.keep")}
            value={mode === "all" ? "all" : "manual"}
            disabled={!online}
            options={[
              { value: "all", label: t("contacts.newNodes.every") },
              { value: "manual", label: t("contacts.newNodes.manual") },
            ]}
            onChange={setMode}
          />
        )}
        {autoAdd && mode === "kinds"
          ? KINDS.map((k) => <SwitchRow key={k.bit} label={t(k.label)} checked={!!(config & k.bit)} disabled={!online} onChange={(v) => setConfig(v ? config | k.bit : config & ~k.bit)} />)
          : null}
        {autoAdd && mode !== "manual" ? (
          <SelectRow label={t("contacts.newNodes.howFar")} value={String(autoAdd.maxHops)} disabled={!online} options={hopOptions(autoAdd.maxHops)} onChange={(v) => void act(() => session.setAutoAdd(config, Number(v)), t("common.savedToRadio"))} />
        ) : null}
        {autoAdd ? (
          <SelectRow
            label={t("contacts.newNodes.whenFull")}
            value={config & AutoAdd.OverwriteOldest ? "replace" : "drop"}
            disabled={!online}
            options={[
              { value: "drop", label: t("contacts.newNodes.drop") },
              { value: "replace", label: t("contacts.newNodes.replace") },
            ]}
            onChange={(v) => void setReplace(v === "replace")}
          />
        ) : null}
      </Group>

      <Group title={t("contacts.tidy.title")} note={t("contacts.tidy.note")}>
        <SelectRow
          label={t("contacts.tidy.removeAfter")}
          value={String(rule)}
          options={[{ value: "0", label: t("common.off") }, ...TIDY_DAYS.map((d) => ({ value: String(d), label: t("contacts.days", { count: d }) }))]}
          onChange={(v) => setTidyDays(self.key, Number(v))}
        />
        <LinkRow label={t("contacts.removed")} value={removed || undefined} onClick={() => push({ kind: "radio", page: "removed" })} />
      </Group>

      <Group title={t("contacts.memory.title")}>
        {use ? <InfoRow label={t("contacts.memory.used", { used: use.used, max: use.max })}>{state.contactsFull ? <span className="danger">{t("contacts.memory.full")}</span> : null}</InfoRow> : null}
        <ActionRow label={t("contacts.memory.cleanUp")} disabled={!online || !!state.removing} onClick={openCleanUp} />
      </Group>

      <Confirm
        open={askStars}
        title={t("contacts.star.title", { count: unstarred.length })}
        body={<p>{unstarred.length === 1 ? t("contacts.star.bodyOne", { name: unstarred[0]!.name || unstarred[0]!.prefix }) : t("contacts.star.bodyMany")}</p>}
        confirmLabel={t("contacts.star.confirm")}
        onCancel={() => setAskStars(false)}
        onConfirm={async () => {
          setAskStars(false);
          await act(async () => {
            for (const c of unstarred) await session.setFavourite(c.key, true);
          }, t("contacts.star.done", { count: unstarred.length }));
        }}
      />
    </>
  );
}

const BY: Record<RemovedContact["by"], Key> = {
  you: "contacts.by.you",
  tidy: "contacts.by.tidy",
  radio: "contacts.by.radio",
};

/**
 * The contacts taken off the radio in the last 90 days, newest first, each with Put back. A search finds one
 * among hundreds (#93), and Forget drops those shown before their 90 days are up, but for the nodes there is a
 * chat with: the chat takes its name from what is kept here.
 */
export function RemovedPage() {
  const state = useSession();
  const online = state.status === "ready";
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState(false);
  const all = Object.values(state.removed).sort((a, b) => b.at - a.at);
  if (all.length === 0) return <div className="empty muted">{t("contacts.removedPage.empty")}</div>;
  const q = query.trim().toLowerCase();
  const rows = q ? all.filter((r) => (r.contact.name || r.contact.prefix).toLowerCase().includes(q) || r.contact.key.startsWith(q)) : all;
  const chats = chatKeys(state);
  const forgettable = rows.filter((r) => !chats.has(r.contact.key)).map((r) => r.contact.key);
  const kept = rows.length - forgettable.length;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = rows.filter((r) => r.at >= weekAgo);
  const earlier = rows.filter((r) => r.at < weekAgo);
  const putBack = async (key: string, name: string) => {
    setBusy(key);
    await act(() => session.restoreContact(key), t("contacts.removedPage.back", { name }));
    setBusy(null);
  };
  const list = (title: string, items: RemovedContact[]) =>
    items.length ? (
      <Group title={title}>
        {items.map((r) => {
          const c = r.contact;
          const name = c.name || c.prefix;
          return (
            <div key={c.key} className="line">
              <Avatar name={name} type={c.type} size={32} />
              <span className="line-text">
                <span>{name}</span>
                <small>
                  {kindLabel(c.type)} · {t(BY[r.by])} · {ago(r.at)}
                </small>
              </span>
              <Button size="sm" busy={busy === c.key} disabled={!online || busy !== null} onClick={() => void putBack(c.key, name)}>
                {t("contacts.removedPage.putBack")}
              </Button>
            </div>
          );
        })}
      </Group>
    ) : null;
  const forget = () => {
    setAsk(false);
    session.forgetRemoved(forgettable);
    toast(t("contacts.removedPage.forgotten", { count: forgettable.length }));
  };
  return (
    <>
      <SearchField value={query} onValue={setQuery} placeholder={t("contacts.removedPage.find")} aria-label={t("contacts.removedPage.find")} />
      <div className="removed-head">
        <span>{q ? t("contacts.removedPage.found", { shown: rows.length, count: all.length }) : t("contacts.removedPage.total", { count: all.length })}</span>
        <Button variant="danger" size="sm" disabled={forgettable.length === 0} onClick={() => setAsk(true)}>
          <TrashIcon size={15} /> {!q ? t("contacts.removedPage.forgetAll") : forgettable.length ? t("contacts.removedPage.forgetSome", { count: forgettable.length }) : t("contacts.removedPage.forget")}
        </Button>
      </div>
      {rows.length === 0 ? <div className="empty muted">{t("contacts.removedPage.noMatch")}</div> : null}
      {list(t("contacts.removedPage.thisWeek"), recent)}
      {list(t("contacts.removedPage.earlier"), earlier)}
      <p className="group-note">{t("contacts.removedPage.note")}</p>
      <Confirm
        open={ask}
        danger
        title={t("contacts.removedPage.forgetTitle", { count: forgettable.length })}
        body={
          <>
            <p>{t("contacts.removedPage.forgetBody")}</p>
            {kept ? <p>{t("contacts.removedPage.forgetKeeps", { count: kept })}</p> : null}
          </>
        }
        confirmLabel={t("contacts.removedPage.forget")}
        onCancel={() => setAsk(false)}
        onConfirm={forget}
      />
    </>
  );
}

/** Says a contact is on the radio no more, or was never kept, and puts it back. For the profile and the chat. */
export function NotOnRadio({ contactKey, compact = false }: { contactKey: string; compact?: boolean }) {
  const state = useSession();
  const removed = state.removed[contactKey];
  const heard = state.contacts[contactKey];
  const [busy, setBusy] = useState(false);
  const record = removed?.contact ?? (heard?.unsaved ? heard : null);
  if (!record) return null;
  const name = record.name || record.prefix;
  const why = removed
    ? removed.by === "radio"
      ? t("contacts.notOnRadio.radioDropped", { name })
      : removed.at >= Date.now() - 7 * 86_400_000
        ? t("contacts.notOnRadio.takenOffAgo", { name, time: agoPhrase(removed.at) })
        : t("contacts.notOnRadio.takenOffOn", { name, date: agoPhrase(removed.at) })
    : t("contacts.notOnRadio.notKept", { name });
  const add = async () => {
    setBusy(true);
    const ok = await act(() => session.restoreContact(contactKey));
    setBusy(false);
    if (ok) toast(t("contacts.notOnRadio.added", { name }));
  };
  return (
    <div className={["not-on-radio", compact ? "compact" : ""].join(" ")}>
      <p>
        <b>{t("contacts.notOnRadio.title")}</b> {why} {t("contacts.notOnRadio.cannotReach", { name })}
      </p>
      <Button variant="primary" busy={busy} disabled={state.status !== "ready"} onClick={() => void add()}>
        {removed ? t("contacts.notOnRadio.putBack") : t("contacts.notOnRadio.add")}
      </Button>
    </div>
  );
}
