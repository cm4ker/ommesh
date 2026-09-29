/**
 * A coverage survey over the map (lib/survey.ts). While it runs, one short
 * card: how long, how many points, who hears the radio now, when the next
 * ask goes, and Stop. After: what the drive added up to and the repeaters
 * that answered, one of which can be picked to see only its points. Also the
 * surveys kept, a point's answers, and the files a survey can be written to.
 */

import { useEffect, useState, type ReactNode } from "react";
import { locale, t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";
import { formatDistance } from "../../lib/geo.js";
import { LISTEN_MS, useHears } from "../../lib/hears.js";
import { formatSnr } from "../../lib/los.js";
import { setMeshTool, type SurveyTool } from "../../lib/meshTool.js";
import { usePhone } from "../../lib/phonePosition.js";
import { isCapacitor } from "../../lib/platform.js";
import { saveFile } from "../../lib/saveFile.js";
import { useSession } from "../../lib/session.js";
import { COVERAGE_MAPS, type CoverageMap } from "../../lib/coverage/maps.js";
import { canSendCoverage, sendSurvey } from "../../lib/coverage/upload.js";
import { deleteSurvey, markSurveySent, restoreSurvey, surveyNodeName, useSurveys, type SurveyRun } from "../../lib/survey.js";
import { FIX_M, MOVE_M, PING_EVERY_MS, pointTone, repeaterRows, replyScore, surveyStats, type Survey, type SurveyPoint } from "../../lib/surveyData.js";
import { FORMAT_TYPE, surveyFile, surveyFileName, type SurveyFormat } from "../../lib/surveyFiles.js";
import { toast } from "../../lib/toast.js";
import { closeAllTools, closeTool, endSurvey, openRunningSurvey, openSurvey } from "../../lib/toolActions.js";
import { dayLabel, timeOfDay } from "../../lib/format.js";
import { Button, IconButton } from "../../ui/Button.js";
import { BackIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, FileIcon, LinkOffIcon, LocateIcon, PauseIcon, RadioIcon, ShareIcon, StopIcon, SurveyIcon, TrashIcon } from "../Icons.js";
import { QualityChip } from "./RouteSheet.js";

export function SurveySheet({ tool }: { tool: SurveyTool }) {
  const surveys = useSurveys();
  const survey = tool.view === "run" && surveys.run ? surveys.list?.find((s) => s.id === surveys.run!.id) ?? null : surveys.list?.find((s) => s.id === tool.id) ?? null;
  // Gone: a survey let go before its first point, or deleted; its sheet goes with it.
  const gone = tool.view !== "list" && surveys.list !== null && !survey;
  useEffect(() => {
    if (gone) setMeshTool(null);
  }, [gone]);
  if (tool.view === "list") return <SurveyList list={surveys.list ?? []} run={surveys.run} />;
  if (!survey) return null;
  if (tool.point !== null && survey.points[tool.point]) return <PointView survey={survey} point={survey.points[tool.point]!} />;
  if (tool.view === "run" && surveys.run) return <RunView survey={survey} run={surveys.run} />;
  if (tool.view === "export") return <ExportView survey={survey} />;
  return <SummaryView tool={tool} survey={survey} />;
}

/** "16 min", or "1 h 20 min". */
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("common.minutes", { count: minutes });
  const rest = minutes % 60;
  return rest ? `${t("common.hours", { count: Math.floor(minutes / 60) })} ${t("common.minutes", { count: rest })}` : t("common.hours", { count: minutes / 60 });
}

/** "08:30" of a survey running, minutes and seconds. */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m < 10 ? "0" : ""}${m}:${s % 60 < 10 ? "0" : ""}${s % 60}`;
}

/** "Today, 13:59–14:15". */
function when(survey: Survey): string {
  const from = survey.startedAt / 1000;
  const to = (survey.endedAt ?? Date.now()) / 1000;
  return `${dayLabel(from)}, ${timeOfDay(from)}–${timeOfDay(to)}`;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ---- running ----

/**
 * A survey running, over whatever is on screen but its own card: how long
 * and how many points, and a tap back to it. It keeps the screen on and
 * sends a packet every half minute, so it is never out of sight.
 */
export function SurveyStrip() {
  const surveys = useSurveys();
  const survey = surveys.run ? (surveys.list?.find((s) => s.id === surveys.run!.id) ?? null) : null;
  return survey ? <RunningStrip survey={survey} /> : null;
}

/** The strip itself, ticking only while there is a survey to tick for. */
function RunningStrip({ survey }: { survey: Survey }) {
  const now = useNow();
  return (
    <button type="button" className="survey-strip" onClick={openRunningSurvey}>
      <span className="survey-rec" aria-hidden="true" />
      <span className="survey-strip-text">{t("tools.survey.strip", { time: clock(surveyStats(survey, now).ms), points: t("tools.survey.points", { count: survey.points.length }) })}</span>
      <ChevronRightIcon size={16} />
    </button>
  );
}

function RunView({ survey, run }: { survey: Survey; run: SurveyRun }) {
  const now = useNow();
  const hears = useHears();
  const phone = usePhone(false);
  const stats = surveyStats(survey, now);
  const last = survey.points.at(-1) ?? null;
  let mark: ReactNode;
  let line: string;
  if (run.paused && run.paused.until > now) {
    mark = <PauseIcon size={16} />;
    line = t("tools.survey.paused", { time: duration(run.paused.ms) });
  } else if (run.phase === "offline") {
    mark = <LinkOffIcon size={16} className="bad" />;
    line = t("tools.survey.offline");
  } else if (run.phase === "gps") {
    mark = <LocateIcon size={16} />;
    line = phone.fix && phone.fix.accuracy > FIX_M ? t("tools.survey.gpsVague", { m: Math.round(phone.fix.accuracy), need: FIX_M }) : t("tools.survey.gps");
  } else if (run.phase === "still") {
    mark = <PauseIcon size={16} />;
    line = t("tools.survey.still", { m: MOVE_M });
  } else if (run.phase === "listening") {
    mark = <span className={`survey-dot ${last ? pointTone(last) : "none"}`} />;
    line = t("tools.survey.listening");
  } else if (last && last.replies.length) {
    const best = [...last.replies].sort((a, b) => replyScore(b) - replyScore(a))[0]!;
    mark = <span className={`survey-dot ${pointTone(last)}`} />;
    line = t("tools.survey.heard", { count: last.replies.length, name: surveyNodeName(survey, best.key), snr: formatSnr(replyScore(best)) });
  } else {
    mark = <span className="survey-dot none" />;
    line = last ? t("tools.survey.nobody") : t("tools.survey.gps");
  }
  const waiting = run.phase === "wait" && run.lastPingAt !== null;
  const left = waiting ? Math.max(0, run.lastPingAt! + PING_EVERY_MS - now) : 0;
  return (
    <div className="tool survey-run">
      <div className="survey-bar">
        <span className="survey-mark">{mark}</span>
        <span className="survey-title">{t("tools.survey.running", { time: clock(stats.ms), points: t("tools.survey.points", { count: stats.points }) })}</span>
        {waiting ? (
          <span className="survey-ring" title={t("tools.survey.next", { seconds: Math.ceil(left / 1000) })}>
            <svg viewBox="0 0 30 30" aria-hidden="true">
              <circle className="bg" cx="15" cy="15" r="12" />
              <circle className="fg" cx="15" cy="15" r="12" style={{ strokeDashoffset: 75.4 * (left / PING_EVERY_MS) }} />
            </svg>
            <span>{Math.ceil(left / 1000)}</span>
          </span>
        ) : null}
        <Button variant="danger" size="sm" onClick={endSurvey}>
          <StopIcon size={14} />
          {t("tools.survey.stop")}
        </Button>
        {/* Put away, not closed: it goes on under the strip that leads back to it. */}
        <IconButton label={t("tools.survey.collapse")} onClick={closeTool}>
          <ChevronDownIcon size={18} />
        </IconButton>
        <span className="survey-line muted">{line}</span>
      </div>
      {run.phase === "listening" && hears.startedAt ? (
        <div className="listen" aria-hidden="true">
          <i style={{ animationDuration: `${LISTEN_MS}ms`, animationDelay: `-${now - hears.startedAt}ms` }} />
        </div>
      ) : null}
      {stats.points ? (
        <p className="tool-note muted">
          {formatDistance(stats.km)} · {t("tools.survey.answered", { answered: stats.answered, count: stats.points })}
        </p>
      ) : null}
      <div className="check-cost">
        <SurveyIcon size={13} />
        {t("tools.survey.cost")}
      </div>
    </div>
  );
}

// ---- after ----

function SummaryView({ tool, survey }: { tool: SurveyTool; survey: Survey }) {
  useSession();
  const stats = surveyStats(survey);
  const rows = repeaterRows(survey);
  const remove = () => {
    const gone = deleteSurvey(survey.id);
    if (!gone) return;
    setMeshTool(null);
    toast(t("tools.survey.deleted"), "", { label: t("common.undo"), run: () => restoreSurvey(gone) });
  };
  return (
    <div className="tool">
      <div className="tool-head">
        <IconButton label={t("common.back")} onClick={closeTool}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">{t("tools.survey.title")}</span>
          <span className="row-sub muted">{when(survey)}</span>
        </span>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <div className="survey-stats">
        <span>
          <b>{Math.max(1, Math.round(stats.ms / 60_000))}</b>
          {t("tools.survey.stat.minutes")}
        </span>
        <span>
          <b>{new Intl.NumberFormat(locale(), { minimumFractionDigits: stats.km < 10 ? 1 : 0, maximumFractionDigits: stats.km < 10 ? 1 : 0 }).format(stats.km)}</b>
          {t("tools.survey.stat.km")}
        </span>
        <span>
          <b>{stats.points}</b>
          {t("tools.survey.stat.points", { count: stats.points })}
        </span>
        <span>
          <b>{stats.points ? Math.round((stats.answered / stats.points) * 100) : 0} %</b>
          {t("tools.survey.stat.answered")}
        </span>
      </div>
      {/* Above the repeaters, so the sheet at its middle height shows them. */}
      <div className="tool-actions">
        <Button variant="primary" size="lg" onClick={() => setMeshTool({ ...tool, view: "export", point: null })}>
          <ShareIcon size={18} />
          {t("tools.survey.export")}
        </Button>
        <Button variant="ghost" size="lg" className="survey-delete" onClick={remove}>
          <TrashIcon size={18} />
          {t("tools.survey.delete")}
        </Button>
      </div>
      {rows.length ? (
        <>
          <div className="survey-label">
            {t("tools.survey.repeaters")} <span>· {t("tools.survey.repeatersHint")}</span>
          </div>
          <ul className="list-rows hears" role="list">
            {rows.map((row) => {
              const on = tool.only === row.key;
              return (
                <li key={row.key}>
                  <button type="button" className={`row${on ? " selected" : ""}`} aria-pressed={on} onClick={() => setMeshTool({ ...tool, only: on ? null : row.key })}>
                    <RadioIcon size={18} />
                    <span className="row-main">
                      <span className="row-title">{surveyNodeName(survey, row.key)}</span>
                      <span className="row-sub muted">{t("tools.survey.atPoints", { count: row.count })}</span>
                    </span>
                    <QualityChip snr={replyScore(row.best)} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="tool-note muted">{t("tools.survey.noneAnswered")}</p>
      )}
    </div>
  );
}

function SurveyList({ list, run }: { list: Survey[]; run: SurveyRun | null }) {
  return (
    <div className="tool">
      <div className="tool-head">
        <IconButton label={t("common.back")} onClick={closeTool}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">{t("tools.survey.list")}</span>
          <span className="row-sub muted">{t("tools.survey.count", { count: list.length })}</span>
        </span>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <ul className="list-rows hears" role="list">
        {list.map((survey) => {
          const stats = surveyStats(survey);
          const running = run?.id === survey.id;
          return (
            <li key={survey.id}>
              <button type="button" className="row" onClick={() => openSurvey(running ? "run" : "summary", survey.id)}>
                <SurveyIcon size={18} />
                <span className="row-main">
                  <span className="row-title">{when(survey)}</span>
                  <span className="row-sub muted">
                    {running ? `${t("tools.survey.now")} · ` : ""}
                    {duration(stats.ms)} · {formatDistance(stats.km)} · {t("tools.survey.points", { count: stats.points })}
                  </span>
                </span>
                <ChevronRightIcon size={16} className="muted" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PointView({ survey, point }: { survey: Survey; point: SurveyPoint }) {
  const state = useSession();
  const replies = [...point.replies].sort((a, b) => replyScore(b) - replyScore(a));
  const today = new Date(point.at).toDateString() === new Date().toDateString();
  const at = point.at / 1000;
  return (
    <div className="tool">
      <div className="tool-head">
        <IconButton label={t("common.back")} onClick={closeTool}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">{t("tools.survey.point", { time: new Date(point.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })}</span>
          <span className="row-sub muted">
            {today ? "" : `${dayLabel(at)} · `}
            {t("tools.survey.pointSub", { m: Math.round(point.accuracy) })}
          </span>
        </span>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      {replies.length ? (
        <ul className="list-rows hears" role="list">
          {replies.map((r) => (
            <li key={r.key}>
              <div className="row">
                <RadioIcon size={18} />
                <span className="row-main">
                  <span className="row-title">{surveyNodeName(survey, r.key)}</span>
                  <span className="row-sub muted">{state.contacts[r.key] || survey.nodes[r.key]?.name ? t("tools.hears.youHear", { snr: formatSnr(r.them) }) : t("tools.hears.notContact")}</span>
                </span>
                <QualityChip snr={r.us} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tool-note muted">{t("tools.survey.pointNone")}</p>
      )}
      <div className="check-cost">
        <span className={`survey-dot ${pointTone(point)}`} />
        {t("tools.survey.colour")}
      </div>
    </div>
  );
}

const FORMATS: SurveyFormat[] = ["json", "gpx", "kml", "csv"];

function ExportView({ survey }: { survey: Survey }) {
  const [busy, setBusy] = useState<SurveyFormat | null>(null);
  const write = async (format: SurveyFormat) => {
    setBusy(format);
    try {
      const text = surveyFile(survey, format, (key) => surveyNodeName(survey, key));
      const how = await saveFile(surveyFileName(survey, format), text, FORMAT_TYPE[format], t("tools.survey.shareTitle"));
      if (how === "downloaded") toast(t("tools.survey.downloaded"), "", undefined, surveyFileName(survey, format));
    } catch (error) {
      toast(t("tools.survey.saveFailed"), "error", undefined, errorText(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="tool">
      <div className="tool-head">
        <IconButton label={t("common.back")} onClick={closeTool}>
          <BackIcon size={18} />
        </IconButton>
        <span className="row-main">
          <span className="row-title">{t("tools.survey.exportTitle")}</span>
          <span className="row-sub muted">
            {t("tools.survey.points", { count: survey.points.length })} · {when(survey)}
          </span>
        </span>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <ul className="list-rows hears" role="list">
        {FORMATS.map((format) => (
          <li key={format}>
            <button type="button" className="row" disabled={busy !== null} aria-busy={busy === format} onClick={() => void write(format)}>
              <FileIcon size={18} />
              <span className="row-main">
                <span className="row-title">{t(`tools.survey.format.${format}`)}</span>
                <span className="row-sub muted">{t(`tools.survey.format.${format}Hint`)}</span>
              </span>
              <ChevronRightIcon size={16} className="muted" />
            </button>
          </li>
        ))}
      </ul>
      <div className="check-cost">{isCapacitor() ? t("tools.survey.shareNote") : t("tools.survey.downloadNote")}</div>
      <div className="survey-label">{t("tools.survey.maps")}</div>
      <ul className="list-rows hears" role="list">
        {COVERAGE_MAPS.map((map) => (
          <SendToMap key={map.id} survey={survey} map={map} />
        ))}
      </ul>
    </div>
  );
}

/**
 * A community coverage map the survey can go to. Every send asks first, in
 * words that say the points leave for someone else's site and are public there.
 */
function SendToMap({ survey, map }: { survey: Survey; map: CoverageMap }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const native = canSendCoverage();
  const sent = survey.sent?.[map.id];
  const send = async () => {
    setAsking(false);
    setBusy(true);
    try {
      const reply = await sendSurvey(map, survey, (key) => surveyNodeName(survey, key));
      markSurveySent(survey.id, map.id, survey.points.length);
      toast(t("tools.survey.sentTo", { map: map.name }), "", undefined, t("tools.survey.sentDetail", { taken: reply.processed, known: reply.deduped, cells: reply.cellsCreated }));
    } catch (error) {
      toast(t("tools.survey.sendFailed", { map: map.name }), "error", undefined, errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const sub = !native
    ? t("tools.survey.sendAppOnly")
    : sent
      ? t("tools.survey.sentAt", { when: `${dayLabel(sent.at / 1000)}, ${timeOfDay(sent.at / 1000)}`, points: t("tools.survey.points", { count: sent.points }), host: map.host })
      : t("tools.survey.sendPublic", { host: map.host });
  return (
    <li>
      <button type="button" className="row" disabled={!native || busy || asking} aria-busy={busy} onClick={() => setAsking(true)}>
        <ShareIcon size={18} />
        <span className="row-main">
          <span className="row-title">{t("tools.survey.sendTo", { map: map.name })}</span>
          <span className="row-sub muted">{sub}</span>
        </span>
        <ChevronRightIcon size={16} className="muted" />
      </button>
      {asking ? (
        <div className="survey-agree">
          <p>{t("tools.survey.agree", { points: t("tools.survey.points", { count: survey.points.length }), host: map.host })}</p>
          <div className="tool-actions">
            <Button variant="primary" onClick={() => void send()}>
              {t("tools.survey.agreeSend", { host: map.host })}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
