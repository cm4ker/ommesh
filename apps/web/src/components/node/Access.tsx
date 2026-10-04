import { useState } from "react";
import { AclRole, AdvType, NoReplyError, NodeCommandError, isCliError, type ContactRecord } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t, type Key } from "../../i18n/index.js";
import { tx } from "../../i18n/rich.js";
import { ago } from "../../lib/format.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { Section } from "../../ui/Field.js";
import { Avatar } from "../Avatar.js";
import { RefreshIcon } from "../Icons.js";

const ROLES = [AclRole.Admin, AclRole.ReadWrite, AclRole.ReadOnly];

const ROLE_NAMES: Record<number, Key> = {
  [AclRole.Admin]: "node.role.admin",
  [AclRole.ReadWrite]: "node.role.readWrite",
  [AclRole.ReadOnly]: "node.role.readOnly",
  [AclRole.Guest]: "node.role.guest",
};

/** A role as the reader says it: "admin", "read-write", "read-only", "guest". */
export function roleName(role: number): string {
  return t(ROLE_NAMES[role & 3] ?? "node.role.guest");
}

function message(e: unknown): string {
  if (e instanceof NodeCommandError) return t("node.nodeSaid", { reply: e.reply });
  return errorText(e);
}

/**
 * Who may sign in, and as what. A role is set with `setperm`, which needs a
 * client's whole key to add or change one, so only contacts can be given a
 * role here; anyone listed can be removed by their prefix.
 */
export function Access({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const list = state.accessLists[key];
  const online = state.status === "ready";
  const selfPrefix = state.self?.prefix ?? "";
  const [busy, setBusy] = useState<string | null>(null);
  // A node silent past the wait may answer late: a list newer than that silence stands in for the error.
  const [error, setError] = useState<{ text: string; silentAt: number | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [grantKey, setGrantKey] = useState("");
  const [grantRole, setGrantRole] = useState<number>(AclRole.ReadWrite);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setError({ text: message(e), silentAt: e instanceof NoReplyError ? Date.now() : null });
    } finally {
      setBusy(null);
    }
  };

  const setperm = async (target: string, permissions: number, label: string) => {
    const reply = await session.runCli(key, `setperm ${target} ${permissions}`);
    if (isCliError(reply)) throw new NodeCommandError(reply);
    await session.requestAccessList(key);
    setNote(label);
  };

  const people = Object.values(state.contacts)
    .filter((c) => c.type === AdvType.Chat && !list?.entries.some((e) => c.prefix === e.prefix))
    .sort((a, b) => a.name.localeCompare(b.name));
  const room = contact.type === AdvType.Room;

  return (
    <div className="card-scroll">
      <div className="toolbar">
        <span className="muted small">
          {list ? t(room ? "node.access.admins" : "node.access.clients", { count: list.entries.length, time: ago(list.at) }) : t("node.notAskedYet")}
        </span>
        <Button size="sm" busy={busy === "list"} disabled={!online} onClick={() => void run("list", async () => void (await session.requestAccessList(key)))}>
          <RefreshIcon size={13} />
          {list ? t("node.refresh") : t("node.access.askNode")}
        </Button>
      </div>
      {error && !(error.silentAt !== null && (list?.at ?? 0) > error.silentAt) ? <p className="connect-error">{error.text}</p> : null}
      {note ? <p className="muted small">{note}</p> : null}

      {list ? (
        <Section title={t("node.access.whoCanSignIn")}>
          {list.entries.length === 0 ? <p className="muted">{t("node.access.onlyGuests")}</p> : null}
          <div className="acl">
            {list.entries.map((entry) => {
              const known = session.contactByPrefix(entry.prefix);
              const me = entry.prefix === selfPrefix;
              const name = me ? state.self?.name : known?.name;
              const role = entry.permissions & 3;
              return (
                <div className="acl-row" key={entry.prefix}>
                  <span className="who">
                    <Avatar name={name || entry.prefix} size={30} />
                    <span className="who-text">
                      <span>
                        {name || <code>{entry.prefix}</code>}
                        {me ? <span className="pill you">{t("node.access.you")}</span> : null}
                      </span>
                      <span className="muted small">{name ? <code>{entry.prefix}</code> : t("node.notInContacts")}</span>
                    </span>
                  </span>
                  <select
                    className="input select acl-role"
                    aria-label={t("node.access.roleOf", { name: name || entry.prefix })}
                    value={role}
                    disabled={!online || me || busy !== null || (!known && !me)}
                    title={me ? t("node.access.ownRole") : !known ? t("node.access.needsKey") : undefined}
                    onChange={(e) => {
                      const next = (entry.permissions & ~3) | Number(e.target.value);
                      void run(entry.prefix, () => setperm(known!.key, next, t("node.access.nowRole", { name: name ?? "", role: roleName(next) })));
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roleName(r)}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="ghost" busy={busy === entry.prefix} disabled={!online || me || busy !== null} onClick={() => setRemoving(entry.prefix)}>
                    {t("common.remove")}
                  </Button>
                </div>
              );
            })}
          </div>
        </Section>
      ) : (
        <p className="muted">{t("node.access.intro")}</p>
      )}

      {list ? (
        <Section title={t("node.access.giveRole")}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">{t("node.access.contact")}</span>
              <select className="input select" value={grantKey} onChange={(e) => setGrantKey(e.target.value)}>
                <option value="">{t("node.access.choose")}</option>
                {people.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name || p.prefix}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t("node.access.role")}</span>
              <select className="input select" value={grantRole} onChange={(e) => setGrantRole(Number(e.target.value))}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleName(r)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row-actions">
            <Button
              busy={busy === "grant"}
              disabled={!online || !grantKey || busy !== null}
              onClick={() =>
                void run("grant", async () => {
                  const who = state.contacts[grantKey];
                  const role = roleName(grantRole);
                  await setperm(grantKey, grantRole, who ? t("node.access.granted", { name: who.name, role }) : t("node.access.grantedUnnamed", { role }));
                  setGrantKey("");
                })
              }
            >
              {t("node.access.give")}
            </Button>
          </div>
          <p className="field-hint">{tx("node.access.hint", { command: <code>setperm</code> })}</p>
        </Section>
      ) : null}

      <Confirm
        open={removing !== null}
        title={t("node.access.removeTitle")}
        body={<p>{t("node.access.removeBody", { name: contact.name })}</p>}
        confirmLabel={t("common.remove")}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const prefix = removing!;
          setRemoving(null);
          await run(prefix, () => setperm(prefix, AclRole.Guest, t("node.access.removed")));
        }}
      />
    </div>
  );
}
