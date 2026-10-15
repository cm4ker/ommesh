import { AdvType, isNodeType } from "@meshnet/meshcore";
import { t, type Key } from "../../i18n/index.js";
import { openNodePage, type NodePage } from "../../lib/nav.js";
import { isAdmin, nodeKindName } from "../../lib/nodes.js";
import { useSession } from "../../lib/session.js";
import { Avatar } from "../Avatar.js";
import { LockIcon } from "../Icons.js";
import { nodePages } from "../Profile.js";
import { Gone, ScreenHead, type Chrome } from "../ScreenHead.js";
import { Access } from "./Access.js";
import { Console } from "./Console.js";
import { History } from "./History.js";
import { Neighbours } from "./Neighbours.js";
import { QueuePill } from "./QueuePill.js";
import { PushPage } from "./SensorPush.js";
import { Settings } from "./Settings.js";

const LABELS: Record<NodePage, Key> = {
  neighbours: "node.page.neighbours",
  history: "node.page.history",
  settings: "node.page.settings",
  access: "node.page.access",
  console: "node.page.console",
  push: "node.page.push",
};
const ADMIN_ONLY = new Set<NodePage>(["settings", "access", "console"]);

/**
 * One of a node's own screens. On a phone it is pushed over the profile, one
 * page at a time; on a desktop it takes the width, with its sibling pages as
 * tabs, because a console and a settings form need room.
 */
export function NodePageView({ contactKey, page, chrome, tabs }: { contactKey: string; page: NodePage; chrome: Chrome; tabs: boolean }) {
  const state = useSession();
  const contact = state.contacts[contactKey];
  // A person's radio has a console of its own, with nothing to sign in to (MeshCore 1.18).
  if (contact?.type === AdvType.Chat && page === "console") {
    const name = contact.name || contact.prefix;
    return (
      <div className="screen node">
        <ScreenHead chrome={chrome} actions={<QueuePill nodeKey={contact.key} />}>
          <Avatar name={name} type={contact.type} size={28} />
          <span className="screen-name-stack">
            <span className="screen-name">{t("mesh.profile.console")}</span>
            <span className="muted small">{name}</span>
          </span>
        </ScreenHead>
        <Console contact={contact} />
      </div>
    );
  }
  if (!contact || !isNodeType(contact.type)) return <Gone chrome={chrome} title={t(LABELS[page])} text={t("node.page.gone")} />;
  const login = state.logins[contact.key];
  const admin = isAdmin(login);
  const name = contact.name || contact.prefix;
  const allowed = !!login?.ok && (!ADMIN_ONLY.has(page) || admin);

  let body: React.ReactNode;
  if (!allowed) body = <div className="empty muted">{login?.ok ? t("node.page.needsAdmin") : t("node.page.signInFirst")}</div>;
  else if (page === "neighbours") body = <Neighbours contact={contact} />;
  else if (page === "history") body = <History contact={contact} />;
  else if (page === "settings") body = <Settings contact={contact} />;
  else if (page === "access") body = <Access contact={contact} />;
  else if (page === "push") body = <PushPage contact={contact} />;
  else body = <Console contact={contact} />;

  const kind = nodeKindName(contact.type);
  return (
    <div className="screen node">
      <ScreenHead chrome={chrome} actions={<QueuePill nodeKey={contact.key} />}>
        <Avatar name={name} type={contact.type} size={28} />
        <span className="screen-name-stack">
          <span className="screen-name">{tabs ? name : t(LABELS[page])}</span>
          <span className="muted small">
            {tabs ? t(admin ? "node.page.signedInAdmin" : login?.ok ? "node.page.signedIn" : "node.page.notSignedIn", { kind }) : name}
          </span>
        </span>
      </ScreenHead>
      {tabs ? (
        <nav className="tabs" aria-label={t("node.page.pages", { name })}>
          {nodePages(contact.type).map((p) => {
            const locked = !login?.ok || (ADMIN_ONLY.has(p) && !admin);
            return (
              <button key={p} type="button" className={p === page ? "on" : ""} aria-current={p === page ? "page" : undefined} disabled={locked} title={locked ? t("node.page.locked") : undefined} onClick={() => openNodePage(contact.key, p)}>
                {locked ? <LockIcon size={13} /> : null}
                {t(LABELS[p])}
              </button>
            );
          })}
        </nav>
      ) : null}
      {body}
    </div>
  );
}
