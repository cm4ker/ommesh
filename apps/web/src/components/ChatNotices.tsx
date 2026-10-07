import { kindLevel, setChatLevel, setChatSound, SIGNALS, useNoticePrefs, type ChatLevel, type Signal } from "../lib/noticePrefs.js";
import { previewSignal } from "../lib/chime.js";
import { BACKGROUND_NAMES, BACKGROUNDS, setChatBackground, useBackgroundPrefs, type Background } from "../lib/chatBackground.js";
import { Group, SelectRow } from "../ui/List.js";
import { BellIcon, PictureIcon, SpeakerIcon } from "./Icons.js";
import { t, type Key } from "../i18n/index.js";

const WORD: Record<ChatLevel, Key> = { all: "chats.notices.all", mentions: "chats.notices.mentions", off: "common.off" };
/** A person's chat is on or off: nobody mentions you in a chat that is only yours. */
const DIRECT_WORD: Record<ChatLevel, Key> = { all: "common.on", mentions: "common.on", off: "common.off" };

/**
 * A chat's own notification level, sound and background, on its channel page or
 * its profile; "Default" follows Settings › Notifications or › Appearance. A
 * chat with no notices has no sound to pick.
 */
export function ChatNotices({ conversation, direct }: { conversation: string; direct: boolean }) {
  const prefs = useNoticePrefs();
  const own = prefs.chat[conversation];
  const words = direct ? DIRECT_WORD : WORD;
  const levels: ChatLevel[] = direct ? ["all", "off"] : ["all", "mentions", "off"];
  return (
    <Group>
      <SelectRow
        label={t("chats.notices.label")}
        icon={<BellIcon size={17} />}
        hint={own === "mentions" ? t("chats.notices.mentionsHint") : undefined}
        value={own ?? "default"}
        options={[{ value: "default", label: t("chats.notices.default", { level: t(words[kindLevel(prefs, direct)]) }) }, ...levels.map((l) => ({ value: l, label: t(words[l]) }))]}
        onChange={(v) => setChatLevel(conversation, v === "default" ? null : (v as ChatLevel))}
      />
      {(own ?? kindLevel(prefs, direct)) !== "off" ? <ChatSoundRow conversation={conversation} direct={direct} /> : null}
      <ChatBackgroundRow conversation={conversation} />
    </Group>
  );
}

/** A chat's own background; "Default" is the one every chat has. */
function ChatBackgroundRow({ conversation }: { conversation: string }) {
  const prefs = useBackgroundPrefs();
  return (
    <SelectRow
      label={t("chats.background")}
      icon={<PictureIcon size={17} />}
      value={prefs.chat[conversation] ?? "default"}
      options={[{ value: "default", label: t("chats.backgroundDefault", { background: t(BACKGROUND_NAMES[prefs.background]) }) }, ...BACKGROUNDS.map((b) => ({ value: b, label: t(BACKGROUND_NAMES[b]) }))]}
      onChange={(v) => setChatBackground(conversation, v === "default" ? null : (v as Background))}
    />
  );
}

/** The name of a signal in the reader's language. */
export function signalName(signal: Signal): string {
  return t((SIGNALS.find((s) => s.id === signal) ?? SIGNALS[0]!).label);
}

/**
 * A chat's own sound, heard as it is picked; "Default" is its kind's. On the
 * chat's page it is called Sound, and on Settings › Notifications › Sound by
 * the chat's name.
 */
export function ChatSoundRow({ conversation, direct, name }: { conversation: string; direct: boolean; name?: string }) {
  const prefs = useNoticePrefs();
  const own = prefs.chatSound[conversation];
  const kindSignal = prefs.sounds[direct ? "direct" : "chats"];
  return (
    <SelectRow
      label={name ?? t("chats.notices.sound")}
      icon={name === undefined ? <SpeakerIcon size={17} /> : undefined}
      value={own ?? "default"}
      options={[{ value: "default", label: t("chats.notices.soundDefault", { sound: signalName(kindSignal) }) }, ...SIGNALS.map((s) => ({ value: s.id, label: t(s.label) }))]}
      onChange={(v) => {
        const next = v === "default" ? null : (v as Signal);
        setChatSound(conversation, next);
        previewSignal(next ?? kindSignal);
      }}
    />
  );
}
