import { useRef, useState, type KeyboardEvent } from "react";
import { emojiName, searchEmoji, useEmojiData, type UnicodeGroup } from "../lib/emojiData.js";
import { MOODS, RADIO_REACTIONS, TOP_REACTIONS, recentReactions, setRecentReactions, type Mood } from "../lib/reactions.js";
import { useWide } from "../lib/layout.js";
import { t, useLanguage, type Key } from "../i18n/index.js";
import {
  BallIcon,
  BulbIcon,
  CarIcon,
  ChevronUpIcon,
  ClockIcon,
  CloseIcon,
  CupIcon,
  HeartIcon,
  LeafIcon,
  PartyIcon,
  PersonIcon,
  RadioIcon,
  SadIcon,
  SearchIcon,
  SmileIcon,
  ThumbDownIcon,
  ThumbUpIcon,
} from "./Icons.js";

type SectionId = "top" | "recent" | "radio" | UnicodeGroup;
type Icon = typeof ClockIcon;

const SECTION_NAMES: Record<Exclude<SectionId, "top">, Key> = {
  recent: "chats.react.groupRecent",
  radio: "chats.react.groupRadio",
  faces: "chats.react.groupFaces",
  people: "chats.react.groupPeople",
  nature: "chats.react.groupNature",
  food: "chats.react.groupFood",
  travel: "chats.react.groupTravel",
  activity: "chats.react.groupActivity",
  objects: "chats.react.groupObjects",
  symbols: "chats.react.groupSymbols",
};

/** The band of groups: the clock leads to the first rows and the ones chosen lately. */
const TABS: { id: SectionId; label: Key; icon: Icon }[] = [
  { id: "top", label: "chats.react.groupTop", icon: ClockIcon },
  { id: "radio", label: "chats.react.groupRadio", icon: RadioIcon },
  { id: "faces", label: "chats.react.groupFaces", icon: SmileIcon },
  { id: "people", label: "chats.react.groupPeople", icon: PersonIcon },
  { id: "nature", label: "chats.react.groupNature", icon: LeafIcon },
  { id: "food", label: "chats.react.groupFood", icon: CupIcon },
  { id: "travel", label: "chats.react.groupTravel", icon: CarIcon },
  { id: "activity", label: "chats.react.groupActivity", icon: BallIcon },
  { id: "objects", label: "chats.react.groupObjects", icon: BulbIcon },
  { id: "symbols", label: "chats.react.groupSymbols", icon: HeartIcon },
];

const MOOD_LOOKS: Record<Mood, { label: Key; icon: Icon }> = {
  love: { label: "chats.react.moodLove", icon: HeartIcon },
  yes: { label: "chats.react.moodYes", icon: ThumbUpIcon },
  no: { label: "chats.react.moodNo", icon: ThumbDownIcon },
  party: { label: "chats.react.moodParty", icon: PartyIcon },
  joy: { label: "chats.react.moodJoy", icon: SmileIcon },
  sad: { label: "chats.react.moodSad", icon: SadIcon },
};

/**
 * Every emoji, opened out of the strip over a held message's menu: a search
 * field with a few moods in it, a band of groups, and the emoji under them.
 * It opens low, so the message and its chat stay in sight, and grows to its
 * full height by its grab bar, by scrolling or by a group; on a phone the
 * keyboard lifts the message out of its way (Menu.tsx).
 */
export function EmojiPicker({ mine, onPick, onFold }: { mine: string | null; onPick: (emoji: string) => void; onFold: () => void }) {
  const data = useEmojiData(useLanguage());
  const wide = useWide();
  const [query, setQuery] = useState("");
  const [mood, setMood] = useState<Mood | null>(null);
  const [big, setBig] = useState(false);
  const [active, setActive] = useState<SectionId>("top");
  const [recent, setRecent] = useState(recentReactions);
  const scroller = useRef<HTMLDivElement>(null);

  const searching = query.trim() !== "";
  const found: readonly string[] | null = searching ? (data ? searchEmoji(data, query).map((e) => e.emoji) : []) : mood ? MOODS.find((m) => m.id === mood)!.items : null;
  const sections: { id: SectionId; items: readonly string[] }[] = [
    { id: "top", items: TOP_REACTIONS },
    ...(recent.length ? [{ id: "recent" as const, items: recent }] : []),
    { id: "radio", items: RADIO_REACTIONS },
    ...(data?.groups.map((g) => ({ id: g.id, items: g.items.map((e) => e.emoji) })) ?? []),
  ];

  const cell = (emoji: string) => (
    <button key={emoji} type="button" className={emoji === mine ? "on" : ""} aria-pressed={emoji === mine} title={emojiName(data, emoji) ?? undefined} onClick={() => onPick(emoji)}>
      {emoji}
    </button>
  );
  const jump = (id: SectionId) => {
    setBig(true);
    setActive(id);
    const box = scroller.current;
    const section = box?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (box && section) box.scrollTo({ top: id === "top" ? 0 : section.offsetTop, behavior: "smooth" });
  };
  // Scrolling the list is asking for more of it; the band follows the group in view.
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    if (!big && box.scrollTop > 8) setBig(true);
    let current: SectionId = "top";
    for (const section of box.querySelectorAll<HTMLElement>("[data-section]")) if (section.offsetTop <= box.scrollTop + 8) current = section.dataset["section"] as SectionId;
    if (current === "recent") current = "top";
    if (current !== active) setActive(current);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && found?.[0]) {
      e.preventDefault();
      onPick(found[0]);
    }
  };

  return (
    <div className={["emoji-picker", big ? "big" : ""].join(" ")}>
      <button type="button" className="emoji-grab" aria-label={big ? t("chats.react.shorter") : t("chats.react.taller")} aria-expanded={big} onClick={() => setBig(!big)}>
        <span />
      </button>
      <label className="emoji-find">
        <SearchIcon size={19} />
        <input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // On a computer the field is ready for the first letter; on a phone the keyboard waits for a tap.
          autoFocus={wide}
          aria-label={t("chats.react.find")}
          placeholder={t("chats.react.search")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMood(null);
          }}
          onKeyDown={onKey}
        />
        {!searching ? (
          <span className="emoji-moods" role="group" aria-label={t("chats.react.moods")}>
            {MOODS.map((m) => {
              const look = MOOD_LOOKS[m.id];
              return (
                <button
                  key={m.id}
                  type="button"
                  className={mood === m.id ? "on" : ""}
                  aria-pressed={mood === m.id}
                  aria-label={t(look.label)}
                  title={t(look.label)}
                  onClick={(e) => {
                    e.preventDefault();
                    setMood(mood === m.id ? null : m.id);
                  }}
                >
                  <look.icon size={21} />
                </button>
              );
            })}
          </span>
        ) : null}
        {searching || mood ? (
          <button
            type="button"
            className="emoji-clear"
            aria-label={t("common.clear")}
            onClick={(e) => {
              e.preventDefault();
              setQuery("");
              setMood(null);
            }}
          >
            <CloseIcon size={14} strokeWidth={2.2} />
          </button>
        ) : null}
      </label>
      {found === null ? (
        <div className="emoji-band">
          <nav className="emoji-tabs" aria-label={t("chats.react.groups")}>
            {TABS.map((tab) => (
              <button key={tab.id} type="button" className={tab.id === active ? "on" : ""} aria-label={t(tab.label)} title={t(tab.label)} onClick={() => jump(tab.id)}>
                <tab.icon size={21} />
              </button>
            ))}
          </nav>
          <button type="button" className="emoji-fold" aria-label={t("chats.react.less")} title={t("chats.react.less")} onClick={onFold}>
            <ChevronUpIcon size={20} strokeWidth={2.2} />
          </button>
        </div>
      ) : null}
      <div ref={scroller} className="emoji-scroll" onScroll={found === null ? onScroll : undefined}>
        {found === null ? (
          sections.map((s) => (
            <section key={s.id} data-section={s.id} className="emoji-section" aria-label={s.id === "top" ? t("chats.react.groupTop") : t(SECTION_NAMES[s.id])}>
              {s.id !== "top" ? (
                <div className="emoji-head">
                  {t(SECTION_NAMES[s.id])}
                  {s.id === "recent" ? (
                    <button
                      type="button"
                      className="emoji-head-clear"
                      aria-label={t("chats.react.clearRecent")}
                      title={t("chats.react.clearRecent")}
                      onClick={() => {
                        setRecentReactions([]);
                        setRecent([]);
                      }}
                    >
                      <CloseIcon size={16} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="emoji-grid">{s.items.map(cell)}</div>
            </section>
          ))
        ) : found.length ? (
          <>
            <div className="emoji-head">{searching ? t("chats.react.found", { count: found.length }) : t(MOOD_LOOKS[mood!].label)}</div>
            <div className="emoji-grid">{found.map(cell)}</div>
          </>
        ) : data ? (
          <p className="emoji-none">{t("chats.react.nothing")}</p>
        ) : null}
      </div>
    </div>
  );
}
