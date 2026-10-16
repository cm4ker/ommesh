import { useEffect, type RefObject } from "react";
import { type SessionState } from "@meshnet/meshcore";
import { canOpenAnother } from "../lib/instance.js";
import { useOwnConsole } from "../lib/ownConsole.js";
import { relayAvailable, relayWanted } from "../lib/relay.js";
import { useSession } from "../lib/session.js";
import { findSettings, flashDone, flashFor, openSetting, settingName, settingPlace, type Setting, type SettingContext } from "../lib/settingsSearch.js";
import type { RadioPage } from "../lib/nav.js";
import { Group, LinkRow } from "../ui/List.js";
import { marked } from "./Marked.js";
import { t } from "../i18n/index.js";

/** What this radio and this app offer, for which settings there are to find. */
export function useSettingContext(): SettingContext {
  const state = useSession();
  const console = useOwnConsole();
  return {
    device: state.device,
    wifi: state.wifi != null,
    console,
    share: relayAvailable() && state.link?.kind === "ble",
    sharedSettings: (relayAvailable() && state.link?.kind === "ble" && relayWanted()) || state.peer === "computer",
    another: canOpenAnother(),
    maxTxPower: state.self?.maxTxPower ?? null,
  };
}

/** What a few settings are set to now, as their rows say it; the rest show none. */
function settingValue(s: Setting, state: SessionState): string | undefined {
  if (s.label === "radio.name.name") return state.self?.name;
  if (s.label === "radio.frequency.txPower") return state.self ? String(state.self.txPower) : undefined;
  if (s.label === "radio.region.title") return state.region ? (state.region.name ?? t("radio.region.none")) : undefined;
  if (s.label === "radio.advanced.firmware") return state.device?.firmwareVersion;
  if (s.page === "pin" && !s.label && state.device) return state.device.blePin ? t("radio.connection.blePinValue", { pin: String(state.device.blePin).padStart(6, "0") }) : t("radio.connection.blePinRandom");
  if (s.page === "wifi" && !s.label && state.wifi) return !state.wifi.enabled ? t("radio.connection.wifiOff") : (state.wifi.ip ?? t("radio.connection.wifiAway"));
  return undefined;
}

/** The settings a query finds, in place of the Settings list; a tap opens one. */
export function SettingsResults({ query }: { query: string }) {
  const state = useSession();
  const ctx = useSettingContext();
  const found = findSettings(query, ctx);
  if (found.length === 0) return <div className="empty muted">{t("radio.search.nothing")}</div>;
  return (
    <Group>
      {found.map((s) => (
        <LinkRow key={`${s.page}:${s.label ?? s.group ?? ""}`} label={marked(settingName(s, ctx), query)} hint={settingPlace(s) || undefined} value={settingValue(s, state)} onClick={() => openSetting(s, ctx)} />
      ))}
    </Group>
  );
}

/** How long a found setting stays lit. */
const FLASH_MS = 2000;
/** A page that draws its rows once the radio has answered gets this long to show the one asked for. */
const FIND_FOR_MS = 1500;

/**
 * Lights the setting a search opened this page for: the row, field or group
 * that carries its name is brought to the middle and lit for a moment.
 */
export function useSettingFlash(page: RadioPage, scroller: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const text = flashFor(page);
    if (!text) return;
    let lit: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    let frame = requestAnimationFrame(function look() {
      const target = findTarget(scroller.current, text);
      if (!target) {
        if (Date.now() - started < FIND_FOR_MS) frame = requestAnimationFrame(look);
        return;
      }
      flashDone();
      target.scrollIntoView({ block: "center" });
      target.classList.add("setting-flash");
      lit = target;
      timer = setTimeout(() => target.classList.remove("setting-flash"), FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      lit?.classList.remove("setting-flash");
    };
  }, [page, scroller]);
}

/** The row, field or group on the page whose label reads `text`. */
function findTarget(root: HTMLElement | null, text: string): Element | null {
  if (!root) return null;
  const labels = root.querySelectorAll(".line-text > span:first-child, .field-label, .group-title");
  for (const label of labels) {
    if (label.textContent?.trim() !== text) continue;
    if (label.classList.contains("group-title")) return label.closest(".group");
    return label.closest(".line, .field") ?? label;
  }
  return null;
}
