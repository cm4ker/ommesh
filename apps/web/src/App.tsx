import { Fragment, useEffect } from "react";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { ConnectView } from "./components/connect/ConnectView.js";
import { Workspace } from "./components/Workspace.js";
import { UpdatesDialog } from "./components/Updates.js";
import { NoticeBanner } from "./components/NoticeBanner.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "./lib/geo.js";
import { useLink } from "./lib/link.js";
import { t, useLanguage, type Key } from "./i18n/index.js";
import { errorText } from "./i18n/errors.js";
import { ALL_CHATS, createAnnouncer } from "./lib/announce.js";
import { getNoticePrefs, messageWanted, nodeWanted, subscribeNoticePrefs } from "./lib/noticePrefs.js";
import { noteUnread } from "./lib/firstUnread.js";
import { askPermissionOnce, notify, onCardAction, onNotificationClick, pageOnScreen, tellChannels, withdraw } from "./lib/notify.js";
import { quickReply } from "./lib/quickReply.js";
import { toast } from "./lib/toast.js";
import { session, useSelector } from "./lib/session.js";
import { startTray } from "./lib/tray.js";
import { startCoreWatch } from "./lib/coreWatch.js";
import { startTidyRule } from "./lib/cleanUp.js";
import { startFollowPhone } from "./lib/followPhone.js";
import { startShareIn } from "./lib/shareIn.js";
import { isWide, subscribeWide } from "./lib/layout.js";
import { getNav, openConversation, openProfile, shownConversation, subscribeNav } from "./lib/nav.js";

const NEW: Record<number, Key> = {
  [AdvType.Chat]: "notices.newContact",
  [AdvType.Repeater]: "notices.newRepeater",
  [AdvType.Room]: "notices.newRoom",
  [AdvType.Sensor]: "notices.newSensor",
};

/** "Heard for the first time", and how far and which way when both positions are known. */
function discoveredBody(contact: ContactRecord): string {
  const self = session.getState().self;
  if (self && hasPosition(self.lat, self.lon) && hasPosition(contact.lat, contact.lon)) {
    const km = distanceKm(self.lat, self.lon, contact.lat, contact.lon);
    const heading = compass(bearingDeg(self.lat, self.lon, contact.lat, contact.lon));
    return t("notices.heardFirstAt", { distance: formatDistance(km), direction: heading });
  }
  return t("notices.heardFirst");
}

export function App() {
  // Two facts, not the whole state: the root re-rendering would re-render every screen.
  const status = useSelector((state) => state.status);
  const known = useSelector((state) => state.self !== null);
  const link = useLink();
  const language = useLanguage();

  // The conversation on screen is read as its messages arrive. Behind another
  // window or app, or on a locked phone, it is not, and they are announced.
  useEffect(() => {
    const update = () => {
      const conversation = pageOnScreen() ? shownConversation(getNav(), isWide()) : null;
      noteUnread(conversation, conversation ? (session.getState().unread[conversation] ?? 0) : 0);
      session.focus(conversation);
    };
    update();
    const stopNav = subscribeNav(update);
    const stopWide = subscribeWide(update);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      stopNav();
      stopWide();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  // Messages the radio hands over, as notices grouped by conversation (see
  // announce.ts). Watched here, once, rather than in a view that may not be mounted.
  useEffect(() => {
    const announcer = createAnnouncer({
      state: () => session.getState(),
      wanted: (message) => messageWanted(getNoticePrefs(), session.getState(), message),
      show: (notice) => void notify(notice),
      withdraw: (tag) => void withdraw(tag),
    });
    const stopReceived = session.onReceived((message) => announcer.received(message));
    const stopChanged = session.subscribe(() => announcer.changed());
    const front = () => {
      if (pageOnScreen()) announcer.opened();
    };
    document.addEventListener("visibilitychange", front);
    window.addEventListener("focus", front);
    return () => {
      stopReceived();
      stopChanged();
      document.removeEventListener("visibilitychange", front);
      window.removeEventListener("focus", front);
    };
  }, []);

  // The desktop's tray icon shows whether anything is unread, and from whom.
  useEffect(() => startTray(() => session.getState(), (listener) => session.subscribe(listener)), []);

  // The phone's radio core announces what arrives while the page sleeps, in the page's words and names.
  useEffect(() => startCoreWatch(() => session.getState(), (listener) => session.subscribe(listener)), []);

  // A node the radio hears for the first time.
  useEffect(
    () =>
      session.onDiscovered((contact) => {
        if (!nodeWanted(getNoticePrefs(), contact.type)) return;
        const name = contact.name || contact.prefix;
        void notify({ title: t(NEW[contact.type] ?? "notices.newNode", { name }), body: discoveredBody(contact), tag: `n:${contact.key}`, kind: "nodes", face: { name, type: contact.type } });
      }),
    [],
  );

  // The tidy-up rule, when it is on for the radio: it runs while the radio is connected, whatever is on screen.
  useEffect(() => startTidyRule(), []);

  // Following the phone (#34), when it is on for the radio: its position moves after the phone while the app is open.
  useEffect(() => startFollowPhone(), []);

  // What other apps share to this one (#88), waiting over the chat list for a chat.
  useEffect(() => startShareIn(), []);

  // A click on a notice opens what it was about.
  useEffect(() => {
    onNotificationClick((tag) => {
      if (tag === ALL_CHATS) openConversation(null);
      else if (tag.startsWith("c:")) openConversation(tag.slice(2));
      else if (tag.startsWith("n:")) openProfile(tag.slice(2), true);
    });
  }, []);

  // A reply typed into one of the desktop's own cards, or "Mark read" there.
  useEffect(
    () =>
      onCardAction((act) => {
        const conversation = act.tag.slice(2);
        if (act.action === "read") session.markRead(conversation);
        else quickReply(conversation, act.text).catch((error: Error) => toast(errorText(error), "error"));
      }),
    [],
  );

  // Android's notification channels ring with the reader's sounds, from the start; a chat's kind is known once its contact is.
  useEffect(() => {
    const tell = () => void tellChannels(session.getState());
    tell();
    const stopPrefs = subscribeNoticePrefs(tell);
    const stopSession = session.subscribe(tell);
    return () => {
      stopPrefs();
      stopSession();
    };
  }, []);

  // A phone may end the app in the background without a word, and history is
  // saved a moment after it changes: on the way out it is saved at once.
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === "hidden") void session.flush().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", away);
    return () => document.removeEventListener("visibilitychange", away);
  }, []);

  // Back on screen, the queue is read again: a phone suspends the page in the
  // background, and a "message waiting" push that arrived meanwhile may never
  // reach it. Reading an empty queue costs one short exchange.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "visible" || session.getState().status !== "ready") return;
      session.syncMessages().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);

  // The phone asks for permission the first time a radio is connected.
  const ready = status === "ready";
  useEffect(() => {
    if (ready) void askPermissionOnce();
  }, [ready]);

  // A dropped link keeps the chats on screen, the attempts to get it back included:
  // the session keeps the radio and its history while it connects again. A radio
  // asked for after a disconnect is connected from the connect screen, which shows how it goes.
  const showWorkspace = status === "ready" || (link.dropped && known && link.phase !== "idle");
  // A new language redraws every screen: a word made before the change would stay in the old one.
  return <Fragment key={language}>{showWorkspace ? <Workspace /> : <ConnectView />}<UpdatesDialog /><NoticeBanner /></Fragment>;
}
