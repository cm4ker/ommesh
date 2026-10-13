/**
 * A voice message in the chat (#89): what came is text, so it is shown as
 * text, with a button that reads it out and the word being read lit. A part
 * that has not come is said under it; one of ours no repeater was heard
 * sending on gets a button to send it once more.
 */

import { useState, type MouseEvent } from "react";
import { VoiceGender, type MessageRecord } from "@meshnet/meshcore";
import { session, useSelector } from "../lib/session.js";
import { speak, useSpeaking, useVoicePrefs } from "../lib/voice.js";
import { AlertIcon, MicIcon, PauseIcon, PlayIcon } from "./Icons.js";
import { t } from "../i18n/index.js";

/** "0:07": how long it was said. */
export function voiceLength(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The length beside the time, after a microphone: this was said, not typed. */
export function VoiceLength({ seconds }: { seconds: number }) {
  return (
    <span className="voice-length">
      <MicIcon size={12} />
      {voiceLength(seconds)}
    </span>
  );
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function VoiceBody({ message }: { message: MessageRecord }) {
  const voice = message.voice!;
  const out = message.direction === "out";
  const prefs = useVoicePrefs();
  const theirs = useSelector((state) => state.voicePeers[voice.speaker]?.gender ?? VoiceGender.Any);
  const gender = out ? prefs.gender : theirs;
  const speaking = useSpeaking();
  const playing = speaking?.id === message.id;
  const [busy, setBusy] = useState(false);

  const missing = voice.parts.map((part, i) => (part === null ? i + 1 : 0)).filter(Boolean);
  const unheard = out ? (voice.unheard ?? []) : [];
  const failed = out && message.status === "failed";

  const again = async (indexes: number[]) => {
    setBusy(true);
    try {
      for (const index of indexes) await session.resendVoicePart(message.id, index);
    } catch {
      // The part stays faded, its button there to try again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="voice-body">
        <button
          type="button"
          className={["voice-play", playing ? "on" : ""].join(" ")}
          aria-label={playing ? t("chats.voice.stop") : t("chats.voice.play")}
          title={playing ? t("chats.voice.stop") : t("chats.voice.play")}
          onClick={(e) => {
            stop(e);
            speak(message.id, message.text, gender, voice.speaker);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {/* While its sender's voice is still being worked out, a spinner in place of the pause. */}
          {playing && speaking.preparing ? <span className="spinner" aria-hidden="true" /> : playing ? <PauseIcon size={14} strokeWidth={2.5} /> : <PlayIcon size={14} />}
        </button>
        <span className="msg-text voice-text">{playing && !speaking.preparing ? <Lit text={message.text} at={speaking.at} /> : message.text}</span>
      </span>
      {missing.length ? <span className="voice-gap">{missing.map((index) => t("chats.voice.partMissing", { index, count: voice.parts.length })).join(" · ")}</span> : null}
      {failed || unheard.length ? (
        <span className="voice-gap warn">
          <AlertIcon size={12} />
          {failed ? t("chats.voice.failed") : unheard.map((i) => t("chats.voice.partUnheard", { index: i + 1 })).join(" · ")}
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={(e) => {
              stop(e);
              void again(failed ? voice.parts.map((_, i) => i) : unheard);
            }}
          >
            {t("chats.voice.again")}
          </button>
        </span>
      ) : null}
    </>
  );
}

/** The text with the word being read out lit and what is still to come set back. */
function Lit({ text, at }: { text: string; at: number }) {
  const rest = text.slice(at);
  const word = rest.match(/^\S*/)?.[0] ?? "";
  return (
    <>
      {text.slice(0, at)}
      <mark className="voice-word">{word}</mark>
      <span className="voice-ahead">{rest.slice(word.length)}</span>
    </>
  );
}
