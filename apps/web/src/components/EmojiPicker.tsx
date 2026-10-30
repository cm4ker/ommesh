import { useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { emojiName, searchEmoji, useEmojiData, type UnicodeGroup } from "../lib/emojiData.js";
import { MOODS, RADIO_REACTIONS, TOP_REACTIONS, recentReactions, setRecentReactions, type Mood } from "../lib/reactions.js";
import { useWide } from "../lib/layout.js";
import { closeMenu, useHeldMenu } from "../ui/Menu.js";
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

/** How tall every emoji opens under a held message, px: two rows more than the band, the field and the first rows. */
const OPEN_HEIGHT = 352;

/**
 * Every emoji, opened out of the strip over a held message's menu, as
 * Telegram has them: a band of groups that stays, and under it a search field
 * with a few moods in it, which scrolls away with the emoji. Under a held
 * message it opens a little taller than the menu, so the message and its chat
 * stay in sight, and scrolling pulls it up over the screen, the message with
 * it, and then down to the screen's foot (Menu.tsx); back at the top it is low
 * again, with room for the keyboard. A computer's popover grows to its full
 * height by its grab bar, by scrolling or by a group.
 */
export function EmojiPicker({ mine, onPick, onFold }: { mine: string | null; onPick: (emoji: string) => void; onFold: () => void }) {
  const data = useEmojiData(useLanguage());
  const wide = useWide();
  const held = useHeldMenu();
  const grows = wide && !held;
  const [query, setQuery] = useState("");
  const [mood, setMood] = useState<Mood | null>(null);
  const [big, setBig] = useState(false);
  const [active, setActive] = useState<SectionId>("top");
  const [recent, setRecent] = useState(recentReactions);
  const scroller = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);

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
    if (grows) setBig(true);
    setActive(id);
    const box = scroller.current;
    const section = box?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!box || !section) return;
    // Past the room over the emoji, which pulls them all the way up: the first rows with the search field over
    // them, a group with its heading right under the band.
    const above = room.current?.offsetHeight ?? 0;
    const top = id === "top" ? above : Math.max(above, section.offsetTop - (band.current?.offsetHeight ?? 0));
    // A near group slides into view; a far one comes at once, as sliding past a thousand emoji takes too long.
    box.scrollTo({ top, behavior: Math.abs(top - box.scrollTop) < box.clientHeight * 3 ? "smooth" : "auto" });
  };
  // Scrolling the list is asking for more of it; the band follows the group in view.
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    if (grows && !big && box.scrollTop > 8) setBig(true);
    let current: SectionId = "top";
    // A group counts once its heading is near the band: a jump lands a pixel or two short of it.
    const line = Math.max(box.scrollTop, room.current?.offsetHeight ?? 0) + (band.current?.offsetHeight ?? 0) + 40;
    for (const section of box.querySelectorAll<HTMLElement>("[data-section]")) if (section.offsetTop <= line) current = section.dataset["section"] as SectionId;
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
      {grows ? (
        <button type="button" className="emoji-grab" aria-label={big ? t("chats.react.shorter") : t("chats.react.taller")} aria-expanded={big} onClick={() => setBig(!big)}>
          <span />
        </button>
      ) : null}
      <div ref={scroller} className="emoji-scroll" data-rise={held ? OPEN_HEIGHT : undefined} onScroll={found === null ? onScroll : undefined}>
        {/* Under a held message, the room over the emoji: a tap there closes the menu, as on the dimming. */}
        {held ? <div ref={room} className="emoji-room" aria-hidden="true" onClick={closeMenu} /> : null}
        <div className="emoji-card">
          <div ref={band} className="emoji-band">
            <nav className="emoji-tabs" aria-label={t("chats.react.groups")}>
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={found === null && tab.id === active ? "on" : ""}
                  aria-label={t(tab.label)}
                  title={t(tab.label)}
                  onClick={() => {
                    // A group asked for while searching brings the groups back first.
                    if (found !== null)
                      flushSync(() => {
                        setQuery("");
                        setMood(null);
                      });
                    jump(tab.id);
                  }}
                >
                  <tab.icon size={21} />
                </button>
              ))}
            </nav>
            <button type="button" className="emoji-fold" aria-label={t("chats.react.less")} title={t("chats.react.less")} onClick={onFold}>
              <ChevronUpIcon size={20} strokeWidth={2.2} />
            </button>
          </div>
          <div className="emoji-body">
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
      </div>
    </div>
  );
}
