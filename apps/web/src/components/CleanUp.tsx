import { useEffect, useMemo, useState } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { tx } from "../i18n/rich.js";
import { closeCleanUp, removeNodes, useCleanUpOpen } from "../lib/cleanUp.js";
import { ago } from "../lib/format.js";
import { useSavedPasswords } from "../lib/secrets.js";
import { useSession } from "../lib/session.js";
import { KEEP_LABELS, TIDY_DAYS, tidyPlan, useTidyDays, type KeepReason } from "../lib/tidy.js";
import { heardAt, kindLabel } from "../lib/nodes.js";
import { Button } from "../ui/Button.js";
import { Group, LinkRow, SelectRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { Avatar } from "./Avatar.js";

const KIND_NAMES: [number, Key][] = [
  [AdvType.Chat, "contacts.count.people"],
  [AdvType.Repeater, "contacts.count.repeaters"],
  [AdvType.Room, "contacts.count.rooms"],
  [AdvType.Sensor, "contacts.count.sensors"],
];

function byKind(list: ContactRecord[]): string {
  return KIND_NAMES.map(([type, key]) => {
    const n = list.filter((c) => c.type === type).length;
    return n ? t(key, { count: n }) : null;
  })
    .filter(Boolean)
    .join(" · ");
}

const KEEP_WHY: Record<KeepReason, Key> = {
  favourite: "contacts.keepWhy.favourite",
  yours: "contacts.keepWhy.yours",
  chat: "contacts.keepWhy.chat",
};

/**
 * One sheet for the whole mesh: the nodes not heard for a while, or every one
 * the radio keeps, one number, one button; the list behind a tap. "Every one"
 * is for this sheet only: the protocol removes contacts one at a time, and
 * the tidy rule never takes them all.
 */
export function CleanUpHost() {
  const open = useCleanUpOpen();
  return open ? <CleanUpSheet /> : null;
}

function CleanUpSheet() {
  const state = useSession();
  const saved = useSavedPasswords();
  const rule = useTidyDays(state.self?.key ?? null);
  const [days, setDays] = useState<number>(rule || 30);
  const [review, setReview] = useState(false);
  // The plan is taken when the sheet opens and when the days change, so rows do not jump under a finger.
  const plan = useMemo(() => tidyPlan(state, saved, days, Date.now()), [days, state.self?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<Set<string>>(() => new Set(plan.remove.map((c) => c.key)));
  useEffect(() => setPicked(new Set(plan.remove.map((c) => c.key))), [plan]);
  const online = state.status === "ready";
  const n = picked.size;
  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const pickedChats = plan.kept.filter((k) => k.reason === "chat" && picked.has(k.contact.key));

  const go = () => {
    const keys = [...plan.remove, ...plan.kept.map((k) => k.contact)].map((c) => c.key).filter((k) => picked.has(k));
    closeCleanUp();
    void removeNodes(keys);
  };

  const title = n ? t("contacts.cleanUp.removeNodes", { count: n }) : t("contacts.cleanUp.title");
  const keptWhy = [...new Set(plan.kept.map((k) => t(KEEP_WHY[k.reason])))];
  return (
    <Sheet open onClose={closeCleanUp} title={title}>
      <p className="group-note cleanup-note">
        {days === 0
          ? plan.remove.length || plan.kept.length
            ? t("contacts.cleanUp.allKept")
            : t("contacts.cleanUp.noneKept")
          : plan.remove.length || plan.kept.length
            ? t("contacts.cleanUp.notHeardOver", { count: days })
            : t("contacts.cleanUp.allHeard", { count: days })}
      </p>
      {plan.remove.length ? <p className="group-note cleanup-kinds">{byKind(plan.remove)}</p> : null}
      <Group>
        <SelectRow label={t("contacts.cleanUp.notHeardFor")} value={String(days)} options={[...TIDY_DAYS.map((d) => ({ value: String(d), label: t("contacts.days", { count: d }) })), { value: "0", label: t("contacts.cleanUp.everyone") }]} onChange={(v) => setDays(Number(v))} />
        {plan.remove.length || plan.kept.length ? <LinkRow label={review ? t("contacts.cleanUp.hide") : t("contacts.cleanUp.review")} value={plan.remove.length + plan.kept.length} onClick={() => setReview(!review)} /> : null}
      </Group>
      {review ? (
        <>
          {plan.remove.length ? <PickList title={days === 0 ? t("contacts.cleanUp.allNodes") : t("contacts.cleanUp.notHeardDays", { count: days })} rows={plan.remove.map((c) => ({ contact: c, reason: null }))} picked={picked} onToggle={toggle} /> : null}
          {plan.kept.length ? <PickList title={t("contacts.cleanUp.kept")} rows={plan.kept} picked={picked} onToggle={toggle} /> : null}
        </>
      ) : null}
      {plan.kept.length ? (
        <p className="group-note">
          {tx("contacts.cleanUp.keptWhy", { kept: <b className="cleanup-kept">{t("contacts.cleanUp.keptCount", { count: plan.kept.length })}</b>, why: keptWhy.join(", ") })}
        </p>
      ) : null}
      {pickedChats.length ? (
        <p className="group-note danger">
          {pickedChats.length === 1 ? t("contacts.cleanUp.chatWarnOne", { name: pickedChats[0]!.contact.name || pickedChats[0]!.contact.prefix }) : t("contacts.cleanUp.chatWarnMany")}
        </p>
      ) : null}
      <div className="sheet-form cleanup-actions">
        <Button variant="danger" size="lg" disabled={!n || !online || !!state.removing} onClick={go}>
          {n ? t("contacts.cleanUp.removeCount", { count: n }) : t("contacts.cleanUp.nothing")}
        </Button>
      </div>
    </Sheet>
  );
}

function PickList({ title, rows, picked, onToggle }: { title: string; rows: { contact: ContactRecord; reason: KeepReason | null }[]; picked: ReadonlySet<string>; onToggle: (key: string) => void }) {
  return (
    <>
      <div className="list-group">{title}</div>
      <ul className="list-rows cleanup-list" role="list">
        {rows.map(({ contact: c, reason }) => (
          <li key={c.key}>
            <label className="row cleanup-row">
              <input type="checkbox" checked={picked.has(c.key)} onChange={() => onToggle(c.key)} />
              <Avatar name={c.name || c.prefix} type={c.type} size={32} />
              <span className="row-main">
                <span className="row-top">
                  <span className="row-title">{c.name || c.prefix}</span>
                  <span className="row-when muted">{ago(heardAt(c) || null)}</span>
                </span>
                <span className="row-sub muted">{reason ? `${kindLabel(c.type)} · ${t(KEEP_LABELS[reason])}` : kindLabel(c.type)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}
