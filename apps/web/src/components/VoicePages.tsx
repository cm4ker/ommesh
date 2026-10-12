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
import { push } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import {
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
import { ActionRow, ChoiceRow, Group, LinkRow, SelectRow, SwitchRow } from "../ui/List.js";
import { AirIcon, MicIcon, PlayIcon } from "./Icons.js";
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
      await act(() => session.announceVoice(channel.index, { gender: prefs.gender }), t("radio.voice.announced"));
      setVoicePrefs({ announced: { ...prefs.announced, [radio]: { at: Date.now(), gender: prefs.gender } } });
    } finally {
      setBusy(null);
    }
  };

  const channelHint = channel ? t("radio.voice.inRadio", { slot: channel.index }) : t("radio.voice.switchHint");
  const announceHint = !announced ? t("radio.voice.neverAnnounced") : t("radio.voice.announcedAt", { when: agoPhrase(announced.at) });
  const changed = !!announced && announced.gender !== prefs.gender;

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
              <Button size="sm" disabled={!voices} onClick={() => speak("voice-sample", t("radio.voice.sample"), prefs.gender)}>
                <PlayIcon size={14} />
                {t("radio.voice.listen")}
              </Button>
            </div>
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

/** Which recognition model, and fetching the one picked when it is not here yet. */
function ModelGroup({ model }: { model: VoiceModel }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    voiceModels()
      .then((list) => live && setModels(list))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, []);
  const picked = models?.find((m) => m.id === model);
  const mb = (bytes: number) => t("radio.voice.size", { mb: Math.round(bytes / 1_000_000) });

  const download = async () => {
    setError(null);
    setProgress(0);
    try {
      await downloadVoiceModel(model, (done, total) => setProgress(total ? Math.floor((done / total) * 100) : null));
      setModels(await voiceModels());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Group title={t("radio.voice.recognition")} note={error ?? undefined}>
      {MODELS.map((m) => {
        const info = models?.find((x) => x.id === m.id);
        return (
          <ChoiceRow
            key={m.id}
            label={t(m.label)}
            hint={t(m.hint)}
            value={info ? (info.present ? t("radio.voice.downloaded") : mb(info.bytes)) : undefined}
            checked={model === m.id}
            onSelect={() => setVoicePrefs({ model: m.id })}
          />
        );
      })}
      {picked && !picked.present ? (
        <div className="line">
          <span className="line-text">
            <span>{t("radio.voice.missing")}</span>
            <small>{mb(picked.bytes)}</small>
          </span>
          <Button size="sm" disabled={progress !== null} onClick={() => void download()}>
            {progress !== null ? t("radio.voice.downloading", { percent: progress }) : t("radio.voice.download")}
          </Button>
        </div>
      ) : null}
    </Group>
  );
}
