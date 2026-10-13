/**
 * The microphone beside the message field (#89), in every chat once voice
 * input is on: a round button like the send one beside it. Clicked, it
 * listens until clicked again; held, until let go; Esc turns it off and drops
 * what is not heard yet. What is said goes into the field phrase by phrase,
 * where the caret is, while it is said.
 *
 * Made to be read at a glance: while it listens the button is red with a
 * ring that breathes with the voice, and a line over the field says whether
 * it listens or is writing a phrase down, for how long, and, near the end of
 * a quiet, how soon it turns itself off.
 */

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { QUIET_SECONDS, startListening, type Heard, type Listening } from "../lib/voiceInput.js";
import { toast } from "../lib/toast.js";
import { MicIcon, StopIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/** A press shorter than this was a click: the microphone stays on until the next one. */
const CLICK_MS = 400;
/** The last seconds of a quiet are counted down on the button and over the field. */
const WARN_SECONDS = 5;
/** How many recent loudnesses the bars over the field show. */
const BARS = 7;

/** Off; reading the model in; listening; hearing the last phrase after it went off. */
export type MicPhase = "idle" | "starting" | "listening" | "finishing";

export interface Mic {
  phase: MicPhase;
  /** How loud it is, 0 to 1, for the ring round the button. */
  level: number;
  /** The last few loudnesses, oldest first, for the bars over the field. */
  levels: number[];
  heard: Heard;
  /** Seconds since it began to listen. */
  seconds: number;
  /** Turns it off and writes in what was said last. */
  stop: () => void;
  /** Turns it off and drops what is not heard yet. */
  cancel: () => void;
  press: {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  };
}

/** `before` says what the field holds before the caret; `put` writes a phrase in. */
export function useMic(before: () => string, put: (text: string) => void): Mic {
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [level, setLevel] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [heard, setHeard] = useState<Heard>({ speaking: false, recognising: false, quietLeft: QUIET_SECONDS });
  const [seconds, setSeconds] = useState(0);
  const listening = useRef<Listening | null>(null);
  // A turn started and not yet given its handle: a click that ends it waits for it.
  const starting = useRef<Promise<Listening | null> | null>(null);
  const pressed = useRef<{ at: number; started: boolean } | null>(null);
  const said = useRef(put);
  said.current = put;

  const start = () => {
    if (listening.current || starting.current) return;
    setPhase("starting");
    const turn = startListening({
      before: before(),
      onPhrase: (text) => said.current(text),
      onQuiet: () => void stop(),
      onError: (error) => {
        listening.current = null;
        setPhase("idle");
        toast(errorText(error), "error");
      },
    }).then(
      (handle) => {
        listening.current = handle;
        setPhase("listening");
        return handle;
      },
      (error: unknown) => {
        setPhase("idle");
        toast(denied(error) ? t("chats.voice.micDenied") : errorText(error), "error");
        return null;
      },
    );
    starting.current = turn;
    void turn.finally(() => {
      if (starting.current === turn) starting.current = null;
    });
  };

  const stop = async () => {
    const handle = listening.current ?? (await starting.current);
    if (!handle || listening.current !== handle) return;
    listening.current = null;
    setPhase("finishing");
    try {
      await handle.stop();
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setPhase("idle");
    }
  };

  const cancel = () => {
    const handle = listening.current;
    listening.current = null;
    handle?.cancel();
    // One still starting is let go as soon as it has started.
    void starting.current?.then((late) => {
      if (late && listening.current === late) {
        listening.current = null;
        late.cancel();
      }
    });
    setPhase("idle");
  };

  // The ring and the bars breathe with the voice; the clock runs.
  useEffect(() => {
    if (phase !== "listening") {
      setLevel(0);
      setLevels(Array(BARS).fill(0));
      setSeconds(0);
      return;
    }
    const began = Date.now();
    const timer = setInterval(() => {
      const handle = listening.current;
      const now = handle?.level() ?? 0;
      setLevel(now);
      setLevels((was) => [...was.slice(1), now]);
      if (handle) setHeard(handle.heard());
      setSeconds((Date.now() - began) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, [phase]);

  // Leaving the chat lets the microphone go.
  useEffect(() => () => cancel(), []);

  return {
    phase,
    level,
    levels,
    heard,
    seconds,
    stop: () => void stop(),
    cancel,
    press: {
      onPointerDown: (e) => {
        if (e.button !== 0 || phase === "finishing") return;
        const on = listening.current !== null || starting.current !== null;
        pressed.current = { at: Date.now(), started: !on };
        if (!on) start();
      },
      onPointerUp: () => {
        const p = pressed.current;
        pressed.current = null;
        if (!p) return;
        // A second press ends it, and so does letting go of a long one.
        if (!p.started || Date.now() - p.at >= CLICK_MS) void stop();
      },
      onClick: (e) => {
        // From the keyboard, with no pointer: one press starts, the next ends.
        if (e.detail !== 0) return;
        if (listening.current || starting.current) void stop();
        else start();
      },
    },
  };
}

/** The microphone refused at the system's prompt. */
function denied(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

/** Seconds left of a quiet, once few enough to be counted down; null before. */
function countdown(mic: Mic): number | null {
  const { speaking, recognising, quietLeft } = mic.heard;
  return mic.phase === "listening" && !speaking && !recognising && quietLeft <= WARN_SECONDS ? Math.max(1, Math.ceil(quietLeft)) : null;
}

export function MicButton({ mic }: { mic: Mic }) {
  const on = mic.phase === "listening";
  const busy = mic.phase === "starting" || mic.phase === "finishing";
  const left = countdown(mic);
  const label = on ? t("chats.voice.stop") : t("chats.voice.start");
  return (
    <button
      type="button"
      className={["compose-mic", on || mic.phase === "finishing" ? "on" : "", left !== null ? "ending" : ""].join(" ")}
      aria-label={label}
      aria-pressed={on}
      disabled={mic.phase === "finishing"}
      title={label}
      style={{ "--level": Math.min(1, mic.level * 3), "--left": left === null ? 1 : mic.heard.quietLeft / WARN_SECONDS } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      {...mic.press}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : on ? <StopIcon size={18} /> : <MicIcon size={18} />}
    </button>
  );
}

/** The line over the field while the microphone is on: what it does now, for how long, and how soon it stops. */
export function ListenBar({ mic }: { mic: Mic }) {
  const writing = mic.phase === "finishing" || mic.heard.recognising;
  const left = countdown(mic);
  const minutes = Math.floor(mic.seconds / 60);
  const clock = minutes + ":" + String(Math.floor(mic.seconds % 60)).padStart(2, "0");
  return (
    <div className="compose-bar listen-bar" role="status">
      {writing || mic.phase === "starting" ? <span className="spinner" aria-hidden="true" /> : <i className="listen-dot" aria-hidden="true" />}
      <b className="listen-what">{mic.phase === "starting" ? t("chats.voice.starting") : writing ? t("chats.voice.writing") : t("chats.voice.listening")}</b>
      {mic.phase === "listening" ? <span className="listen-clock">{clock}</span> : null}
      <span className="listen-gap" />
      {left !== null ? (
        <span className="listen-left">{t("chats.voice.offIn", { seconds: left })}</span>
      ) : mic.phase === "listening" ? (
        <span className="listen-bars" aria-hidden="true">
          {mic.levels.map((value, i) => (
            <i key={i} style={{ transform: "scaleY(" + (0.2 + 0.8 * Math.min(1, value * 3)) + ")" }} />
          ))}
        </span>
      ) : null}
    </div>
  );
}
