import { useEffect, useState } from "react";
import { NeighbourOrder, neighbourSearchMs, NoReplyError, type ContactRecord } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t, type Key } from "../../i18n/index.js";
import { ago } from "../../lib/format.js";
import { quality } from "../../lib/los.js";
import { keepSearch, searchNeighbours, useNeighbourSearch, type NeighbourSearchState } from "../../lib/neighbourSearch.js";
import { isAdmin } from "../../lib/nodes.js";
import { session, useSession } from "../../lib/session.js";
import { openNeighbours } from "../../lib/toolActions.js";
import { Button } from "../../ui/Button.js";
import { Avatar } from "../Avatar.js";
import { AirIcon, CheckIcon, DownIcon, MapIcon, RefreshIcon } from "../Icons.js";

const ORDERS: { order: number; label: Key }[] = [
  { order: NeighbourOrder.Newest, label: "node.neighbours.newest" },
  { order: NeighbourOrder.Strongest, label: "node.neighbours.strongest" },
  { order: NeighbourOrder.Weakest, label: "node.neighbours.weakest" },
  { order: NeighbourOrder.Oldest, label: "node.neighbours.oldest" },
];

/** The SNR bars share one scale, marked at zero. */
const SNR_LOW = -20;
const SNR_HIGH = 15;

export function Neighbours({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const list = state.neighbours[key];
  const online = state.status === "ready";
  const search = useNeighbourSearch(key);
  const searching = search?.running ?? false;
  // A search's outcome stands until the list is read again after it.
  const outcome = search && !searching && (list?.at ?? 0) <= search.at ? search : null;
  const [order, setOrder] = useState<number>(list?.order ?? NeighbourOrder.Newest);
  const [busy, setBusy] = useState<"page" | "more" | null>(null);
  // An error stands until an answer newer than it comes in: one that came late says the node heard.
  const [error, setError] = useState<{ text: string; at: number } | null>(null);

  const fetch = async (nextOrder: number, offset: number) => {
    setBusy(offset > 0 ? "more" : "page");
    setError(null);
    try {
      const read = await session.requestNeighbours(key, { order: nextOrder, offset });
      // More of the list the search read is still that list.
      if (offset > 0 && outcome) keepSearch(key, read.at);
    } catch (e) {
      setError({ text: e instanceof NoReplyError ? t("node.neighbours.noReply", { seconds: /(\d+) s$/.exec(e.message)?.[1] ?? "?" }) : errorText(e), at: Date.now() });
    } finally {
      setBusy(null);
    }
  };

  const startSearch = () => {
    // The neighbours that answer come first in the list the search reads: they were heard last.
    setOrder(NeighbourOrder.Newest);
    setError(null);
    void searchNeighbours(key);
  };

  const pct = (snr: number) => ((Math.max(SNR_LOW, Math.min(SNR_HIGH, snr)) - SNR_LOW) / (SNR_HIGH - SNR_LOW)) * 100;
  const rows = list?.neighbours ?? [];
  const more = list ? list.total - rows.length : 0;
  const fresh = new Set(outcome?.fresh ?? []);
  const self = state.self;
  const waitMs = self && self.bandwidthHz > 0 ? neighbourSearchMs(self) : 12_000;

  return (
    <div className="card-scroll">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label={t("node.neighbours.order")}>
          {ORDERS.map((o) => (
            <button
              key={o.order}
              type="button"
              className={order === o.order ? "on" : ""}
              disabled={!online || busy !== null || searching}
              onClick={() => {
                setOrder(o.order);
                void fetch(o.order, 0);
              }}
            >
              {t(o.label)}
            </button>
          ))}
        </div>
        <span className="row-actions">
          <span className="muted small">{list ? t("node.neighbours.summary", { total: list.total, shown: rows.length, time: ago(list.at) }) : t("node.notAskedYet")}</span>
          <Button size="sm" busy={busy === "page"} disabled={!online || searching} onClick={() => void fetch(order, 0)}>
            <RefreshIcon size={13} />
            {list ? t("node.refresh") : t("node.neighbours.ask")}
          </Button>
          <Button size="sm" disabled={!online && !list?.neighbours.length} onClick={() => openNeighbours(key)}>
            <MapIcon size={13} />
            {t("node.neighbours.onMap")}
          </Button>
        </span>
      </div>

      {/* The repeater takes the command from an admin only, so a guest is not offered it. */}
      {isAdmin(state.logins[key]) ? <SearchStrip search={searching ? search : outcome} waitMs={waitMs} disabled={!online || busy !== null} onSearch={startSearch} /> : null}

      {error && (list?.at ?? 0) < error.at ? <p className="connect-error">{error.text}</p> : null}

      {list ? (
        rows.length === 0 ? (
          <p className="muted">{t("node.neighbours.none")}</p>
        ) : (
          <section className="section">
            {/* One row per neighbour rather than a table's columns, which a phone has no room for. */}
            <ul className="list-rows nb-page-rows" role="list">
              {rows.map((r) => {
                const known = session.contactByPrefix(r.prefix);
                const isNew = fresh.has(r.prefix);
                return (
                  <li key={r.prefix} className={isNew ? "nb-page-row fresh" : "nb-page-row"}>
                    <Avatar name={known?.name || r.prefix} type={known?.type ?? 2} size={32} />
                    <span className="row-main">
                      <span className="row-title">
                        {known?.name || <code>{r.prefix}</code>}
                        {isNew ? <span className="nb-new">{t("node.search.new")}</span> : null}
                      </span>
                      <span className="row-sub muted">
                        {known ? <code>{r.prefix}</code> : t("node.notInContacts")} · {ago(Date.now() - r.heardSecsAgo * 1000)}
                      </span>
                    </span>
                    <span className="snr">
                      <span className="snr-value">{t("node.unit.decibels", { value: `${r.snr > 0 ? "+" : ""}${r.snr.toFixed(2)}` })}</span>
                      <span className="snr-track">
                        <i className={quality(r.snr)} style={{ width: `${pct(r.snr)}%` }} />
                        <span className="snr-zero" style={{ left: `${pct(0)}%` }} />
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )
      ) : (
        <p className="muted">{t("node.neighbours.intro")}</p>
      )}

      <div className="row-actions wrap">
        {more > 0 ? (
          <Button size="sm" busy={busy === "more"} disabled={!online || searching} onClick={() => void fetch(list!.order, rows.length)}>
            <DownIcon size={13} />
            {t("node.neighbours.loadMore", { count: Math.min(more, 10) })}
          </Button>
        ) : null}
        <span className="field-hint">{t("node.neighbours.hint", { low: SNR_LOW, high: SNR_HIGH })}</span>
      </div>
    </div>
  );
}

/**
 * The search in one place above the list: the button, then how far the
 * search has got, then what it found, with the way to search again.
 */
function SearchStrip({ search, waitMs, disabled, onSearch }: { search: NeighbourSearchState | null; waitMs: number; disabled: boolean; onSearch: () => void }) {
  const [, tick] = useState(0);
  const counting = !!search?.running && search.until !== null;

  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [counting]);

  const again = (
    <Button size="sm" disabled={disabled} onClick={onSearch}>
      {t("node.search.again")}
    </Button>
  );

  if (!search) {
    return (
      <button type="button" className="nb-search" disabled={disabled} onClick={onSearch}>
        <AirIcon size={16} />
        <span className="nb-search-text">
          <span className="nb-search-title">{t("node.search.button")}</span>
          <span className="nb-search-hint">{t("node.search.hint", { seconds: Math.round(waitMs / 1000) })}</span>
        </span>
      </button>
    );
  }

  if (search.running) {
    const left = search.until === null ? null : search.until - Date.now();
    const text = left === null ? t("node.search.sending") : left > 0 ? t("node.search.waiting", { seconds: Math.ceil(left / 1000) }) : t("node.search.reading");
    return (
      <div className="nb-progress" role="status">
        <span className="nb-progress-line">
          {text}
          <span className="spinner" aria-hidden="true" />
        </span>
        {left !== null && left > 0 ? (
          <span className="nb-progress-bar" aria-hidden="true">
            <i style={{ width: `${(1 - left / Math.max(1, search.waitMs)) * 100}%` }} />
          </span>
        ) : null}
      </div>
    );
  }

  if (search.error) {
    return (
      <div className="nb-progress bad" role="status">
        <span className="nb-progress-line">
          {search.error}
          {again}
        </span>
      </div>
    );
  }

  if (search.answered.length === 0) {
    return (
      <div className="nb-progress quiet" role="status">
        <span className="nb-progress-line">
          {t("node.search.nobody", { seconds: Math.round(search.waitMs / 1000) })}
          {again}
        </span>
        <span className="nb-search-hint">{t("node.search.nobodyWhy")}</span>
      </div>
    );
  }

  const answered = t("node.search.answered", { count: search.answered.length });
  const fresh = search.fresh === null ? null : search.fresh.length ? t("node.search.fresh", { count: search.fresh.length }) : t("node.search.noneNew");
  return (
    <div className="nb-progress good" role="status">
      <span className="nb-progress-line">
        <span className="nb-found">
          <CheckIcon size={14} />
          {fresh ? `${answered} · ${fresh}` : answered}
        </span>
        {again}
      </span>
    </div>
  );
}
