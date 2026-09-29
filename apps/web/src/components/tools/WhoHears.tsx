/**
 * "Who hears me": the repeaters that answered the last ask, best first, each
 * with how well it heard this radio; the map draws a line to each. Opening
 * the sheet sends nothing: the ask goes out from its button. Under it, the
 * same question asked on the move: a coverage survey, the one running, and
 * those kept.
 */

import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { agoPhrase } from "../../lib/format.js";
import { asksLeft, askWhoHears, LISTEN_MS, useHears } from "../../lib/hears.js";
import { formatSnr } from "../../lib/los.js";
import { showOnMap } from "../../lib/nav.js";
import { setMeshTool } from "../../lib/meshTool.js";
import { useSession } from "../../lib/session.js";
import { surveyHoldUsed, useSurveys } from "../../lib/survey.js";
import { surveyStats } from "../../lib/surveyData.js";
import { beginSurvey, openSurvey } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { ChevronRightIcon, CloseIcon, RadioIcon, SurveyIcon, WavesIcon } from "../Icons.js";
import { QualityChip } from "./RouteSheet.js";
import { clock } from "./Survey.js";

export function WhoHears({ onClose }: { onClose: () => void }) {
  const state = useSession();
  const hears = useHears();
  const surveys = useSurveys();
  const [now, setNow] = useState(Date.now());
  // The count of asks left runs down on its own; the button wakes when it is back.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { left, nextAt } = asksLeft(now);
  const replies = [...hears.replies].sort((a, b) => b.heardUs - a.heardUs);
  const online = state.status === "ready";
  const kept = surveys.list?.filter((s) => s.id !== surveys.run?.id).length ?? 0;
  const running = surveys.run ? (surveys.list?.find((s) => s.id === surveys.run!.id) ?? null) : null;
  const [starting, setStarting] = useState(false);
  const sub = hears.listening
    ? t("tools.hears.listeningCount", { count: replies.length })
    : hears.at !== null
      ? t("tools.hears.askedAgo", { time: agoPhrase(hears.at, now), count: replies.length })
      : t("tools.hears.notAsked");

  return (
    <div className="tool">
      <div className="tool-head">
        <span className="row-main">
          <span className="row-title">{t("tools.hears.title")}</span>
          <span className="row-sub muted">{sub}</span>
        </span>
        <IconButton label={t("common.close")} onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      {running ? (
        <ul className="list-rows hears" role="list">
          <li>
            <button type="button" className="row survey-live" onClick={() => openSurvey("run", running.id)}>
              <span className="survey-rec" aria-hidden="true" />
              <span className="row-main">
                <span className="row-title">{t("tools.survey.nowTitle")}</span>
                <span className="row-sub muted">{t("tools.survey.running", { time: clock(surveyStats(running, now).ms), points: t("tools.survey.points", { count: running.points.length }) })}</span>
              </span>
              <ChevronRightIcon size={16} className="muted" />
            </button>
          </li>
        </ul>
      ) : null}
      {hears.listening && hears.startedAt ? (
        <div className="listen" aria-hidden="true">
          <i style={{ animationDuration: `${LISTEN_MS}ms`, animationDelay: `-${now - hears.startedAt}ms` }} />
        </div>
      ) : null}
      {hears.error ? <p className="tool-note">{hears.error}</p> : null}
      {replies.length ? (
        <ul className="list-rows hears" role="list">
          {replies.map((r) => {
            const c = state.contacts[r.key];
            return (
              <li key={r.key}>
                <button
                  type="button"
                  className="row"
                  disabled={!c}
                  onClick={() => {
                    setMeshTool(null);
                    showOnMap(r.key);
                  }}
                >
                  <RadioIcon size={18} />
                  <span className="row-main">
                    <span className="row-title">{c ? c.name || c.prefix : t("tools.hears.repeater", { id: r.key.slice(0, 8) })}</span>
                    <span className="row-sub muted">{c ? t("tools.hears.youHear", { snr: formatSnr(r.heardThem) }) : t("tools.hears.notContact")}</span>
                  </span>
                  <QualityChip snr={r.heardUs} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : !hears.listening && hears.at !== null ? (
        <p className="tool-note muted">{t("tools.hears.none")}</p>
      ) : null}
      {running ? (
        // The survey asks by itself every half minute; an ask from here would only spend the repeaters' answers.
        <Button size="lg" disabled>
          <WavesIcon size={18} />
          {t("tools.hears.surveyAsks")}
        </Button>
      ) : (
        <>
          <Button variant={hears.listening ? "default" : "primary"} size="lg" disabled={!online || hears.listening || left <= 0} onClick={() => void askWhoHears()}>
            <WavesIcon size={18} />
            {hears.listening ? t("tools.hears.listening") : left <= 0 ? t("tools.hears.againIn", { seconds: Math.max(1, Math.ceil(((nextAt ?? now) - now) / 1000)) }) : t("tools.hears.askNow")}
          </Button>
          <Button
            size="lg"
            disabled={!online || starting}
            busy={starting}
            onClick={() => {
              setStarting(true);
              void beginSurvey().finally(() => setStarting(false));
            }}
          >
            <SurveyIcon size={18} />
            {t("tools.hears.survey")}
          </Button>
          {/* Said here until a survey has once been started that way; a hold nobody is told about is never found. */}
          {surveyHoldUsed() ? null : (
            <p className="survey-teach">
              <span className="survey-teach-ring" aria-hidden="true" />
              {t("tools.hears.holdHint")}
            </p>
          )}
        </>
      )}
      <div className="check-cost">
        <WavesIcon size={13} />
        {t("tools.hears.cost")}
      </div>
      {kept > 0 ? (
        <button type="button" className="survey-more" onClick={() => openSurvey("list")}>
          <SurveyIcon size={16} />
          <span>{t("tools.hears.surveys")}</span>
          <span className="count">{kept}</span>
          <ChevronRightIcon size={14} />
        </button>
      ) : null}
    </div>
  );
}
