/**
 * Speaking into the message field of #voice (#89). The round button, with the
 * field empty, is a microphone: held, it records until let go; clicked, until
 * clicked again; Esc throws the recording away. What was heard goes into the
 * field to be looked over, with a bar that says it is a voice message, or
 * straight out when the settings say not to check it.
 */

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { parseConversation, type VoiceGender } from "@meshnet/meshcore";
import { push } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { modelReady, speak, startRecording, transcribe, useVoicePrefs, voiceAvailable, voiceChannel, type Recording } from "../lib/voice.js";
import { CloseIcon, MicIcon, PlayIcon } from "./Icons.js";
import { voiceLength } from "./VoiceMessage.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/** A hold shorter than this was a click: the recording goes on until the next one. */
const CLICK_MS = 400;

/** The channel this chat is, when voice messages are on and it is #voice; null elsewhere. */
export function useVoiceHere(conversation: string): number | null {
  const prefs = useVoicePrefs();
  const state = useSession();
  if (!prefs.on || !voiceAvailable()) return null;
  const target = parseConversation(conversation);
  const channel = voiceChannel(state);
  return target.kind === "channel" && channel?.index === target.index ? channel.index : null;
}

export type RecorderPhase = "idle" | "recording" | "hearing";

export interface Recorder {
  phase: RecorderPhase;
  seconds: number;
  level: number;
  /** For the microphone button. */
  press: {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  };
  cancel: () => void;
}

/** Records, then hands what Whisper heard to `onHeard` with how long it was said. */
export function useRecorder(onHeard: (text: string, seconds: number) => void): Recorder {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | null>(null);
  const press = useRef<{ at: number; started: boolean } | null>(null);
  const heard = useRef(onHeard);
  heard.current = onHeard;

  const finish = async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    setPhase("hearing");
    try {
      const { samples, seconds: said } = await rec.stop();
      const text = said < 0.3 ? "" : (await transcribe(samples)).trim();
      if (text) heard.current(text, said);
      else toast(t("chats.voice.heardNothing"));
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setPhase("idle");
    }
  };

  const cancel = () => {
    recording.current?.cancel();
    recording.current = null;
    setPhase("idle");
  };

  const start = async () => {
    if (!(await modelReady())) {
      toast(t("chats.voice.noModel"), "error");
      push({ kind: "radio", page: "voice" });
      return false;
    }
    try {
      recording.current = await startRecording(() => void finish());
      setSeconds(0);
      setPhase("recording");
      return true;
    } catch {
      toast(t("chats.voice.micDenied"), "error");
      return false;
    }
  };

  // The dot breathes with the voice and the clock runs; Esc throws it away.
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const rec = recording.current;
      if (!rec) return;
      setSeconds(rec.seconds());
      setLevel(rec.level());
    }, 100);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [phase]);

  // Leaving the chat lets the microphone go.
  useEffect(() => () => recording.current?.cancel(), []);

  return {
    phase,
    seconds,
    level,
    cancel,
    press: {
      onPointerDown: (e) => {
        if (e.button !== 0 || phase === "hearing") return;
        e.preventDefault();
        if (recording.current) {
          press.current = { at: Date.now(), started: false };
          return;
        }
        press.current = { at: Date.now(), started: true };
        void start();
      },
      onPointerUp: () => {
        const p = press.current;
        press.current = null;
        if (!p || !recording.current) return;
        // A second press ends it, and so does letting go of a long one.
        if (!p.started || Date.now() - p.at >= CLICK_MS) void finish();
      },
      onClick: (e) => {
        // From the keyboard, with no pointer: one press starts, the next ends.
        if (e.detail !== 0) return;
        if (recording.current) void finish();
        else void start();
      },
    },
  };
}

/** Over the field while recording or recognising. */
export function RecordingBar({ recorder }: { recorder: Recorder }) {
  if (recorder.phase === "hearing") {
    return (
      <div className="compose-bar compose-voice">
        <span className="spinner" aria-hidden="true" />
        <span className="compose-bar-text">{t("chats.voice.hearing")}</span>
      </div>
    );
  }
  return (
    <div className="compose-bar compose-voice rec" role="status">
      <span className="rec-dot" aria-hidden="true" style={{ transform: `scale(${1 + Math.min(1, recorder.level * 3) * 0.6})` }} />
      <span className="rec-time">{voiceLength(recorder.seconds)}</span>
      <span className="compose-bar-text">{t("chats.voice.recording")}</span>
      <button type="button" className="compose-bar-close" aria-label={t("chats.voice.cancel")} onMouseDown={(e) => e.preventDefault()} onClick={recorder.cancel}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

/** Over the field while what was heard waits there to be checked. */
export function TakeBar({ seconds, text, gender, onPlain }: { seconds: number; text: string; gender: VoiceGender; onPlain: () => void }) {
  return (
    <div className="compose-bar compose-voice">
      <MicIcon size={15} className="compose-bar-icon" />
      <span className="compose-bar-text">
        <b>{t("chats.voice.bar", { length: voiceLength(seconds) })}</b>
        <small>{t("chats.voice.barHint")}</small>
      </span>
      <button type="button" className="chip" disabled={!text.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => speak("voice-draft", text, gender)}>
        <PlayIcon size={12} />
        {t("chats.voice.play")}
      </button>
      <button type="button" className="compose-bar-close" aria-label={t("chats.voice.asText")} title={t("chats.voice.asText")} onMouseDown={(e) => e.preventDefault()} onClick={onPlain}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

