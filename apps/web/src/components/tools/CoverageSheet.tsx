/**
 * A cell tapped on the community coverage layer (lib/coverage/layer.ts):
 * its size and dates, how many pings went from there and how well repeaters
 * answered, the repeaters heard best (each tapping straight to that node on
 * the map when it is among the contacts), who measured it when signed, and a
 * refresh button for fresh data from nw.ommesh.ru.
 */

import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { agoPhrase, dayLabel, timeOfDay } from "../../lib/format.js";
import { formatRoundDistance } from "../../lib/geo.js";
import { formatSnr } from "../../lib/los.js";
import { setMeshTool, type CoverageTool } from "../../lib/meshTool.js";
import { showOnMap } from "../../lib/nav.js";
import { useSession } from "../../lib/session.js";
import { contactForCoverageNode, findCoverageCell, type CommunityCell } from "../../lib/coverage/community.js";
import { refreshCoverage, useCoverageLayer } from "../../lib/coverage/layer.js";
import { COMMUNITY_COVERAGE_MAP } from "../../lib/coverage/maps.js";
import { closeAllTools } from "../../lib/toolActions.js";
import { openLink } from "../../lib/webLinks.js";
import { Button, IconButton } from "../../ui/Button.js";
import { CloseIcon, ExternalIcon, RadioIcon, RefreshIcon } from "../Icons.js";
import { QualityChip } from "./RouteSheet.js";

/** Repeaters shown before offering "Show more": a coarse 6.4 km cell can hold dozens. */
const INITIAL_NODES = 8;

function cellWhen(cell: CommunityCell): string {
  const from = cell.firstAt / 1000;
  const to = cell.lastAt / 1000;
  if (cell.firstAt === cell.lastAt || cell.lastAt - cell.firstAt < 3_600_000) {
    return `${dayLabel(to)}, ${timeOfDay(to)}`;
  }
  const start = dayLabel(from);
  const end = dayLabel(to);
  return start === end ? `${end}, ${timeOfDay(from)}–${timeOfDay(to)}` : `${start} – ${end}`;
}

export function CoverageSheet({ tool }: { tool: CoverageTool }) {
  const state = useSession();
  const coverage = useCoverageLayer();
  const [showAll, setShowAll] = useState(false);
  const found = findCoverageCell(coverage.on ? coverage.data : null, tool.cellId);

  useEffect(() => {
    setShowAll(false);
  }, [tool.cellId]);

  // Gone after toggling the layer off or refreshing into data without this cell.
  useEffect(() => {
    if (!found) setMeshTool(null);
  }, [found]);

  if (!found || !coverage.data) return null;
  const { level, cell } = found;
  const visibleNodes = showAll ? cell.nodes : cell.nodes.slice(0, INITIAL_NODES);
  const moreCount = cell.nodes.length - visibleNodes.length;
  const hasNamedSenders = cell.senders.some(([key]) => key !== "");
  const sendersText = hasNamedSenders
    ? cell.senders
        .map(([key, name, n]) => {
          const contact = key ? contactForCoverageNode(state.contacts, key) : null;
          const who = !key ? t("tools.coverage.unnamed") : contact ? contact.name || contact.prefix : name || key.slice(0, 8).toUpperCase();
          return cell.senders.length > 1 ? `${who} (${n})` : who;
        })
        .join(", ")
    : null;
  const sourceLine = coverage.fetchedAt
    ? t("tools.coverage.sourceUpdated", { host: COMMUNITY_COVERAGE_MAP.host, days: coverage.data.days, time: agoPhrase(coverage.fetchedAt) })
    : t("tools.coverage.source", { host: COMMUNITY_COVERAGE_MAP.host, days: coverage.data.days });

  return (
    <div className="tool">
      <div className="tool-head">
        <span className="row-main">
          <span className="row-title">{t("tools.coverage.cellTitle")}</span>
          <span className="row-sub muted">{t("tools.coverage.cellSub", { size: formatRoundDistance(level.cellM / 1000), when: cellWhen(cell) })}</span>
        </span>
        <IconButton label={t("tools.coverage.refresh")} disabled={coverage.loading} onClick={() => void refreshCoverage(true)}>
          <RefreshIcon size={17} className={coverage.loading ? "spin" : undefined} />
        </IconButton>
        <IconButton label={t("common.close")} onClick={closeAllTools}>
          <CloseIcon size={18} />
        </IconButton>
      </div>
      <div className="coverage-tone">
        <span className={`survey-dot ${cell.tone}`} aria-hidden="true" />
        <span>{t(`tools.coverage.tone.${cell.tone}`)}</span>
      </div>
      <div className="survey-stats">
        <span>
          <b>{cell.n}</b>
          {t("tools.coverage.stat.pings", { count: cell.n })}
        </span>
        <span>
          <b>{cell.n ? Math.round((cell.ok / cell.n) * 100) : 0} %</b>
          {t("tools.coverage.stat.answered")}
        </span>
        <span>
          <b>{cell.snr !== null ? formatSnr(cell.snr) : "—"}</b>
          {t("tools.coverage.stat.median")}
        </span>
        <span>
          <b>{cell.best !== null ? formatSnr(cell.best) : "—"}</b>
          {t("tools.coverage.stat.best")}
        </span>
      </div>
      {cell.nodes.length ? (
        <>
          <div className="survey-label">{t("tools.survey.repeaters")}</div>
          <ul className="list-rows hears" role="list">
            {visibleNodes.map(([key, name, n, best]) => {
              const contact = contactForCoverageNode(state.contacts, key);
              const title = contact ? contact.name || contact.prefix : name || t("tools.hears.repeater", { id: key.slice(0, 8) });
              const pings = t("tools.coverage.nodePings", { count: n });
              const body = (
                <>
                  <RadioIcon size={18} />
                  <span className="row-main">
                    <span className="row-title">{title}</span>
                    <span className="row-sub muted">{contact ? pings : t("tools.coverage.nodeNotContact", { pings })}</span>
                  </span>
                  {best !== null ? <QualityChip snr={best} /> : null}
                </>
              );
              return (
                <li key={`${key}:${name}`}>
                  {contact ? (
                    <button
                      type="button"
                      className="row"
                      onClick={() => {
                        setMeshTool(null);
                        showOnMap(contact.key);
                      }}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="row">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {moreCount > 0 ? (
            <Button size="sm" variant="ghost" className="coverage-more" onClick={() => setShowAll(true)}>
              {t("tools.coverage.showMore", { count: moreCount })}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="tool-note muted">{t("tools.survey.pointNone")}</p>
      )}
      {sendersText ? <p className="tool-note muted">{t("tools.coverage.senders", { list: sendersText })}</p> : null}
      <div className="coverage-foot">
        <span className="muted">{sourceLine}</span>
        <button type="button" className="link" onClick={() => openLink(COMMUNITY_COVERAGE_MAP.siteUrl)}>
          {t("tools.coverage.openSite")}
          <ExternalIcon size={12} />
        </button>
      </div>
    </div>
  );
}
