/**
 * What the phone's radio core (`crates/meshcore-core`, behind `MeshRelay`)
 * needs to announce messages while the page sleeps: the reader's notice
 * settings (noticePrefs.ts) and the names of this radio, its contacts and its
 * channels, so that its notices read as the page's own do, and the words they
 * are said in, in the reader's language. Sent whenever any of them changes;
 * the native side keeps the last for a start without the page. Android takes
 * its own words from here too: the radio's ongoing notice and the names of the
 * notice channels (`Words.java`).
 */

import { isFavourite, type SessionState } from "@meshnet/meshcore";
import { forms, language, pluralTable, subscribeLanguage, t, template } from "../i18n/index.js";
import { signalFile } from "./chime.js";
import { getNoticePrefs, subscribeNoticePrefs } from "./noticePrefs.js";
import { tellChannels } from "./notify.js";
import { quietSpans } from "./quiet.js";
import { configureCore, relayAvailable } from "./relay.js";

/** The core's words (`Words` in `watch.rs`), placeholders unfilled, and Android's (`Words.java`), filled but for `{name}`. */
function words() {
  return {
    newContact: template("notices.newContact"),
    newRepeater: template("notices.newRepeater"),
    newRoom: template("notices.newRoom"),
    newSensor: template("notices.newSensor"),
    newNode: template("notices.newNode"),
    heardFirst: t("notices.heardFirst"),
    unknown: template("notices.unknown"),
    channel: template("notices.channel"),
    keyless: t("notices.keyless"),
    mentioned: template("notices.mentioned"),
    mentionedIn: template("notices.mentionedIn"),
    inChat: template("notices.inChat"),
    chatNew: forms("notices.chatNew"),
    chatNewMentioned: forms("notices.chatNewMentioned"),
    allChats: template("notices.allChats"),
    newMessages: forms("notices.newMessages"),
    inChats: forms("notices.inChats"),
    surveyTitle: template("notices.survey.title"),
    surveyPoints: forms("tools.survey.points"),
    surveyHeard: forms("tools.survey.heard"),
    surveyNobody: t("notices.survey.nobody"),
    surveyStill: t("notices.survey.still"),
    surveyGps: t("tools.survey.gps"),
    surveyListening: t("tools.survey.listening"),
    surveyOffline: t("notices.survey.offline"),
    repeater: template("tools.hears.repeater"),
    plurals: pluralTable(),
    relayChannel: t("notices.android.relayChannel"),
    relayChannelHint: t("notices.android.relayChannelHint"),
    relayTheRadio: t("notices.android.relayTheRadio"),
    relayReconnecting: template("notices.android.relayReconnecting"),
    relayWaitingRadio: t("notices.android.relayWaitingRadio"),
    relaySharing: template("notices.android.relaySharing"),
    relayComputer: t("notices.android.relayComputer"),
    relayWaitingComputer: t("notices.android.relayWaitingComputer"),
    relayConnected: template("notices.android.relayConnected"),
    relayAppClosed: t("notices.android.relayAppClosed"),
    relaySurvey: t("notices.android.relaySurvey"),
    channelDirect: t("notices.android.channelDirect"),
    channelDirectHint: t("notices.android.channelDirectHint"),
    channelChats: t("notices.android.channelChats"),
    channelChatsHint: t("notices.android.channelChatsHint"),
    channelNodes: t("notices.android.channelNodes"),
    channelNodesHint: t("notices.android.channelNodesHint"),
    channelSurvey: t("notices.android.channelSurvey"),
    channelSurveyHint: t("notices.android.channelSurveyHint"),
    channelQuiet: t("notices.android.channelQuiet"),
    channelQuietHint: t("notices.android.channelQuietHint"),
  };
}

/**
 * The JSON the core reads (`WatchConfig` in `watch.rs`). The core has no clock
 * of its own, so Do not disturb goes as the next two weeks of quiet in spans
 * of the phone's clock, which the phone hands the core with each timer.
 */
export function coreConfig(state: SessionState, now = Date.now()): string {
  const prefs = getNoticePrefs();
  return JSON.stringify({
    me: state.self?.name ?? "",
    direct: prefs.direct,
    chats: prefs.chats,
    nodes: prefs.nodes,
    chat: prefs.chat,
    chatUntil: prefs.chatUntil,
    quiet: { spans: quietSpans(prefs.quiet, now), favourites: prefs.quiet.favourites, mentions: prefs.quiet.mentions },
    // As the files the phone rings with: null is a quiet kind or chat.
    sounds: { direct: signalFile(prefs.sounds.direct), chats: signalFile(prefs.sounds.chats), nodes: signalFile(prefs.sounds.nodes) },
    chatSound: Object.fromEntries(Object.entries(prefs.chatSound).map(([conversation, signal]) => [conversation, signalFile(signal)])),
    contacts: Object.values(state.contacts).map((c) => ({ key: c.key, name: c.name, type: c.type, favourite: isFavourite(c) })),
    channels: state.channels.map((c) => ({ index: c.index, name: c.name })),
    words: words(),
  });
}

/** Keeps the core told, on a phone; stops when the returned function is called. */
export function startCoreWatch(state: () => SessionState, subscribe: (listener: () => void) => () => void): () => void {
  if (!relayAvailable()) return () => undefined;
  // The session changes often; the names only now and then.
  let names: [unknown, unknown, unknown] = [null, null, null];
  let told = "";
  // Android names its notice channels from the words the core keeps: named again once they are there.
  let named = "";
  const tell = (anyway: boolean): void => {
    const now = state();
    if (!anyway && names[0] === now.self && names[1] === now.contacts && names[2] === now.channels) return;
    names = [now.self, now.contacts, now.channels];
    const json = coreConfig(now);
    if (json === told) return;
    told = json;
    const spoken = language();
    configureCore(json)
      .then(() => {
        if (named === spoken) return;
        named = spoken;
        return tellChannels(now, true);
      })
      .catch((error) => console.warn("Could not configure the radio core's notices", error));
  };
  tell(true);
  const stopSession = subscribe(() => tell(false));
  const stopPrefs = subscribeNoticePrefs(() => tell(true));
  const stopLanguage = subscribeLanguage(() => tell(true));
  return () => {
    stopSession();
    stopPrefs();
    stopLanguage();
  };
}
