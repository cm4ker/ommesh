/**
 * The microphone beside the message field (#89), in every chat once voice
 * input is on. Clicked, it listens until clicked again; held, until let go;
 * Esc turns it off and drops what is not heard yet. What is said goes into
 * the field phrase by phrase, where the caret is, while it is said.
 */

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { startListening, type Listening } from "../lib/voiceInput.js";
import { toast } from "../lib/toast.js";
import { MicIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/** A press shorter than this was a click: the microphone stays on until the next one. */
const CLICK_MS = 400;

/** Off; reading the model in; listening; hearing the last phrase after it went off. */
export type MicPhase = "idle" | "starting" | "listening" | "finishing";

export interface Mic {
  phase: MicPhase;
  /** How loud it is, 0 to 1, for the ring round the button. */
  level: number;
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
        toast(error instanceof DOMException && error.name === "NotAllowedError" ? t("chats.voice.micDenied") : errorText(error), "error");
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

  // The ring breathes with the voice.
  useEffect(() => {
    if (phase !== "listening") {
      setLevel(0);
      return;
    }
    const timer = setInterval(() => setLevel(listening.current?.level() ?? 0), 100);
    return () => clearInterval(timer);
  }, [phase]);

  // Leaving the chat lets the microphone go.
  useEffect(() => () => cancel(), []);

  return {
    phase,
    level,
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

export function MicButton({ mic }: { mic: Mic }) {
  const on = mic.phase === "listening";
  const busy = mic.phase === "starting" || mic.phase === "finishing";
  return (
    <button
      type="button"
      className={["compose-mic", on ? "on" : ""].join(" ")}
      aria-label={on ? t("chats.voice.stop") : t("chats.voice.start")}
      aria-pressed={on}
      disabled={mic.phase === "finishing"}
      title={on ? t("chats.voice.stop") : t("chats.voice.start")}
      style={{ "--level": Math.min(1, mic.level * 3) } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      {...mic.press}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : <MicIcon size={19} />}
    </button>
  );
}
