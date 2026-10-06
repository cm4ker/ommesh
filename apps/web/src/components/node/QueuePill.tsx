import { useEffect, useState } from "react";
import { t, type Key } from "../../i18n/index.js";
import { session, useSession } from "../../lib/session.js";

/** The session's names for its requests; anything else is a console command, shown as typed. */
const JOBS: Record<string, Key> = {
  "sign in": "node.queue.job.signIn",
  "sign in by flood": "node.queue.job.renewWayBack",
  status: "node.queue.job.status",
  telemetry: "node.queue.job.telemetry",
  "path discovery": "node.queue.job.pathDiscovery",
  neighbours: "node.queue.job.neighbours",
  "more neighbours": "node.queue.job.moreNeighbours",
  "discover.neighbors": "node.queue.job.neighbourSearch",
  "neighbor.remove ": "node.queue.job.neighbourReset",
  "access list": "node.queue.job.accessList",
  "owner info": "node.queue.job.ownerInfo",
  "min/max/avg": "node.queue.job.series",
};

function job(label: string): string {
  const key = JOBS[label];
  return key ? t(key) : label;
}

/**
 * What the radio is waiting on. It carries one request to a remote node at
 * a time, so this is where a second click goes to wait, visibly.
 */
export function QueuePill({ nodeKey }: { nodeKey: string }) {
  const state = useSession();
  const { active, queued } = state.remote;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return (
      <span className="queue" title={t("node.queue.idleTitle")}>
        <span className="dot" aria-hidden="true" />
        <span className="queue-label">{t("node.queue.idle")}</span>
      </span>
    );
  }
  const name = (key: string) => (key === nodeKey ? "" : `${state.contacts[key]?.name ?? key.slice(0, 12)}: `);
  const secs = active.startedAt ? ((Date.now() - active.startedAt) / 1000).toFixed(1) : "0.0";
  const title = [t("node.queue.onAir", { job: `${name(active.key)}${job(active.label)}` }), ...queued.map((j) => `${name(j.key)}${job(j.label)}`)].join("\n");
  return (
    <span className="queue busy" title={title} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="queue-label">
        {name(active.key)}
        {job(active.label)} · {t("node.unit.seconds", { value: secs })}
      </span>
      {queued.length > 0 ? (
        <button type="button" className="queue-more" title={`${title}\n\n${t("node.queue.drop", { count: queued.length })}`} onClick={() => queued.forEach((j) => session.cancelRemote(j.id))}>
          +{queued.length}
        </button>
      ) : null}
    </span>
  );
}
