/**
 * Settings › Experimental features, and the one there is so far: voice
 * messages in #voice (#89). The voice page holds the switch, how others hear
 * us and the button that tells them, the recognition model, and how voice
 * messages are sent and read.
 */

import { useEffect, useState } from "react";
import { fromHex, VoiceGender } from "@meshnet/meshcore";
import { freeChannelIndex, hashtagSecret } from "../lib/channels.js";
import { agoPhrase } from "../lib/format.js";
import { isTauri } from "../lib/platform.js";
import { useCards } from "../lib/voiceClone.js";
import { push } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import {
  deleteVoiceModel,
  downloadVoiceModel,
  setVoicePrefs,
  speak,
  useRussianVoices,
  useVoicePrefs,
  VOICE_CHANNEL,
  voiceAvailable,
  voiceChannel,
  voiceModels,
  type ModelInfo,
  type VoiceModel,
} from "../lib/voice.js";
import { Button } from "../ui/Button.js";
import { ActionRow, Group, LinkRow, SelectRow, SwitchRow } from "../ui/List.js";
import { AirIcon, CheckIcon, DownIcon, MicIcon, PlayIcon, TrashIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

export function LabsPage() {
  const prefs = useVoicePrefs();
  return (
    <>
      <p className="group-note">{t("radio.labs.note")}</p>
      <Group>
        {voiceAvailable() ? (
          <LinkRow icon={<MicIcon size={17} />} label={t("radio.titles.voice")} hint={t("radio.labs.voiceHint")} value={prefs.on ? t("radio.labs.on") : t("radio.labs.off")} onClick={() => push({ kind: "radio", page: "voice" })} />
        ) : (
          <LinkRow icon={<MicIcon size={17} />} label={t("radio.titles.voice")} hint={t("radio.labs.desktopOnly")} disabled onClick={() => undefined} />
        )}
      </Group>
    </>
  );
}

const GENDERS: { value: VoiceGender; label: "radio.voice.genderAny" | "radio.voice.genderFemale" | "radio.voice.genderMale" }[] = [
  { value: VoiceGender.Any, label: "radio.voice.genderAny" },
  { value: VoiceGender.Female, label: "radio.voice.genderFemale" },
  { value: VoiceGender.Male, label: "radio.voice.genderMale" },
];

const MODELS: { id: VoiceModel; label: "radio.voice.modelSmall" | "radio.voice.modelBase"; hint: "radio.voice.modelSmallHint" | "radio.voice.modelBaseHint" }[] = [
  { id: "small", label: "radio.voice.modelSmall", hint: "radio.voice.modelSmallHint" },
  { id: "base", label: "radio.voice.modelBase", hint: "radio.voice.modelBaseHint" },
];

export function VoicePage() {
  const prefs = useVoicePrefs();
  const state = useSession();
  const online = state.status === "ready";
  const channel = voiceChannel(state);
  const voices = useRussianVoices();
  const radio = state.self?.key ?? null;
  const announced = radio ? prefs.announced[radio] : undefined;
  const [busy, setBusy] = useState<"channel" | "announce" | null>(null);
  // Voice cards and the clone live in the desktop shell.
  const cards = useCards();
  const speaker = session.voiceSpeaker();
  const card = cards.find((c) => c.speaker === speaker)?.print ?? null;
  const others = cards.filter((c) => c.speaker !== speaker).length;

  const addChannel = async () => {
    const index = freeChannelIndex(state);
    if (index < 0) return;
    setBusy("channel");
    try {
      await session.setChannel(index, VOICE_CHANNEL, fromHex(hashtagSecret(VOICE_CHANNEL)));
      toast(t("radio.voice.channelAdded"));
    } catch (error) {
      toast(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const announce = async () => {
    if (!channel || !radio) return;
    setBusy("announce");
    try {
      const sent = await act(() => session.announceVoice(channel.index, { gender: prefs.gender, card }), t("radio.voice.announced"));
      if (sent) setVoicePrefs({ announced: { ...prefs.announced, [radio]: { at: Date.now(), gender: prefs.gender, card } } });
    } finally {
      setBusy(null);
    }
  };

  const channelHint = channel ? t("radio.voice.inRadio", { slot: channel.index }) : t("radio.voice.switchHint");
  const announceHint = !announced ? t("radio.voice.neverAnnounced") : t("radio.voice.announcedAt", { when: agoPhrase(announced.at) });
  const changed = !!announced && (announced.gender !== prefs.gender || (announced.card ?? null) !== card);
  const cardsValue = [card ? t("radio.voice.cardsMine") : null, others ? t("radio.voice.cardsTheirs", { count: others }) : null].filter(Boolean).join(" · ") || t("radio.voice.cardsNone");

  return (
    <>
      <Group>
        <SwitchRow label={t("radio.voice.switch")} hint={channelHint} checked={prefs.on} onChange={(on) => setVoicePrefs({ on })} />
        {prefs.on && !channel ? (
          freeChannelIndex(state) < 0 ? (
            <p className="group-note">{t("radio.voice.noSlot")}</p>
          ) : (
            <ActionRow label={t("radio.voice.addChannel")} hint={t("radio.voice.addChannelHint")} disabled={!online} busy={busy === "channel"} onClick={() => void addChannel()} />
          )
        ) : null}
      </Group>

      {prefs.on ? (
        <>
          <Group title={t("radio.voice.heardAs")} note={t("radio.voice.announceNote")}>
            <SelectRow
              label={t("radio.voice.gender")}
              hint={t("radio.voice.genderHint")}
              value={String(prefs.gender)}
              options={GENDERS.map((g) => ({ value: String(g.value), label: t(g.label) }))}
              onChange={(value) => setVoicePrefs({ gender: Number(value) as VoiceGender })}
            />
            <div className="line">
              <span className="line-text">
                <span>{t("radio.voice.sampleLabel")}</span>
                <small>{t("radio.voice.sample")}</small>
              </span>
              <Button size="sm" disabled={!voices && !card} onClick={() => speak("voice-sample", t("radio.voice.sample"), prefs.gender, speaker)}>
                <PlayIcon size={14} />
                {t("radio.voice.listen")}
              </Button>
            </div>
            {isTauri() ? <LinkRow label={t("radio.titles.voiceCards")} hint={t("radio.voice.cardsHint")} value={cardsValue} onClick={() => push({ kind: "radio", page: "voiceCards" })} /> : null}
            <div className="line">
              <span className="line-text">
                <span>{t("radio.voice.announce")}</span>
                {changed ? <small className="warn">{t("radio.voice.voiceChanged")}</small> : null}
                <small>{announceHint}</small>
              </span>
              <Button size="sm" busy={busy === "announce"} disabled={!online || !channel || busy !== null} onClick={() => void announce()}>
                <AirIcon size={14} />
                {t("radio.voice.announceButton")}
              </Button>
            </div>
          </Group>
          {!voices ? <p className="group-note warn">{t("radio.voice.noRussian")}</p> : null}

          <ModelGroup model={prefs.model} />

          <Group title={t("radio.voice.sendGroup")}>
            <SwitchRow label={t("radio.voice.review")} hint={t("radio.voice.reviewHint")} checked={prefs.review} onChange={(review) => setVoicePrefs({ review })} />
            <SelectRow
              label={t("radio.voice.readAloud")}
              value={prefs.readAloud}
              options={[
                { value: "tap", label: t("radio.voice.readTap") },
                { value: "auto", label: t("radio.voice.readAtOnce") },
              ]}
              onChange={(readAloud) => setVoicePrefs({ readAloud })}
            />
          </Group>
        </>
      ) : null}
    </>
  );
}

/**
 * The recognition models: pick one, and fetch or delete each on its own line.
 * The shell fetches one at a time, so the other buttons wait while it does.
 */
function ModelGroup({ model }: { model: VoiceModel }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [busy, setBusy] = useState<{ id: VoiceModel; percent: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    voiceModels()
      .then(setModels)
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void refresh();
  }, []);
  const picked = models?.find((m) => m.id === model);
  const mb = (bytes: number) => t("radio.voice.size", { mb: Math.round(bytes / 1_000_000) });

  const download = async (id: VoiceModel) => {
    setError(null);
    setBusy({ id, percent: 0 });
    try {
      await downloadVoiceModel(id, (done, total) => setBusy({ id, percent: total ? Math.floor((done / total) * 100) : null }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const remove = async (id: VoiceModel) => {
    setError(null);
    try {
      await deleteVoiceModel(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      await refresh();
    }
  };

  const note = error ?? (picked && !picked.present && !busy ? t("radio.voice.missing") : undefined);
  return (
    <Group title={t("radio.voice.recognition")} note={note}>
      {MODELS.map((m) => {
        const info = models?.find((x) => x.id === m.id);
        const fetching = busy?.id === m.id;
        return (
          <div key={m.id} className="line">
            <button type="button" role="radio" aria-checked={model === m.id} className="model-pick" onClick={() => setVoicePrefs({ model: m.id })}>
              <CheckIcon size={16} className="model-tick" />
              <span className="line-text">
                <span>{t(m.label)}</span>
                <small>{info ? t("radio.voice.modelState", { hint: t(m.hint), state: info.present ? t("radio.voice.downloaded") : mb(info.bytes) }) : t(m.hint)}</small>
              </span>
            </button>
            {!info ? null : fetching ? (
              <Button size="sm" disabled>
                {busy.percent === null ? t("radio.voice.download") : t("radio.voice.downloading", { percent: busy.percent })}
              </Button>
            ) : info.present ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void remove(m.id)}>
                <TrashIcon size={14} />
                {t("radio.voice.delete")}
              </Button>
            ) : (
              <Button size="sm" disabled={busy !== null} onClick={() => void download(m.id)}>
                <DownIcon size={14} />
                {t("radio.voice.download")}
              </Button>
            )}
          </div>
        );
      })}
    </Group>
  );
}
