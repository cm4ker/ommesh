import { t } from "../../i18n/index.js";
import { CLI_GROUPS, CLI_GROUP_TITLE, commandsFor, type CliContext, type CliTarget } from "../../lib/cli.js";
import { ChevronRightIcon } from "../Icons.js";

/**
 * Every command a console answers, out in the open: grouped by what it is for,
 * each with a line about what it does. A tap puts it in the field. The field
 * over it (`SearchField`) finds one by its name or by a word from that line:
 * "battery" finds what reads it.
 */
export function CommandList({ target, ctx, query, onPick }: { target: CliTarget; ctx?: CliContext; query: string; onPick: (command: string) => void }) {
  const list = commandsFor(target, ctx);
  const words = query.trim().toLowerCase();
  const found = list.filter((command) => !words || command.text.toLowerCase().includes(words) || t(command.about).toLowerCase().includes(words));
  return (
    <>
      <p className="cli-note">{t("cli.note")}</p>
      <div className="list">
        {found.length === 0 ? <p className="empty muted">{t("cli.noMatch")}</p> : null}
        {CLI_GROUPS.map((group) => {
          const rows = found.filter((command) => command.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group}>
              <div className="list-group">{t(CLI_GROUP_TITLE[group])}</div>
              {rows.map((command) => (
                <button key={command.text} type="button" className="row cli-row" onClick={() => onPick(command.text)}>
                  <span className="row-main">
                    <span className="row-title">{command.text.trim()}</span>
                    <span className="row-sub">{t(command.about)}</span>
                  </span>
                  <span className="cli-chev" aria-hidden="true">
                    <ChevronRightIcon size={14} />
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
