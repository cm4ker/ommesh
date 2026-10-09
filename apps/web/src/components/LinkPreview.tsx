import { useEffect, useMemo, useRef } from "react";
import { locale, t } from "../i18n/index.js";
import { markSeen, tapLink, useLinkPreview, usePreviewMode } from "../lib/linkPreview.js";
import { durationLabel, linkAllowed, type Preview } from "../lib/linkPreviewParse.js";
import { LINK, linkOf, openLink } from "../lib/webLinks.js";
import { PreviewIcon, RefreshIcon } from "./Icons.js";

/**
 * The mark after a link that shows its preview: the size of a letter, so the
 * line keeps its height, with a target wider than it looks (the margins take
 * the padding back). Grey shows the preview, blue folds it away, a turning
 * ring is a fetch under way, the arrow tries a failed one again. A page that
 * has nothing to show loses its mark, and so does every link a preview comes
 * to by itself when previews are at once.
 */
export function LinkMark({ href, message }: { href: string; message: string }) {
  const { entry, folded } = useLinkPreview(href, message);
  const mode = usePreviewMode();
  // With previews at once there is nothing to tap while one comes by itself:
  // only a link whose preview failed keeps a mark, to try again. An empty spot
  // stays to tell when the link is on screen.
  const quiet = mode === "auto" && entry?.state !== "failed";
  const gone = entry?.state === "none";
  const self = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = self.current;
    if (!node) return;
    let seen = false;
    const watch = new IntersectionObserver(([change]) => {
      const now = change?.isIntersecting ?? false;
      if (now === seen) return;
      seen = now;
      markSeen(href, now);
    });
    watch.observe(node);
    return () => {
      watch.disconnect();
      if (seen) markSeen(href, false);
    };
  }, [href, quiet, gone]);

  if (gone) return null;
  if (quiet)
    return (
      <span
        ref={(node) => {
          self.current = node;
        }}
        className="link-spot"
        aria-hidden="true"
      />
    );
  const open = entry?.state === "shown" && !folded;
  const label = entry?.state === "loading" ? t("chats.preview.loading") : entry?.state === "failed" ? t("chats.preview.retry") : open ? t("chats.preview.hide") : t("chats.preview.show");
  return (
    <button
      ref={(node) => {
        self.current = node;
      }}
      type="button"
      className={["link-mark", open ? "open" : ""].join(" ")}
      aria-label={label}
      title={label}
      aria-expanded={entry?.state === "shown" ? open : undefined}
      // Not `disabled`: a disabled button would let a tap through to the bubble under it.
      aria-busy={entry?.state === "loading" ? true : undefined}
      // The bubble opens the message's details on a tap and its menu on a hold; this does neither.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        tapLink(href, message);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {entry?.state === "loading" ? <span className="link-mark-spin" /> : entry?.state === "failed" ? <RefreshIcon /> : <PreviewIcon />}
    </button>
  );
}

/** The links of a message that may have a preview, each once, in order. */
function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK)) {
    const href = linkOf(m[0])?.href;
    if (href && linkAllowed(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

/** The previews of a message's links that are open, under its text. */
export function LinkCards({ text, message }: { text: string; message: string }) {
  const hrefs = useMemo(() => linksIn(text), [text]);
  return (
    <>
      {hrefs.map((href) => (
        <LinkCardSlot key={href} href={href} message={message} />
      ))}
    </>
  );
}

function LinkCardSlot({ href, message }: { href: string; message: string }) {
  const { entry, folded } = useLinkPreview(href, message);
  // At once has no mark to unfold with, so a fold made before stays undone there.
  const auto = usePreviewMode() === "auto";
  if (entry?.state !== "shown" || (folded && !auto)) return null;
  return <LinkCard href={href} preview={entry.preview} picture={entry.picture} />;
}

/** A file's size in the reader's units and decimal mark. */
function sizeText(bytes: number): string {
  const number = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 1 });
  return bytes >= 1024 * 1024 ? t("chats.preview.mb", { size: number(bytes / 1024 / 1024) }) : t("chats.preview.kb", { size: number(Math.max(1, bytes / 1024)) });
}

/**
 * A preview: the host it came from, which is the one thing a page cannot
 * choose for itself, then its title, its description and its picture, beside
 * the text or across the card when the page asks for that. A tap opens the
 * link, as the link does.
 */
function LinkCard({ href, preview, picture }: { href: string; preview: Preview; picture: string | null }) {
  const own = {
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    draggable: false,
    onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onClick: (e: { preventDefault(): void; stopPropagation(): void }) => {
      e.preventDefault();
      e.stopPropagation();
      openLink(href);
    },
  };

  if (preview.kind === "picture" && picture) {
    return (
      <a className="link-card picture" {...own} aria-label={t("chats.preview.picture", { host: preview.host })}>
        <img src={picture} alt="" />
      </a>
    );
  }
  if (preview.kind === "file" || preview.kind === "picture") {
    const file = preview.file;
    return (
      <a className="link-card file" {...own}>
        <span className="link-card-badge">{file?.mark ?? "FILE"}</span>
        <span className="link-card-text">
          <span className="link-card-title">{file?.name ?? preview.host}</span>
          <span className="link-card-sub">{[file?.size ? sizeText(file.size) : null, preview.host].filter(Boolean).join(" · ")}</span>
        </span>
      </a>
    );
  }
  const across = picture !== null && preview.large;
  return (
    <a className={["link-card", across ? "large" : ""].join(" ")} {...own}>
      <span className="link-card-text">
        <span className="link-card-host">{preview.host}</span>
        {preview.title ? <span className="link-card-title">{preview.title}</span> : null}
        {preview.description ? <span className="link-card-desc">{preview.description}</span> : null}
      </span>
      {picture && !across ? <img className="link-card-thumb" src={picture} alt="" /> : null}
      {across ? (
        <span className="link-card-pic">
          <img src={picture} alt="" />
          {preview.video ? (
            <span className="link-card-play" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            </span>
          ) : null}
          {preview.duration ? <span className="link-card-time">{durationLabel(preview.duration)}</span> : null}
        </span>
      ) : null}
    </a>
  );
}
