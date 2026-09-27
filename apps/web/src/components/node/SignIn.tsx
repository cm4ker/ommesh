import { useEffect, useState, type FormEvent } from "react";
import { AdvType, MAX_PASSWORD_LEN, NoReplyError } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t } from "../../i18n/index.js";
import { addableNodes, hopsLabel, nodeKindName } from "../../lib/nodes.js";
import { forgetPassword, hasSavedPassword, passwordStoreHint, readPassword, savePassword, useSavedPasswords } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Dialog } from "../../ui/Dialog.js";
import { PasswordInput } from "../../ui/Field.js";
import { Avatar } from "../Avatar.js";
import { roleName } from "./Access.js";

/**
 * Signing in to a repeater, room or sensor; with no node given, picking one
 * from the contacts first. The password is kept when asked to, so the next
 * sign-in is one tap.
 */
export function SignIn({
  open,
  nodeKey,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  nodeKey: string | null;
  onClose: () => void;
  onSignedIn: (key: string) => void;
}) {
  const state = useSession();
  const saved = useSavedPasswords();
  const [picked, setPicked] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = nodeKey ?? picked;
  const contact = key ? state.contacts[key] : undefined;
  const choices = nodeKey ? [] : addableNodes(state, saved);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setPassword("");
    setError(null);
    setRemember(true);
    if (nodeKey && hasSavedPassword(nodeKey)) void readPassword(nodeKey).then((p) => p !== null && setPassword(p));
  }, [open, nodeKey]);

  const tooLong = new TextEncoder().encode(password).length > MAX_PASSWORD_LEN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key || !contact || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const login = await session.login(key, password);
      if (!login.ok) {
        setError(password ? t("node.signIn.refused") : t("node.signIn.unknownRadio"));
        return;
      }
      if (remember && password) await savePassword(key, password);
      else if (!remember) await forgetPassword(key);
      if (contact.type === AdvType.Repeater && (login.role === null || login.role === 3)) {
        // Who runs it and what it runs: asked once, while the route is fresh.
        void session.requestOwnerInfo(key).catch(() => undefined);
      }
      onSignedIn(key);
    } catch (err) {
      setError(err instanceof NoReplyError ? t("node.signIn.noReply", { name: contact.name || contact.prefix }) : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const title = nodeKey && contact ? t("node.signIn.title", { name: contact.name || contact.prefix }) : t("node.signIn.addNode");
  const login = key ? state.logins[key] : undefined;
  // On a weak route the sign-in goes several times; which try it is shows while it does.
  const job = busy && key && state.remote.active?.key === key && state.remote.active.label === "sign in" ? state.remote.active : null;

  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {nodeKey ? null : (
          <div className="field">
            <span className="field-label">{t("node.signIn.nodes")}</span>
            {choices.length === 0 ? (
              <p className="muted small">{t("node.signIn.allListed")}</p>
            ) : (
              <div className="pick" role="listbox" aria-label={t("node.signIn.node")}>
                {choices.map((c) => (
                  <button key={c.key} type="button" role="option" aria-selected={picked === c.key} className={picked === c.key ? "on" : ""} onClick={() => setPicked(c.key)}>
                    <Avatar name={c.name || c.prefix} type={c.type} size={28} />
                    <span className="who-text">
                      <span>{c.name || c.prefix}</span>
                      <span className="muted small">
                        {nodeKindName(c.type)} · {hopsLabel(c)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="field">
          <span className="field-label">{t("node.signIn.password")}</span>
          <PasswordInput
            value={password}
            autoComplete="current-password"
            placeholder={contact?.type === AdvType.Sensor ? t("node.signIn.adminPassword") : t("node.signIn.adminOrGuest")}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!!nodeKey}
          />
          <span className={["field-hint", tooLong ? "danger" : ""].join(" ")}>
            {tooLong ? t("node.signIn.tooLong", { max: MAX_PASSWORD_LEN }) : t("node.signIn.blank")}
          </span>
        </label>
        <label className="toggle">
          <span className="toggle-text">
            <span>{t("node.signIn.remember")}</span>
            <span className="field-hint">{passwordStoreHint()}</span>
          </span>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        </label>
        {login && !login.ok && !error ? <p className="muted small">{t("node.signIn.lastRefused")}</p> : null}
        {login?.ok && login.role !== null && !error ? <p className="muted small">{t("node.signIn.lastRole", { role: roleName(login.role) })}</p> : null}
        {job && job.attempt > 1 ? <p className="muted small">{t("node.signIn.trying", { n: job.attempt, of: job.attempts })}</p> : null}
        {error ? <p className="connect-error">{error}</p> : null}
        <div className="dialog-foot">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" busy={busy} disabled={!contact || tooLong || state.status !== "ready"}>
            {t("node.signIn.signIn")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
