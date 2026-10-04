import { useState } from "react";
import { language, t } from "../i18n/index.js";
import { closeNewsStrip, fixes, fixWords, newThings, openNews, releaseDay, showTarget, thingWords, useNews, type Release } from "../lib/news.js";
import { push } from "../lib/nav.js";
import { looksForBuilds, useNewBuild } from "../lib/newBuild.js";
import { openLink } from "../lib/webLinks.js";
import { IconButton } from "../ui/Button.js";
import { ActionRow, Group, LinkRow } from "../ui/List.js";
import { ChevronRightIcon, CloseIcon, ExternalIcon } from "./Icons.js";
import { download } from "./NewBuild.js";

/**
 * What's new: what each version brought, from the news files the app
 * carries (lib/news.ts), so it reads with no network. The versions this
 * launch brought are open, older ones a row each; on an APK from GitHub a
 * version that is out but not installed yet stands on top, with Download.
 */

/** The strip over the chats after an update, once: What's new, or the cross. */
export function NewsStrip() {
  const news = useNews();
  const newest = news.releases[0];
  if (!news.strip || !newest) return null;
  return (
    <div className="memory-strip news" role="status">
      <span className="grow">{t("app.news.strip", { version: newest.version })}</span>
      <button type="button" className="memory-act" onClick={openNews}>
        {t("app.news.open")}
      </button>
      <IconButton className="strip-close" label={t("app.news.hide")} onClick={closeNewsStrip}>
        <CloseIcon size={16} />
      </IconButton>
    </div>
  );
}

/** About's way in, with the newest version told. */
export function NewsRow() {
  const newest = useNews().releases[0];
  if (!newest) return null;
  return <LinkRow label={t("radio.titles.news")} value={newest.version} onClick={() => push({ kind: "radio", page: "news" })} />;
}

/**
 * One version: its new things, each with Show where it has a place in the
 * app, and its fixes folded into one row. `actions` is off where the version
 * is not installed yet, as in the desktop's update dialog: there is nothing
 * to show yet.
 */
export function ReleaseNews({ release, actions = true, note }: { release: Release; actions?: boolean; note?: string }) {
  const [fixesOpen, setFixesOpen] = useState(false);
  const fixed = fixes(release);
  return (
    <Group title={`${release.version} · ${releaseDay(release.date)}`} note={note}>
      {newThings(release).map((item, i) => {
        const words = thingWords(item);
        const go = actions && item.show ? showTarget(item.show) : null;
        const text = (
          <span className="line-text">
            <span className="news-title">{words.title}</span>
            <small className="news-text">{words.text}</small>
            {/* Under the text rather than at the row's edge, where it would squeeze the text into a column. */}
            {go ? (
              <small className="news-show">
                {t("app.news.show")}
                <ChevronRightIcon size={12} />
              </small>
            ) : null}
          </span>
        );
        return go ? (
          <button key={i} type="button" className="line line-link" onClick={go}>
            {text}
          </button>
        ) : (
          <div key={i} className="line">
            {text}
          </div>
        );
      })}
      {fixed.length ? (
        <LinkRow
          label={t("app.news.fixed", { count: fixed.length })}
          onClick={() => setFixesOpen(!fixesOpen)}
          trailing={<ChevronRightIcon size={14} className={["line-chev", "news-fold", fixesOpen ? "open" : ""].join(" ")} />}
        />
      ) : null}
      {fixesOpen
        ? fixed.map((item, i) => (
            <div key={`fix-${i}`} className="line news-fix">
              <span className="line-text">
                <small className="news-text">{fixWords(item)}</small>
              </span>
            </div>
          ))
        : null}
    </Group>
  );
}

function summary(release: Release): string {
  const parts = [];
  const things = newThings(release).length;
  const fixed = fixes(release).length;
  if (things) parts.push(t("app.news.things", { count: things }));
  if (fixed) parts.push(t("app.news.fixes", { count: fixed }));
  return parts.join(" · ");
}

export function NewsPage() {
  const news = useNews();
  const build = useNewBuild();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([...news.fresh, ...news.releases.slice(0, 1).map((r) => r.version)]));
  // On an APK from GitHub, the version the feed told of and this one has not.
  const coming = looksForBuilds() && build.latest ? build.news : null;
  const changelog = `https://github.com/cm4ker/ommesh/blob/master/${language() === "ru" ? "CHANGELOG.ru.md" : "CHANGELOG.md"}`;
  const closed = news.releases.filter((r) => !open.has(r.version));
  return (
    <div className="news">
      {coming ? (
        <>
          <ReleaseNews release={coming} actions={false} note={t("app.news.notInstalled")} />
          <Group>
            <ActionRow label={t("app.newBuild.downloadVersion", { version: build.latest! })} onClick={download} />
          </Group>
        </>
      ) : null}
      {news.releases.filter((r) => open.has(r.version)).map((r) => <ReleaseNews key={r.version} release={r} />)}
      {closed.length ? (
        <Group title={t("app.news.earlier")}>
          {closed.map((r) => (
            <LinkRow key={r.version} label={r.version} hint={summary(r)} value={releaseDay(r.date)} onClick={() => setOpen(new Set([...open, r.version]))} />
          ))}
        </Group>
      ) : null}
      <Group>
        <LinkRow label={t("app.news.changelog")} hint={t("app.news.changelogHint")} tone="accent" trailing={<ExternalIcon size={14} className="line-chev" />} onClick={() => openLink(changelog)} />
      </Group>
    </div>
  );
}
