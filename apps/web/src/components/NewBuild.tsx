import { push } from "../lib/nav.js";
import { checkForBuild, hideStrip, looksForBuilds, newestApk, stripShown, useNewBuild } from "../lib/newBuild.js";
import { IconButton } from "../ui/Button.js";
import { LinkRow } from "../ui/List.js";
import { CloseIcon } from "./Icons.js";
import { t } from "../i18n/index.js";

/**
 * Opens the newest APK outside the app. Capacitor hands a page's navigation
 * off its own host to the phone, whose browser downloads the file; installed
 * over this build, it keeps the chats and settings.
 */
export function download(): void {
  window.open(newestApk(), "_blank", "noopener");
}

/**
 * The strip over the chats while a newer build is out: the first thing seen on opening the app.
 * With the version's news it opens What's new, which has Download under them.
 */
export function NewBuildStrip() {
  const build = useNewBuild();
  if (!looksForBuilds() || !stripShown(build) || !build.latest) return null;
  return (
    <div className="memory-strip news" role="status">
      {build.news ? (
        <>
          <span className="grow">{t("app.newBuild.out", { version: build.latest })}</span>
          <button type="button" className="memory-act" onClick={() => push({ kind: "radio", page: "news" })}>
            {t("app.news.open")}
          </button>
        </>
      ) : (
        <>
          <span className="grow">{t("app.newBuild.strip", { version: build.latest })}</span>
          <button type="button" className="memory-act" onClick={download}>
            {t("app.newBuild.download")}
          </button>
        </>
      )}
      <IconButton className="strip-close" label={t("app.newBuild.hide")} onClick={() => hideStrip()}>
        <CloseIcon size={16} />
      </IconButton>
    </div>
  );
}

/** About's row for the newest build: it downloads one that is newer, or looks again. */
export function NewBuildRow() {
  const build = useNewBuild();
  if (!looksForBuilds()) return null;
  if (build.latest) {
    return <LinkRow label={t("app.newBuild.newest")} value={build.latest} tone="accent" onClick={download} />;
  }
  return (
    <LinkRow
      label={t("app.newBuild.newest")}
      value={build.checking ? t("app.newBuild.checking") : build.checkedAt ? t("app.newBuild.yours") : undefined}
      disabled={build.checking}
      onClick={() => void checkForBuild()}
    />
  );
}
