/**
 * Settings › Experimental features › Voice › Voice cards (#89): ours,
 * recorded by reading a phrase and saved as a file to hand over; the ones we
 * were handed, opened from their files; and the cloning model that reads a
 * voice message in its sender's voice when we hold their card.
 */

import { useEffect, useRef, useState } from "react";
import { saveFile } from "../lib/saveFile.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { startRecording, type Recording } from "../lib/voice.js";
import { CARD_PHRASE, CARD_RATE, cardFileName, decodeCard, encodeCard } from "../lib/voiceCard.js";
import { cardFile, deleteCloneModel, downloadCloneModel, dropCard, keepCard, refreshClones, useCards, useCloneModel } from "../lib/voiceClone.js";
import { Button } from "../ui/Button.js";
import { Block, Group } from "../ui/List.js";
import { DownIcon, MicIcon, PlayIcon, ShareIcon, StopIcon, TrashIcon } from "./Icons.js";
import { voiceLength } from "./VoiceMessage.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/** A card shorter than this gives the model too little of the voice. */
const SHORTEST_SECONDS = 6;
/** Reading the phrase takes some ten seconds; the recording stops by itself well after. */
const LONGEST_SECONDS = 25;

/** Plays samples once, at their rate. */
function play(pcm: Float32Array, rate: number): void {
  const context = new AudioContext();
  const buffer = context.createBuffer(1, pcm.length, rate);
  buffer.getChannelData(0).set(pcm);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.onended = () => void context.close();
  source.start();
}

export function VoiceCardsPage() {
  const state = useSession();
  const cards = useCards();
  const speaker = session.voiceSpeaker();
  const mine = cards.find((c) => c.speaker === speaker) ?? null;
  const theirs = cards.filter((c) => c.speaker !== speaker);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshClones();
  }, []);

  const open = async (file: File) => {
    const card = decodeCard(new Uint8Array(await file.arrayBuffer()));
    if (!card) {
      toast(t("radio.cards.notCard"), "error");
      return;
    }
    try {
      await keepCard(card, new Uint8Array(await file.arrayBuffer()));
      toast(t("radio.cards.added", { name: card.name }));
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  return (
    <>
      <Group title={t("radio.cards.mine")} note={t("radio.cards.mineNote")}>
        {state.self && speaker ? <OwnCard name={state.self.name} speaker={speaker} kept={mine?.print ?? null} /> : null}
      </Group>

      <Group title={t("radio.cards.theirs")}>
        {theirs.map((card) => (
          <div key={card.speaker} className="line">
            <span className="line-text">
              <span>{card.name}</span>
              <small>
                {t("radio.cards.print", { print: card.print })} · {card.ready ? t("radio.cards.ready") : t("radio.cards.needsModel")}
              </small>
            </span>
            <Button size="sm" onClick={() => void dropCard(card.speaker).catch((e: unknown) => toast(errorText(e), "error"))}>
              <TrashIcon size={14} />
              {t("radio.voice.delete")}
            </Button>
          </div>
        ))}
        <div className="line">
          <span className="line-text">
            <span>{t("radio.cards.open")}</span>
            <small>{t("radio.cards.openHint")}</small>
          </span>
          <Button size="sm" onClick={() => picker.current?.click()}>
            {t("radio.cards.openButton")}
          </Button>
        </div>
      </Group>
      <input
        ref={picker}
        type="file"
        accept=".wav,audio/wav,audio/x-wav"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void open(file);
        }}
      />

      <ModelGroup />
    </>
  );
}

/** Ours: read the phrase, listen to it, keep it, and save it as a file to hand over. */
function OwnCard({ name, speaker, kept }: { name: string; speaker: string; kept: string | null }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<{ pcm: Float32Array; seconds: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef<Recording | null>(null);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds(recording.seconds()), 200);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => () => live.current?.cancel(), []);

  const finish = async () => {
    const rec = live.current;
    if (!rec) return;
    live.current = null;
    setRecording(null);
    const { samples, seconds: said } = await rec.stop();
    if (said < SHORTEST_SECONDS) {
      toast(t("radio.cards.tooShort"), "error");
      return;
    }
    setTake({ pcm: samples, seconds: said });
    // Kept at once: the card is ours whether or not it is saved as a file, and our own messages read in it.
    setBusy(true);
    try {
      const wav = encodeCard(samples, CARD_RATE, { name, speaker, text: CARD_PHRASE });
      const card = decodeCard(wav)!;
      await keepCard(card, wav);
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    try {
      const rec = await startRecording(() => void finish(), CARD_RATE, LONGEST_SECONDS);
      live.current = rec;
      setSeconds(0);
      setRecording(rec);
    } catch {
      toast(t("chats.voice.micDenied"), "error");
    }
  };

  const save = async () => {
    try {
      const bytes = await cardFile(speaker);
      await saveFile(cardFileName({ name, speaker, text: CARD_PHRASE }), bytes, "audio/wav", t("radio.cards.save"));
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  if (recording || !kept) {
    return (
      <>
        <Block className="card-phrase">
          <small>{t("radio.cards.read")}</small>
          <p>«{CARD_PHRASE}»</p>
        </Block>
        <div className="line">
          <span className="line-text">
            <span>{recording ? t("radio.cards.recording", { length: voiceLength(seconds) }) : t("radio.cards.none")}</span>
          </span>
          {recording ? (
            <Button size="sm" variant="primary" onClick={() => void finish()}>
              <StopIcon size={14} />
              {t("radio.cards.done")}
            </Button>
          ) : (
            <Button size="sm" busy={busy} onClick={() => void start()}>
              <MicIcon size={14} />
              {t("radio.cards.record")}
            </Button>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="line">
        <span className="line-text">
          <span>{take ? t("radio.cards.card", { length: voiceLength(take.seconds) }) : t("radio.cards.kept")}</span>
          <small>{t("radio.cards.print", { print: kept })}</small>
        </span>
        {take ? (
          <Button size="sm" onClick={() => play(take.pcm, CARD_RATE)}>
            <PlayIcon size={14} />
            {t("radio.voice.listen")}
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void start()}>
          <MicIcon size={14} />
          {t("radio.cards.again")}
        </Button>
      </div>
      <div className="line">
        <span className="line-text">
          <span>{t("radio.cards.save")}</span>
          <small>{t("radio.cards.saveHint")}</small>
        </span>
        <Button size="sm" onClick={() => void save()}>
          <ShareIcon size={14} />
          {t("radio.cards.saveButton")}
        </Button>
      </div>
    </>
  );
}

/** XTTS, which reads a message in its sender's voice: fetched once, deleted to free the room. */
function ModelGroup() {
  const model = useCloneModel();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const size = model ? t("radio.voice.size", { mb: Math.round(model.bytes / 1_000_000) }) : "";

  const download = async () => {
    setError(null);
    setProgress(0);
    try {
      await downloadCloneModel((done, total) => setProgress(total ? Math.floor((done / total) * 100) : null));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Group title={t("radio.cards.model")} note={error ?? t("radio.cards.modelNote")}>
      <div className="line">
        <span className="line-text">
          <span>XTTS v2</span>
          <small>{model ? t("radio.cards.modelHint", { state: model.present ? t("radio.voice.downloaded") : size }) : t("radio.cards.modelMissing")}</small>
        </span>
        {!model ? null : progress !== null ? (
          <Button size="sm" disabled>
            {t("radio.voice.downloading", { percent: progress })}
          </Button>
        ) : model.present ? (
          <Button size="sm" onClick={() => void deleteCloneModel().catch((e: unknown) => setError(errorText(e)))}>
            <TrashIcon size={14} />
            {t("radio.voice.delete")}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void download()}>
            <DownIcon size={14} />
            {t("radio.voice.download")}
          </Button>
        )}
      </div>
    </Group>
  );
}
