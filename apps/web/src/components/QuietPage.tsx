import { clockAhead, timeOfDay } from "../lib/format.js";
import { push } from "../lib/nav.js";
import { setQuietPrefs, useNoticePrefs, type QuietPrefs } from "../lib/noticePrefs.js";
import { FOREVER, morning, quietOff, setQuiet, useQuiet } from "../lib/quiet.js";
import { session } from "../lib/session.js";
import { Button } from "../ui/Button.js";
import { ChoiceRow, Group, InfoRow, LinkRow, SelectRow, SwitchRow } from "../ui/List.js";
import { BellIcon, MoonIcon } from "./Icons.js";
import { t, type Key } from "../i18n/index.js";

/** How long it is quiet, as the status line and the Settings rows say it. */
export function quietStatus(until: number): string {
  return until >= FOREVER ? t("radio.quiet.statusAlways") : t("radio.quiet.statusUntil", { time: clockAhead(until) });
}

/** The row on Settings › Notifications that opens Do not disturb, saying whether it is on. */
export function QuietRow() {
  const quiet = useQuiet();
  return (
    <LinkRow
      label={t("radio.titles.quiet")}
      icon={<MoonIcon size={17} />}
      value={quiet.until !== null ? (quiet.until >= FOREVER ? t("common.on") : t("radio.quiet.untilTime", { time: clockAhead(quiet.until) })) : t("radio.quiet.off")}
      onClick={() => push({ kind: "radio", page: "quiet" })}
    />
  );
}

const HANDS: { hand: QuietPrefs["hand"]; label: Key }[] = [
  { hand: "hour", label: "radio.quiet.hour" },
  { hand: "morning", label: "radio.quiet.morning" },
  { hand: "always", label: "radio.quiet.forever" },
];

/** The days a night may start on, by name. */
const DAYS: { id: string; days: number[]; label: Key }[] = [
  { id: "every", days: [0, 1, 2, 3, 4, 5, 6], label: "radio.quiet.everyDay" },
  { id: "weekdays", days: [1, 2, 3, 4, 5], label: "radio.quiet.weekdays" },
  { id: "weekends", days: [0, 6], label: "radio.quiet.weekends" },
];

/** The times a night can start or end at, every half hour, as minutes after midnight. */
const TIMES = Array.from({ length: 48 }, (_, i) => i * 30);

/** Minutes after midnight on the clock of the reader's language. */
function clockOf(minutes: number): string {
  return timeOfDay(new Date(2000, 0, 1, 0, minutes).getTime() / 1000);
}

/**
 * Do not disturb: on by hand for a while, on at night by a schedule, and who
 * rings all the same. Its status, while on, sits at the top with the button
 * that turns it off.
 */
export function QuietPage() {
  const q = useNoticePrefs().quiet;
  const quiet = useQuiet();
  const now = Date.now();
  const hand = q.hand === "always" || (q.hand !== "off" && q.until > now) ? q.hand : "off";
  const days = DAYS.find((d) => d.days.length === q.days.length && d.days.every((day) => q.days.includes(day))) ?? DAYS[0]!;
  const times = TIMES.map((m) => ({ value: String(m), label: clockOf(m) }));
  const name = session.getState().self?.name ?? t("radio.notifications.yourName");
  return (
    <>
      {quiet.until !== null ? (
        <Group>
          <InfoRow label={quietStatus(quiet.until)} icon={<MoonIcon size={17} />}>
            <Button size="sm" onClick={quietOff}>
              <BellIcon size={15} />
              {t("radio.quiet.turnOff")}
            </Button>
          </InfoRow>
        </Group>
      ) : null}
      <Group title={t("radio.quiet.turnOn")}>
        <ChoiceRow label={q.nightly ? t("radio.quiet.onlyNights") : t("radio.quiet.off")} checked={hand === "off"} onSelect={() => setQuiet("off")} />
        {HANDS.map((h) => (
          <ChoiceRow
            key={h.hand}
            label={t(h.label)}
            hint={h.hand === "hour" && hand === "hour" ? t("radio.quiet.untilTime", { time: clockAhead(q.until) }) : undefined}
            value={h.hand === "morning" ? clockAhead(hand === "morning" ? q.until : morning(q, now)) : undefined}
            checked={hand === h.hand}
            onSelect={() => setQuiet(h.hand)}
          />
        ))}
      </Group>
      <Group title={t("radio.quiet.schedule")}>
        <SwitchRow label={t("radio.quiet.nightly")} hint={t("radio.quiet.nightlyHint", { from: clockOf(q.from), to: clockOf(q.to) })} checked={q.nightly} onChange={(nightly) => setQuietPrefs({ nightly })} />
        {q.nightly ? (
          <>
            <SelectRow label={t("radio.quiet.from")} value={String(q.from)} options={times} onChange={(v) => setQuietPrefs({ from: Number(v) })} />
            <SelectRow label={t("radio.quiet.to")} value={String(q.to)} options={times} onChange={(v) => setQuietPrefs({ to: Number(v) })} />
            <SelectRow
              label={t("radio.quiet.days")}
              value={days.id}
              options={DAYS.map((d) => ({ value: d.id, label: t(d.label) }))}
              onChange={(v) => setQuietPrefs({ days: DAYS.find((d) => d.id === v)!.days })}
            />
          </>
        ) : null}
      </Group>
      <Group title={t("radio.quiet.through")} note={t("radio.quiet.note")}>
        <SwitchRow label={t("radio.quiet.favourites")} hint={t("radio.quiet.favouritesHint")} checked={q.favourites} onChange={(favourites) => setQuietPrefs({ favourites })} />
        <SwitchRow label={t("radio.quiet.mentions")} hint={t("radio.quiet.mentionsHint", { name })} checked={q.mentions} onChange={(mentions) => setQuietPrefs({ mentions })} />
      </Group>
    </>
  );
}
