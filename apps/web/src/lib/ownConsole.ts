import { useEffect, useState } from "react";
import { session, useSession } from "./session.js";

/**
 * SmartUI radios keep protocol 13 but answer the console command, and say so in their custom
 * vars (`smartui_cli:1`). Asked once per radio while the app runs, by the radio's key.
 */
const smartUi = new Map<string, boolean>();

/**
 * Whether the connected radio runs console lines of its own: protocol 14 says so, or a SmartUI
 * radio's custom vars. Where neither does, Radio console is shown nowhere, the palette included.
 */
export function useOwnConsole(): boolean {
  const state = useSession();
  const key = state.self?.key ?? null;
  const verCode = state.device?.firmwareVerCode ?? 0;
  const ready = state.status === "ready";
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!ready || !key || verCode >= 14 || smartUi.has(key)) return;
    let live = true;
    session
      .customVars()
      .then((vars) => smartUi.set(key, vars.smartui_cli === "1"))
      // An older radio without custom vars refuses the question; that is a no.
      .catch(() => smartUi.set(key, false))
      .finally(() => live && redraw((n) => n + 1));
    return () => {
      live = false;
    };
  }, [ready, key, verCode]);
  return verCode >= 14 || (key !== null && smartUi.get(key) === true);
}
