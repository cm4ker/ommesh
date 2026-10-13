/**
 * Settings › Messages › Voice input (#89): the switch, and the recognition
 * models, each fetched or deleted on its own line, with a tick on the one
 * picked. The microphone shows in the field once the picked one is here.
 */

import { useEffect, useState } from "react";
import { deleteVoiceModel, downloadVoiceModel, setVoiceInputPrefs, useVoiceInputPrefs, voiceModels, type Models, type VoiceModel } from "../lib/voiceInput.js";
import { Button } from "../ui/Button.js";
import { Group, SelectRow, SwitchRow } from "../ui/List.js";
import { CheckIcon, DownIcon, TrashIcon } from "./Icons.js";
import { language, languageName, languages, t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

const MODELS: { id: VoiceModel; label: "radio.voice.modelSmall" | "radio.voice.modelBase"; hint: "radio.voice.modelSmallHint" | "radio.voice.modelBaseHint" }[] = [
  { id: "small", label: "radio.voice.modelSmall", hint: "radio.voice.modelSmallHint" },
  { id: "base", label: "radio.voice.modelBase", hint: "radio.voice.modelBaseHint" },
];

export function VoiceInputPage() {
  const prefs = useVoiceInputPrefs();
  return (
    <>
      <Group note={t("radio.voice.note")}>
        <SwitchRow label={t("radio.voice.switch")} hint={t("radio.voice.switchHint")} checked={prefs.on} onChange={(on) => setVoiceInputPrefs({ on })} />
        {prefs.on ? (
          <SelectRow
            label={t("radio.voice.language")}
            hint={t("radio.voice.languageHint")}
            value={prefs.language}
            options={[{ value: "app", label: t("radio.voice.languageApp", { language: languageName(language()) }) }, ...languages().map((code) => ({ value: code, label: languageName(code) }))]}
            onChange={(language) => setVoiceInputPrefs({ language })}
          />
        ) : null}
      </Group>
      {prefs.on ? <ModelGroup model={prefs.model} /> : null}
    </>
  );
}

/** The models: pick one, and fetch or delete each on its own line. The shell fetches one at a time. */
function ModelGroup({ model }: { model: VoiceModel }) {
  const [known, setKnown] = useState<Models | null>(null);
  const [busy, setBusy] = useState<{ id: VoiceModel; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    voiceModels()
      .then(setKnown)
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void refresh();
  }, []);
  const models = known?.models;
  const picked = models?.find((m) => m.id === model);
  const mb = (bytes: number) => t("radio.voice.size", { mb: Math.max(1, Math.round(bytes / 1_000_000)) });

  const download = async (id: VoiceModel) => {
    setError(null);
    setBusy({ id, percent: 0 });
    try {
      await downloadVoiceModel(id, (done, total) => setBusy({ id, percent: total ? Math.floor((done / total) * 100) : 0 }));
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

  // A processor that cannot run the recogniser (32-bit, or older than the ones it is built for) is told so before anything is downloaded.
  if (known?.unable) return <p className="group-note warn">{t("radio.voice.unable")}</p>;
  const note = error ?? (picked && !picked.present && !busy ? t("radio.voice.missing") : undefined);
  return (
    <Group title={t("radio.voice.models")} note={note}>
      {MODELS.map((m) => {
        const info = models?.find((x) => x.id === m.id);
        const fetching = busy?.id === m.id;
        return (
          <div key={m.id} className="line">
            <button type="button" role="radio" aria-checked={model === m.id} className="model-pick" onClick={() => setVoiceInputPrefs({ model: m.id })}>
              <CheckIcon size={16} className="model-tick" />
              <span className="line-text">
                <span>{t(m.label)}</span>
                <small>{info ? t("radio.voice.modelState", { hint: t(m.hint), state: info.present ? t("radio.voice.downloaded") : mb(info.bytes) }) : t(m.hint)}</small>
              </span>
            </button>
            {!info ? null : fetching ? (
              <Button size="sm" disabled>
                {t("radio.voice.downloading", { percent: busy.percent })}
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
