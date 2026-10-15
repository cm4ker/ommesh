import { useEffect, useState } from "react";
import { regionName, regionSupport, UNSCOPED, type RegionSurvey, type RegionSurveyStep } from "@meshnet/meshcore";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Block, ChoiceRow, Group, InfoRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { RepeaterIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/** Whose region the sheet sets: the one the radio keeps, or one channel's own. */
export type RegionTarget = { kind: "radio" } | { kind: "channel"; index: number };

type ChannelChoice = "radio" | "none" | "own";

/**
 * Picks a region by its name, typed or taken from what the repeaters nearby
 * say they carry. The radio keeps its region and floods everything under it;
 * a channel can go with the radio's, with none at all, or with its own.
 */
export function RegionSheet({ open, onClose, target }: { open: boolean; onClose: () => void; target: RegionTarget }) {
  const state = useSession();
  const online = state.status === "ready";
  const support = regionSupport(state.device);
  const radio = state.region?.name ?? null;
  const channel = target.kind === "channel" ? state.channels.find((c) => c.index === target.index) : undefined;
  const current = target.kind === "radio" ? radio : channel ? (state.channelRegions[channel.secret] ?? null) : null;
  const [choice, setChoice] = useState<ChannelChoice>("own");
  const [text, setText] = useState("");
  const [survey, setSurvey] = useState<RegionSurvey | null>(null);
  const [step, setStep] = useState<RegionSurveyStep | null>(null);

  // Each opening starts from what is set now.
  useEffect(() => {
    if (!open) return;
    const own = current !== null && current !== UNSCOPED ? current : "";
    setChoice(current === null ? "radio" : current === UNSCOPED ? "none" : "own");
    setText(own);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const found = survey?.regions.filter((r) => r.name !== UNSCOPED) ?? [];
  const unscoped = survey?.regions.find((r) => r.name === UNSCOPED);
  // A name a repeater gave goes as it was given: its key is worked out from it to the letter.
  const name = found.some((r) => r.name === text) ? text : regionName(text);
  const typed = text.trim() !== "";
  const own = target.kind === "radio" || choice === "own";
  const next = target.kind === "radio" ? (typed ? name : null) : choice === "radio" ? null : choice === "none" ? UNSCOPED : name;
  const ready = !(own && typed && name === null) && !(target.kind === "channel" && choice === "own" && !name);
  // The radio's region is written to the radio; a channel's is kept here, and waits for no link.
  const canSave = ready && next !== current && (online || target.kind === "channel");
  // Without a region of the radio's, a channel under the radio's goes without one too.
  const offerNone = target.kind === "channel" && support.unscoped && radio !== null;

  const ask = async () => {
    setSurvey(null);
    setStep({ step: "listening", ms: 0 });
    try {
      setSurvey(await session.askRegions(setStep));
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setStep(null);
    }
  };

  const save = async () => {
    if (target.kind === "radio") {
      if (await act(() => session.setRadioRegion(next), t("common.savedToRadio"))) onClose();
      return;
    }
    session.setChannelRegion(target.index, next);
    onClose();
  };

  const pick = (picked: string) => {
    setText(picked);
    setChoice("own");
  };

  return (
    <Sheet open={open} onClose={onClose} title={t(target.kind === "radio" ? "radio.region.title" : "radio.region.channelTitle")}>
      {target.kind === "channel" ? (
        <Group>
          <ChoiceRow label={t("radio.region.asRadio")} value={radio ?? t("radio.region.none")} checked={choice === "radio"} onSelect={() => setChoice("radio")} />
          {offerNone ? <ChoiceRow label={t("radio.region.unscoped")} hint={t("radio.region.unscopedHint")} checked={choice === "none"} onSelect={() => setChoice("none")} /> : null}
          <ChoiceRow label={t("radio.region.own")} checked={choice === "own"} onSelect={() => setChoice("own")} />
        </Group>
      ) : null}
      {own ? (
        <>
          <Group note={t("radio.region.note")}>
            <Block>
              <label className="field">
                <span className="field-label">{t("radio.region.name")}</span>
                <input
                  className="input"
                  value={text}
                  maxLength={31}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => pick(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSave && void save()}
                />
                {typed && name === null ? <span className="field-hint danger">{t("radio.region.invalid")}</span> : null}
              </label>
            </Block>
            <Block>
              <div className="row-actions wrap">
                <Button size="sm" busy={step !== null} disabled={!online} onClick={() => void ask()}>
                  <RepeaterIcon size={13} />
                  {t("radio.region.ask")}
                </Button>
                {step ? <span className="field-hint">{stepText(step)}</span> : null}
              </div>
            </Block>
          </Group>
          {survey ? (
            survey.answered === 0 ? (
              <p className="group-note">{t(survey.asked === 0 ? "radio.region.nobodyNear" : "radio.region.nobodyAnswered")}</p>
            ) : (
              <Group title={t("radio.region.found")} note={found.length === 0 ? t("radio.region.noneFound") : undefined}>
                {found.map((r) => (
                  <ChoiceRow key={r.name} label={r.name} value={t("radio.region.repeaters", { count: r.repeaters })} checked={text === r.name} onSelect={() => pick(r.name)} />
                ))}
                {unscoped ? <InfoRow label={t("radio.region.unscoped")}>{t("radio.region.repeaters", { count: unscoped.repeaters })}</InfoRow> : null}
              </Group>
            )
          ) : null}
        </>
      ) : null}
      <div className="page-actions">
        <Button variant="primary" size="lg" disabled={!canSave} onClick={() => void save()}>
          {t("radio.region.save")}
        </Button>
      </div>
    </Sheet>
  );
}

/** How far the asking has got, under its button. */
function stepText(step: RegionSurveyStep | null): string | undefined {
  if (!step) return undefined;
  if (step.step === "listening") return t("radio.region.listening");
  return t("radio.region.asking", { done: step.done + 1, total: step.total });
}

/** A region as a row shows it: its name, none, or the radio's for a channel that goes with it. */
export function regionLabel(region: string | null, radio: string | null, channel: boolean): string {
  if (region === UNSCOPED) return t("radio.region.unscoped");
  if (region !== null) return region;
  if (!channel) return t("radio.region.none");
  return radio ? t("chats.channel.regionRadio", { name: radio }) : t("radio.region.none");
}
