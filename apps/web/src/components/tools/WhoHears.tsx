/**
 * "Who hears me": the repeaters that answered, best first, each with how
 * well it heard this radio; the map draws a line to each. Under it, the
 * same question asked on the move: a coverage survey, and those kept.
 */

import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { asksLeft, askWhoHears, LISTEN_MS, useHears } from "../../lib/hears.js";
import { formatSnr } from "../../lib/los.js";
import { showOnMap } from "../../lib/nav.js";
import { setMeshTool } from "../../lib/meshTool.js";
import { useSession } from "../../lib/session.js";
import { useSurveys } from "../../lib/survey.js";
import { beginSurvey, openSurvey } from "../../lib/toolActions.js";
import { Button, IconButton } from "../../ui/Button.js";
import { ChevronRightIcon, CloseIcon, RadioIcon, SurveyIcon, WavesIcon } from "../Icons.js";
import { QualityChip } from "./RouteSheet.js";

export function WhoHears({ onClose }: { onClose: () => void }) {
  const state = useSession();
  const hears = useHears();
  const [now, setNow] = useState(Date.now());
  // The count of asks left runs down on its own; the button wakes when it is back.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { left, nextAt } = asksLeft(now);
  const replies = [...hears.replies].sort((a, b) => b.heardUs - a.heardUs);
  const online = state.status === "ready";
  const kept = useSurveys().list?.length ?? 0;
  const [starting, setStarting] = useState(false);

  return (
    <div className="tool">
      <div className="tool-head">
        <span className="row-main">
          <span className="row-title">{t("tools.hears.title")}</span>
          <span className="row-sub muted">{hears.listening ? t("tools.hears.listeningCount", { count: replies.length }) : t("tools.hears.answered", { count: replies.length })}</span>
        </span>
        <IconButton label={t("common.close")} onClick={onClose}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
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
      ) : !hears.listening ? (
        <p className="tool-note muted">{t("tools.hears.none")}</p>
      ) : null}
      <Button variant={hears.listening ? "default" : "primary"} size="lg" disabled={!online || hears.listening || left <= 0} onClick={() => void askWhoHears()}>
        <WavesIcon size={18} />
        {hears.listening ? t("tools.hears.listening") : left <= 0 ? t("tools.hears.againIn", { seconds: Math.max(1, Math.ceil(((nextAt ?? now) - now) / 1000)) }) : t("tools.askAgain")}
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
