import { t } from "../i18n/index.js";
import { closeWindow, frameKind, minimizeWindow, toggleMaximized, useWindowState } from "../lib/frame.js";
import { useSelector } from "../lib/session.js";

/**
 * The window's title bar on the desktop, drawn in the theme instead of the system's (lib/frame.ts).
 * The bar itself moves the window, and a double click on it fills the screen, as the
 * system's does; the icon and the title let the press through to it.
 */
export function TitleBar() {
  const kind = frameKind();
  const radio = useSelector((state) => state.self?.name ?? null);
  const { maximized } = useWindowState();
  if (!kind) return null;
  // The same as the window's own title, which names the radio once it is known (tray.rs).
  const title = radio ? `${radio} — Ommesh` : "Ommesh";
  const buttons = kind !== "macos";
  return (
    <header className="titlebar" data-tauri-drag-region>
      {buttons && <img className="titlebar-icon" src="./icon.svg" alt="" width={16} height={16} />}
      <span className="titlebar-title">{title}</span>
      {buttons && (
        <div className="titlebar-buttons">
          <button type="button" title={t("app.window.minimize")} aria-label={t("app.window.minimize")} onClick={minimizeWindow}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5.5h10" />
            </svg>
          </button>
          <button
            type="button"
            title={maximized ? t("app.window.restore") : t("app.window.maximize")}
            aria-label={maximized ? t("app.window.restore") : t("app.window.maximize")}
            onClick={toggleMaximized}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0.5 2.5h7v7h-7z M2.5 2.5v-2h7v7h-2" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0.5 0.5h9v9h-9z" />
              </svg>
            )}
          </button>
          <button type="button" className="titlebar-close" title={t("app.window.close")} aria-label={t("app.window.close")} onClick={closeWindow}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}
