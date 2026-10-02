import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBackLayer, useSectionsBack } from "../lib/back.js";
import { chatsInOrder, getChatOrder } from "../lib/chatOrder.js";
import { summarize, totalUnread } from "../lib/conversations.js";
import { pairLink, reconnectNow, useLink } from "../lib/link.js";
import { useWide } from "../lib/layout.js";
import { back, focusOnMap, getNav, goSection, openConversation, setStack, shownConversation, topOf, useNav, type Nav, type Screen, type Section } from "../lib/nav.js";
import { useMeshTool, type MeshTool } from "../lib/meshTool.js";
import { isTauri } from "../lib/platform.js";
import { useSelector, useSession } from "../lib/session.js";
import { useSurveying } from "../lib/survey.js";
import { closeTool } from "../lib/toolActions.js";
import { toast } from "../lib/toast.js";
import { MenuHost, ToastHost } from "../ui/Menu.js";
import { ScreenBoundary } from "../ui/ErrorBoundary.js";
import { Sheet } from "../ui/Sheet.js";
import { Button } from "../ui/Button.js";
import { Prompt } from "../ui/Dialog.js";
import { ChannelView } from "./ChannelView.js";
import { ChannelWriters } from "./ChannelWriters.js";
import { ChatList, NEW_CHAT_EVENT } from "./ChatList.js";
import { ChatView, FIND_IN_CHAT_EVENT } from "./ChatView.js";
import { ChatIcon, NodesIcon, SearchIcon, SettingsIcon } from "./Icons.js";
import { MeshList, MeshMap, MeshPhone, useMeshAttention } from "./Mesh.js";
import { MessageView } from "./MessageView.js";
import { NodePageView } from "./node/NodePage.js";
import { Palette } from "./Palette.js";
import { Profile } from "./Profile.js";
import { RadioHome } from "./RadioHome.js";
import { RADIO_PARENTS, RadioPageView } from "./RadioPages.js";
import { CleanUpHost } from "./CleanUp.js";
import { SurveyStrip } from "./tools/Survey.js";
import { ToolPanel } from "./tools/ToolPanel.js";
import { UpdateButton } from "./Updates.js";
import type { Chrome } from "./ScreenHead.js";
import { t, type Key } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/** The label is a key, read while drawing: this table is made before the language is known. */
const SECTIONS: { id: Section; label: Key; icon: ReactNode }[] = [
  { id: "chats", label: "connect.tabs.chats", icon: <ChatIcon size={22} /> },
  { id: "mesh", label: "connect.tabs.mesh", icon: <NodesIcon size={22} /> },
  { id: "radio", label: "connect.tabs.settings", icon: <SettingsIcon size={22} /> },
];

export function Workspace() {
  const wide = useWide();
  useSectionsBack();
  return (
    <>
      {wide ? <Desktop /> : <Phone />}
      <MenuHost />
      <CleanUpHost />
      <ToastHost />
    </>
  );
}

/** One screen of any section, laid out the same wherever it is shown. */
function ScreenView({ screen, chrome, wide }: { screen: Screen; chrome: Chrome; wide: boolean }) {
  switch (screen.kind) {
    case "chat":
      return <ChatView key={screen.conversation} conversation={screen.conversation} chrome={chrome} />;
    case "message":
      return <MessageView conversation={screen.conversation} id={screen.id} chrome={chrome} />;
    case "channel":
      return <ChannelView index={screen.index} chrome={chrome} />;
    case "writers":
      return <ChannelWriters index={screen.index} chrome={chrome} />;
    case "profile":
      return <Profile key={screen.key} contactKey={screen.key} chrome={chrome} />;
    case "node":
      return <NodePageView key={`${screen.key}:${screen.page}`} contactKey={screen.key} page={screen.page} chrome={chrome} tabs={wide} />;
    case "radio":
      return <RadioPageView page={screen.page} chrome={chrome} />;
  }
}

/** The line that says the radio is gone, under every screen's header while it is. */
function Offline() {
  const state = useSession();
  const link = useLink();
  const [asking, setAsking] = useState(false);
  if (state.status === "ready") return null;
  return (
    <div className="offline" role="status">
      {link.phase === "connecting" && link.bluetoothOff ? (
        <>
          {/* Looked at again every couple of seconds; Try now may ask the phone to turn it on. */}
          <span className="offline-text">{t("connect.error.bluetoothOff")}</span>
          <Button size="sm" onClick={reconnectNow}>
            {t("connect.status.tryNow")}
          </Button>
        </>
      ) : link.phase === "connecting" ? (
        <>
          <span className="spinner" />
          <span className="offline-text">{link.attempt ? t("connect.status.reconnectingAttempt", { attempt: link.attempt }) : t("connect.status.reconnecting")}</span>
          {link.retrying ? (
            <Button size="sm" disabled={!link.waiting} onClick={reconnectNow}>
              {t("connect.status.tryNow")}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <span className="offline-text">{link.error ? t("connect.status.disconnectedWith", { error: link.error }) : t("connect.status.disconnected")}</span>
          {link.pair ? (
            <Button size="sm" onClick={() => setAsking(true)}>
              {t("connect.pair.button")}
            </Button>
          ) : link.phase === "failed" ? (
            <Button size="sm" onClick={reconnectNow}>
              {t("connect.status.reconnect")}
            </Button>
          ) : null}
        </>
      )}
      <PairPrompt open={asking} onDone={() => setAsking(false)} />
    </div>
  );
}

/** The PIN for a radio that wants a bond; any digits for a phone sharing its radio, which asks on its own screen. */
function PairPrompt({ open, onDone }: { open: boolean; onDone: () => void }) {
  return (
    <Prompt
      open={open}
      title={t("connect.pair.title")}
      label={t("connect.pair.label")}
      placeholder={t("connect.pair.placeholder")}
      submitLabel={t("connect.pair.submit")}
      onCancel={onDone}
      onSubmit={async (pin) => {
        try {
          await pairLink(pin);
          onDone();
        } catch (error) {
          toast(t("connect.pair.failed", { error: errorText(error) }), "error");
        }
      }}
    />
  );
}

function useBadges() {
  // Values rather than the state, so the phone's frame, and the screen in it, re-render only when a badge changes.
  const unread = useSelector(totalUnread);
  const offline = useSelector((state) => state.status !== "ready");
  return { unread, attention: useMeshAttention(), offline, surveying: useSurveying() };
}

/** Whether the card of the survey running is what the map shows, so the strip that leads to it would only repeat it. */
function surveyCardShown(tool: MeshTool | null): boolean {
  return tool?.kind === "survey" && tool.view === "run" && tool.point === null;
}

// ---- the phone: one screen at a time, the tabs below ----

function Phone() {
  const nav = useNav();
  const badges = useBadges();
  const tool = useMeshTool();
  const stack = nav.stacks[nav.section];
  const top = stack.at(-1) ?? null;
  // How a message travelled is a sheet over its conversation, not a screen of its own.
  const sheet = top?.kind === "message" ? top : null;
  const screens = sheet ? stack.slice(0, -1) : stack;
  const shown = screens.at(-1) ?? null;
  const content = useRef<HTMLElement>(null);
  const goBack = useEdgeSwipe(content, screens.length > 0 && !sheet);

  const [meshOpened, setMeshOpened] = useState(nav.section === "mesh");
  if (nav.section === "mesh" && !meshOpened) setMeshOpened(true);

  // A screen pushed within a section slides in over the one it covers; one from another section just appears.
  const last = useRef({ section: nav.section, depth: screens.length });
  const slide = last.current.section === nav.section && screens.length > last.current.depth;
  useEffect(() => {
    last.current = { section: nav.section, depth: screens.length };
  });

  // The root of a section, then its stack: the top one on screen, the one under it kept mounted for Back.
  const layers: { key: string; node: ReactNode }[] = [];
  if (nav.section === "chats") layers.push({ key: "root", node: <ChatList selected={null} /> });
  else if (nav.section === "radio") layers.push({ key: "root", node: <RadioHome selected={null} /> });
  screens.forEach((s, i) => {
    const key = `${i}:${JSON.stringify(s)}`;
    layers.push({ key, node: <ScreenView screen={s} chrome={{ onBack: goBack }} wide={false} /> });
  });
  const kept = layers.slice(-2);

  // The conversation takes the whole height: its composer sits where the tabs were.
  const tabs = shown?.kind !== "chat";
  // The screen under a conversation has the tabs, though, and they go and come with it: drawn
  // under the conversation as it slides in, and as a swipe back uncovers that screen.
  const underTabs = !tabs && (screens.length < 2 || screens[screens.length - 2]!.kind !== "chat");
  const tabbar = (className: string) => (
    <nav className={className} aria-label={t("connect.tabs.label")} {...(className === "tabbar" ? {} : { inert: true, "aria-hidden": true })}>
      {SECTIONS.map((s) => (
        <button key={s.id} type="button" className={nav.section === s.id ? "on" : ""} aria-current={nav.section === s.id ? "page" : undefined} onClick={() => goSection(s.id, nav.section === s.id)}>
          {s.icon}
          <span className="tab-label">{t(s.label)}</span>
          <Badge section={s.id} badges={badges} away={nav.section !== s.id} />
        </button>
      ))}
    </nav>
  );
  return (
    <div className={["app", "narrow", tabs ? "" : "detail"].join(" ")}>
      <main className="content" ref={content}>
        <Offline />
        {nav.section === "mesh" && shown === null && surveyCardShown(tool) ? null : <SurveyStrip />}
        {/* The map stays under a node's profile, and behind the other tabs once opened, so it comes back as it was left: same place, same list, no tiles to fetch again, no 86 rows to mount. */}
        {meshOpened ? (
          <ScreenBoundary>
            <MeshPhone hidden={nav.section !== "mesh" || shown !== null} />
          </ScreenBoundary>
        ) : null}
        {kept.map((l, i) => {
          const onTop = i === kept.length - 1;
          return (
            <div key={l.key} className={["layer", slide ? (onTop ? "enter" : "leave") : ""].join(" ")} data-layer={onTop ? "top" : "under"}>
              <ScreenBoundary onBack={l.key === "root" ? undefined : goBack}>{l.node}</ScreenBoundary>
            </div>
          );
        })}
        {underTabs ? tabbar(["tabbar", "under-tabs", slide ? "leave" : ""].join(" ")) : null}
        <div className="layer-dim" aria-hidden="true" />
      </main>
      {tabs ? tabbar("tabbar") : null}
      <Sheet open={sheet !== null} onClose={back} title={t("connect.sheet.travelled")}>
        {sheet ? <MessageView conversation={sheet.conversation} id={sheet.id} chrome={{}} bare /> : null}
      </Sheet>
    </div>
  );
}

function Badge({ section, badges, away }: { section: Section; badges: ReturnType<typeof useBadges>; away: boolean }) {
  if (section === "chats" && badges.unread > 0) return <span className="tab-badge">{badges.unread}</span>;
  // A survey running, from any other section: the map is where it is.
  if (section === "mesh" && badges.surveying && away) return <span className="tab-dot rec" title={t("tools.survey.nowTitle")} />;
  if (section === "mesh" && badges.attention) return <span className="tab-dot warn" title={t("connect.badge.attention")} />;
  if (section === "radio" && badges.offline) return <span className="tab-dot bad" title={t("connect.badge.offline")} />;
  return null;
}

const SLIDE_MS = 180;

/**
 * A swipe from the left edge goes back, as on iOS; Android's own back
 * gesture comes through the shell (see back.ts). The screen follows the
 * finger over the one below, and goes if let go past a third of the way.
 * Returns a Back for the header's button that slides the same way.
 */
function useEdgeSwipe(ref: React.RefObject<HTMLElement | null>, enabled: boolean): () => void {
  const slideOut = useRef<() => void>(back);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let active = false;
    let lifted = false;
    let leaving = false;
    let width = 1;
    let settling = 0;
    const top = () => el.querySelector<HTMLElement>(":scope > .layer[data-layer=top]");
    // Under the first screen in Mesh lies the map, kept mounted and hidden.
    const below = () => el.querySelector<HTMLElement>(":scope > .layer[data-layer=under]") ?? el.querySelector<HTMLElement>(":scope > .mesh-phone[hidden]");
    // Under a conversation the tabs go with the screen below.
    const under = () => [below(), el.querySelector<HTMLElement>(":scope > .under-tabs")].filter((box) => box !== null);
    const dim = () => el.querySelector<HTMLElement>(":scope > .layer-dim");
    // Each screen by its own transform and the dim by its opacity: a move restyles those few
    // boxes and paints nothing. A value the screen below inherited restyled all of it on every move.
    const place = (t: HTMLElement, u: HTMLElement[], dx: number) => {
      const p = Math.min(1, dx / width);
      t.style.transform = `translateX(${dx}px)`;
      for (const box of u) box.style.transform = `translateX(${-30 * (1 - p)}%)`;
      const d = dim();
      if (d) d.style.opacity = String(0.3 * (1 - p));
    };
    const lift = (t: HTMLElement, u: HTMLElement[]) => {
      // Their own layers while they move: a whole screen repainted on every touch move drops frames.
      // A screen still settling back from the last swipe is taken up again, not let go under the finger.
      clearTimeout(settling);
      width = el.clientWidth || 1;
      for (const box of [t, ...u, dim()]) {
        if (box) box.style.transition = "none";
      }
      t.classList.add("moving");
      for (const box of u) box.classList.add("peek");
      dim()?.classList.add("on");
    };
    const settle = (t: HTMLElement, u: HTMLElement[]) => {
      t.classList.remove("moving");
      for (const box of u) box.classList.remove("peek");
      dim()?.classList.remove("on");
      for (const box of [t, ...u, dim()]) {
        if (box) box.style.transform = box.style.opacity = box.style.transition = "";
      }
    };
    const finish = (t: HTMLElement, u: HTMLElement[], go: boolean) => {
      for (const box of [t, ...u]) box.style.transition = `transform ${SLIDE_MS}ms ease-out`;
      const d = dim();
      if (d) d.style.transition = `opacity ${SLIDE_MS}ms ease-out`;
      place(t, u, go ? width : 0);
      leaving = go;
      settling = window.setTimeout(() => {
        settle(t, u);
        leaving = false;
        // In the same task as the clean-up, so no frame shows the old screen back in place.
        if (go) back();
      }, SLIDE_MS);
    };
    slideOut.current = () => {
      const t = top();
      if (!t || leaving || matchMedia("(prefers-reduced-motion: reduce)").matches) return back();
      const u = under();
      lift(t, u);
      place(t, u, 0);
      // One frame at the start, so the slide has somewhere to slide from.
      requestAnimationFrame(() => finish(t, u, true));
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = !leaving && t && t.clientX < 24 && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
      active = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      const layer = top();
      if (!start || !t || !layer) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!active) {
        // Lifted at the first move from the edge, before the swipe is sure: the screens get their
        // own layers, and the one below is painted, while the finger covers the first pixels.
        if (!lifted) {
          lift(layer, under());
          place(layer, under(), 0);
          lifted = true;
        }
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (dx < 0 || Math.abs(dy) > Math.abs(dx)) {
          start = null;
          lifted = false;
          settle(layer, under());
          return;
        }
        active = true;
      }
      e.preventDefault();
      place(layer, under(), Math.max(0, dx));
    };
    const up = (e: TouchEvent) => {
      const layer = top();
      if (!active || !start) {
        if (lifted && layer) settle(layer, under());
        start = null;
        lifted = false;
        return;
      }
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : 0;
      start = null;
      active = false;
      lifted = false;
      if (layer) finish(layer, under(), dx > width / 3);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      slideOut.current = back;
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [ref, enabled]);
  return useRef(() => slideOut.current()).current;
}

// ---- the desktop: the list, what was picked in it, and a panel of details ----

/** How a desktop lays a section's stack out. */
function layout(nav: Nav) {
  const stack = nav.stacks[nav.section];
  const top = topOf(nav);
  if (nav.section === "chats") {
    const chat = stack.find((s): s is Extract<Screen, { kind: "chat" }> => s.kind === "chat") ?? null;
    const full = top?.kind === "node" ? top : null;
    const panel = !full && top && top.kind !== "chat" ? top : null;
    return { chat, full, panel, panelDepth: stack.filter((s) => s.kind !== "chat").length };
  }
  if (nav.section === "mesh") {
    const full = top?.kind === "node" ? top : null;
    const panel: Screen | null = full ? null : top ?? (nav.meshFocus ? { kind: "profile", key: nav.meshFocus } : null);
    return { chat: null, full, panel, panelDepth: stack.length };
  }
  return { chat: null, full: null, panel: null, panelDepth: 0 };
}

function Desktop() {
  const nav = useNav();
  const badges = useBadges();
  const [palette, setPalette] = useState(false);
  const [group, setGroup] = useState<string[] | null>(null);
  const tool = useMeshTool();
  const { chat, full, panel, panelDepth } = layout(nav);
  const radioPage = nav.section === "radio" ? (topOf(nav)?.kind === "radio" ? (topOf(nav) as Extract<Screen, { kind: "radio" }>).page : "name") : null;

  const closePanel = () => {
    if (nav.section === "chats") setStack("chats", chat ? [chat] : []);
    else setStack("mesh", [], { meshFocus: null });
  };
  const togglePanel = () => {
    if (nav.section !== "chats" || !chat) return;
    if (panel) return closePanel();
    const target = chat.conversation.startsWith("ch:") ? { kind: "channel" as const, index: Number(chat.conversation.slice(3)) } : chat.conversation.startsWith("c:") ? { kind: "profile" as const, key: chat.conversation.slice(2) } : null;
    if (target) setStack("chats", [chat, target]);
  };

  // A tool on the map takes the panel while it is open, over a profile; a screen opened from the tool, a profile, covers it until it closes.
  const toolPanel = nav.section === "mesh" && !full && tool && nav.stacks.mesh.length === 0 ? tool : null;
  // A tool on the map puts itself away first, back to where it was opened from.
  useDesktopKeys({ openPalette: () => setPalette(true), togglePanel, escape: full ? back : toolPanel ? closeTool : panel ? closePanel : null });

  let list: ReactNode;
  let main: ReactNode;
  if (nav.section === "chats") {
    list = <ChatList selected={chat?.conversation ?? null} />;
    main = full ? (
      <ScreenView screen={full} chrome={{ onBack: back }} wide />
    ) : chat ? (
      <ChatView key={chat.conversation} conversation={chat.conversation} chrome={{}} infoOpen={panel !== null} onInfo={togglePanel} />
    ) : (
      <Empty>{t("connect.empty.pickChat")}</Empty>
    );
  } else if (nav.section === "mesh") {
    const focus = panel?.kind === "profile" ? panel.key : full?.key ?? nav.meshFocus;
    list = <MeshList selected={focus ?? null} onOpen={(key) => { setGroup(null); setStack("mesh", [], { meshFocus: key }); }} />;
    main = full ? (
      <ScreenView screen={full} chrome={{ onBack: back }} wide />
    ) : (
      <MeshMap
        selected={focus ?? null}
        zoomButtons
        onSelect={(key) => {
          setGroup(null);
          if (key) setStack("mesh", [], { meshFocus: key });
          else focusOnMap(null);
        }}
        onGroup={(keys) => {
          setGroup(keys);
          setStack("mesh", [], { meshFocus: null });
        }}
      />
    );
  } else {
    // A page opened from another page keeps its parent picked in the list, and goes back to it.
    const parent = radioPage ? RADIO_PARENTS[radioPage] : undefined;
    list = <RadioHome selected={parent ?? radioPage} />;
    main = <RadioPageView page={radioPage ?? "name"} chrome={parent ? { onBack: back } : {}} />;
  }

  const panelChrome: Chrome = { onClose: closePanel, onBack: panelDepth > 1 ? back : undefined };
  const groupPanel = nav.section === "mesh" && !panel && !full && group ? <GroupPanel keys={group} onClose={() => setGroup(null)} /> : null;
  useBackLayer(groupPanel !== null, () => setGroup(null));
  useBackLayer(toolPanel !== null, closeTool);

  return (
    <div className="app wide">
      <nav className="rail" aria-label={t("connect.tabs.label")}>
        <button type="button" className="rail-search" title={t("connect.rail.search")} onClick={() => setPalette(true)}>
          <SearchIcon size={18} />
        </button>
        {SECTIONS.map((s, i) => (
          <button key={s.id} type="button" className={nav.section === s.id ? "on" : ""} aria-current={nav.section === s.id ? "page" : undefined} title={`${t(s.label)} · ${isTauri() ? "Ctrl" : "Alt"}+${i + 1}`} onClick={() => goSection(s.id)}>
            {s.icon}
            <span className="tab-label">{t(s.label)}</span>
            <Badge section={s.id} badges={badges} away={nav.section !== s.id} />
          </button>
        ))}
        <span className="grow" />
        <UpdateButton compact />
      </nav>
      <aside className="pane">{list}</aside>
      <main className="content">
        <Offline />
        {toolPanel && surveyCardShown(toolPanel) ? null : <SurveyStrip />}
        <ScreenBoundary key={`${nav.section}:${JSON.stringify(full ?? chat)}`}>{main}</ScreenBoundary>
      </main>
      {toolPanel ? (
        <aside className="panel">
          <div className="screen tool-screen">
            <ToolPanel tool={toolPanel} />
          </div>
        </aside>
      ) : panel && !full ? (
        <aside className="panel">
          <ScreenBoundary key={JSON.stringify(panel)} onBack={closePanel}>
            <ScreenView screen={panel} chrome={panelChrome} wide />
          </ScreenBoundary>
        </aside>
      ) : (
        groupPanel
      )}
      <Palette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

function GroupPanel({ keys, onClose }: { keys: string[]; onClose: () => void }) {
  return (
    <aside className="panel">
      <div className="screen">
        <header className="screen-head">
          <div className="screen-title">
            <span className="screen-name">{t("connect.group.title", { count: keys.length })}</span>
          </div>
          <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </header>
        <MeshList selected={null} head={false} onOpen={(key) => { onClose(); setStack("mesh", [], { meshFocus: key }); }} only={keys} />
      </div>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty muted">{children}</div>;
}

/**
 * The desktop's keys. Ctrl+1–9 and Ctrl+N belong to a browser, so there the
 * sections are Alt+1–3 and a new chat is in the palette; the desktop shell
 * has both.
 */
function useDesktopKeys({ openPalette, togglePanel, escape }: { openPalette: () => void; togglePanel: () => void; escape: (() => void) | null }) {
  const state = useSession();
  const latest = useRef({ openPalette, togglePanel, escape, state });
  latest.current = { openPalette, togglePanel, escape, state };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("dialog[open], .sheet-layer, .palette-layer, .popover")) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const { openPalette, togglePanel, escape, state } = latest.current;
      if (mod && key === "k") {
        e.preventDefault();
        openPalette();
      } else if ((e.altKey || (mod && isTauri())) && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        goSection(SECTIONS[Number(e.key) - 1]!.id);
      } else if (mod && key === "n" && isTauri()) {
        e.preventDefault();
        goSection("chats");
        setTimeout(() => window.dispatchEvent(new Event(NEW_CHAT_EVENT)));
      } else if (mod && key === "f") {
        // With a chat open, its own search (#42); pressed again there, the list's field, which searches every chat.
        const inChat = document.activeElement?.hasAttribute("data-chat-find") ?? false;
        const find = document.querySelector<HTMLInputElement>(".pane [data-find]");
        if (!inChat && getNav().section === "chats" && shownConversation(getNav(), true)) {
          e.preventDefault();
          window.dispatchEvent(new Event(FIND_IN_CHAT_EVENT));
        } else if (find) {
          e.preventDefault();
          find.focus();
          find.select();
        }
      } else if (mod && key === "i") {
        e.preventDefault();
        togglePanel();
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const rows = chatsInOrder(summarize(state), getChatOrder());
        const index = rows.findIndex((r) => r.id === shownConversation({ ...getNav(), section: "chats" }, true));
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) openConversation(next.id);
      } else if (e.key === "Escape" && escape) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, select")) return;
        e.preventDefault();
        escape();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
