import { Fragment, useEffect, useMemo, useState } from "react";
import { MAX_PASSWORD_LEN, NodeCommandError, isCliError, type ContactRecord } from "@meshnet/meshcore";
import { errorText } from "../../i18n/errors.js";
import { t } from "../../i18n/index.js";
import { tx } from "../../i18n/rich.js";
import { ago } from "../../lib/format.js";
import { hasPosition } from "../../lib/geo.js";
import { pickNodePlace } from "../../lib/nav.js";
import {
  RADIO_FIELDS,
  displayValue,
  formatRadio,
  groupReads,
  parseRadio,
  readCommand,
  settingGroups,
  storedValue,
  validate,
  validateRadio,
  writeCommand,
  type RadioValue,
  type SettingField,
  type SettingGroup,
} from "../../lib/nodes.js";
import { degreeText, putPickedPlace, usePickedPlace } from "../../lib/nodePlace.js";
import { hasSavedPassword, savePassword } from "../../lib/secrets.js";
import { session, useSession } from "../../lib/session.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Dialog.js";
import { PasswordInput, Section } from "../../ui/Field.js";
import { AlertIcon, LocationIcon } from "../Icons.js";

/** How long a trial of new radio settings lasts before the node falls back by itself. */
const TRIAL_MINUTES = 10;

interface Pending {
  name: string;
  value: string;
  command: string;
}

function message(e: unknown): string {
  if (e instanceof NodeCommandError) return t("node.nodeSaid", { reply: e.reply });
  return errorText(e);
}

/**
 * The node's settings, as forms over its console: a group is read with
 * `get`, one request per value, only when asked; changes are collected and
 * sent as the `set` commands shown before they go.
 */
export function Settings({ contact }: { contact: ContactRecord }) {
  const state = useSession();
  const key = contact.key;
  const online = state.status === "ready";
  const stored = state.nodeSettings[key] ?? {};
  const groups = settingGroups(contact.type);
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ask, setAsk] = useState<"radio" | "password" | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    setDirty({});
    setError(null);
    setNote(null);
    setPassword("");
  }, [key]);

  const radio = parseRadio(stored["radio"]?.value);
  const current = (name: string): string => {
    const radioField = RADIO_FIELDS.find((f) => f.name === name);
    if (radioField) return radio?.[name as keyof RadioValue] ?? "";
    const value = stored[name]?.value;
    return value === undefined ? "" : displayValue(name, value);
  };
  const shown = (name: string) => dirty[name] ?? current(name);

  const setField = (name: string, value: string) => {
    setDirty((d) => {
      const next = { ...d };
      if (value === current(name)) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  // The map opens where the fields say, a change not yet applied included.
  const shownPlace = () => {
    const lat = Number(shown("lat"));
    const lon = Number(shown("lon"));
    return Number.isFinite(lat) && Number.isFinite(lon) && hasPosition(lat, lon) ? { lat, lon } : null;
  };

  // A point put on the map comes back as a change to both halves of the position.
  const picked = usePickedPlace(key);
  useEffect(() => {
    if (!picked) return;
    setField("lat", degreeText(picked.lat));
    setField("lon", degreeText(picked.lon));
    putPickedPlace(null);
  }, [picked]);

  const { pending, radioValue, problems } = useMemo(() => {
    const pending: Pending[] = [];
    const problems: Record<string, string> = {};
    for (const group of groups) {
      for (const field of group.fields) {
        const value = dirty[field.name];
        if (value === undefined) continue;
        const problem = validate(field, value);
        if (problem) problems[field.name] = problem;
        pending.push({ name: field.name, value: storedValue(field.name, value), command: writeCommand(field.name, value) });
      }
    }
    let radioValue: string | null = null;
    if (radio && RADIO_FIELDS.some((f) => dirty[f.name] !== undefined)) {
      const next: RadioValue = { freq: shown("freq"), bw: shown("bw"), sf: shown("sf"), cr: shown("cr") };
      const problem = validateRadio(next);
      if (problem) problems["freq"] = problem;
      radioValue = formatRadio(next);
    }
    return { pending, radioValue, problems };
    // `shown` reads `dirty` and `stored`, both listed.
  }, [dirty, stored, contact.type]);

  const read = async (group: SettingGroup) => {
    setReading((r) => new Set(r).add(group.id));
    setError(null);
    const refused: string[] = [];
    try {
      for (const name of groupReads(group)) {
        try {
          await session.readNodeSetting(key, name, readCommand(name));
        } catch (e) {
          if (e instanceof NodeCommandError) refused.push(`${name} (${e.reply})`);
          else throw e;
        }
      }
      if (refused.length) setNote(t("node.settings.unknown", { names: refused.join(", ") }));
    } catch (e) {
      setError(message(e));
    } finally {
      setReading((r) => {
        const next = new Set(r);
        next.delete(group.id);
        return next;
      });
    }
  };

  const apply = async (radioMode: "trial" | "save" | null) => {
    setApplying(true);
    setError(null);
    setNote(null);
    const moved = pending.some((p) => p.name === "lat" || p.name === "lon");
    try {
      for (const p of pending) {
        await session.writeNodeSetting(key, p.name, p.value, p.command);
        setDirty((d) => {
          const next = { ...d };
          delete next[p.name];
          return next;
        });
      }
      if (moved) {
        // The map shows the node where its adverts put it, and the next one is hours away: the
        // radio's contact moves now. Should the radio refuse, the advert still brings it.
        const values = session.getState().nodeSettings[key];
        const lat = Number(values?.["lat"]?.value);
        const lon = Number(values?.["lon"]?.value);
        if (Number.isFinite(lat) && Number.isFinite(lon)) await session.placeContact(key, lat, lon).catch(() => undefined);
      }
      if (radioValue && radioMode === "trial") {
        const reply = await session.runCli(key, `tempradio ${radioValue},${TRIAL_MINUTES}`);
        if (isCliError(reply)) throw new NodeCommandError(reply);
        setNote(t("node.settings.onTrial", { name: contact.name, count: TRIAL_MINUTES }));
      } else if (radioValue && radioMode === "save") {
        await session.writeNodeSetting(key, "radio", radioValue, `set radio ${radioValue}`);
        setNote(t("node.settings.keeps", { name: contact.name }));
      } else {
        const saved = t("node.settings.saved", { count: pending.length, name: contact.name });
        setNote(moved ? `${saved} ${t("node.settings.placeAdvert")}` : saved);
      }
      if (radioValue && radioMode) {
        setDirty((d) => {
          const next = { ...d };
          for (const f of RADIO_FIELDS) delete next[f.name];
          return next;
        });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setApplying(false);
    }
  };

  const changePassword = async () => {
    setError(null);
    setNote(null);
    try {
      await session.writeNodeSetting(key, "password", password, `password ${password}`, { mask: "password ••••••" });
      if (hasSavedPassword(key)) await savePassword(key, password);
      setPassword("");
      setNote(hasSavedPassword(key) ? t("node.settings.passwordChangedSaved") : t("node.settings.passwordChanged"));
    } catch (e) {
      setError(message(e));
    }
  };

  const total = pending.length + (radioValue ? 1 : 0);
  const invalid = Object.keys(problems).length > 0;
  const commands = [
    ...pending.map((p) => p.command),
    ...(radioValue ? [t("node.settings.trialOrSave", { trial: `tempradio ${radioValue},${TRIAL_MINUTES}`, save: `set radio ${radioValue}` })] : []),
  ];
  const passwordTooLong = new TextEncoder().encode(password).length > MAX_PASSWORD_LEN;

  return (
    <>
      <div className="card-scroll">
        {error ? <p className="connect-error">{error}</p> : null}
        {note ? <p className="muted small">{note}</p> : null}

        {groups.map((group) => {
          const names = groupReads(group);
          const known = names.filter((n) => stored[n] !== undefined);
          const busy = reading.has(group.id);
          const at = known.length ? Math.max(...known.map((n) => stored[n]!.at)) : null;
          return (
            <Section
              key={group.id}
              title={group.title}
              actions={
                <>
                  <span className="muted small">
                    {busy
                      ? t("node.settings.reading", { done: known.length, total: names.length })
                      : at
                        ? t("node.settings.readAgo", { time: ago(at) })
                        : t("node.settings.notRead")}
                  </span>
                  {known.length > 0 ? (
                    <Button size="sm" busy={busy} disabled={!online} onClick={() => void read(group)}>
                      {t("node.settings.readAgain")}
                    </Button>
                  ) : null}
                </>
              }
            >
              {known.length === 0 ? (
                <div className="unread">
                  <span className="muted">{t("node.settings.notReadYet", { count: names.length })}</span>
                  <Button size="sm" busy={busy} disabled={!online} onClick={() => void read(group)}>
                    {t("node.settings.readValues", { count: names.length })}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="form-grid">
                    {group.id === "radio" && radio
                      ? RADIO_FIELDS.map((f) => (
                          <FieldInput key={f.name} nodeKey={key} field={f} value={shown(f.name)} dirty={dirty[f.name] !== undefined} problem={problems[f.name]} onChange={setField} />
                        ))
                      : null}
                    {group.fields
                      .filter((f) => stored[f.name] !== undefined)
                      .map((f) => (
                        <Fragment key={f.name}>
                          <FieldInput nodeKey={key} field={f} value={shown(f.name)} dirty={dirty[f.name] !== undefined} problem={problems[f.name]} onChange={setField} />
                          {f.name === "lon" ? (
                            <Button size="sm" className="pick-on-map" onClick={() => pickNodePlace(key, shownPlace())}>
                              <LocationIcon size={15} /> {t("node.settings.pickOnMap")}
                            </Button>
                          ) : null}
                        </Fragment>
                      ))}
                  </div>
                  {group.id === "radio" ? (
                    <p className="inline-warn">
                      <AlertIcon size={14} />
                      <span>{radioValue ? t("node.settings.radioMoves") : t("node.settings.radioMatch")}</span>
                    </p>
                  ) : null}
                </>
              )}
            </Section>
          );
        })}

        <Section title={t("node.settings.adminPassword")}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">{t("node.settings.newPassword")}</span>
              <PasswordInput autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className={["field-hint", passwordTooLong ? "danger" : ""].join(" ")}>
                {passwordTooLong ? t("node.settings.passwordTooLong", { max: MAX_PASSWORD_LEN }) : t("node.settings.writeOnly")}
              </span>
            </label>
          </div>
          <div className="row-actions">
            <Button disabled={!online || !password || passwordTooLong} onClick={() => setAsk("password")}>
              {t("node.settings.changePassword")}
            </Button>
          </div>
        </Section>
      </div>

      {total > 0 ? (
        <div className="apply-bar">
          {showCommands ? (
            <ul className="cmd-list">
              {commands.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {radioValue ? (
            <p className="inline-warn">
              <AlertIcon size={14} />
              <span>
                {tx("node.settings.trialWarn", { button: <b>{t("node.settings.tryFor", { minutes: TRIAL_MINUTES })}</b>, command: <code>tempradio</code> })}
              </span>
            </p>
          ) : null}
          <div className="apply-row">
            <span>
              {tx("node.settings.changes", { count: total, total: <b>{total}</b> })} ·{" "}
              <button type="button" className="link" onClick={() => setShowCommands((s) => !s)}>
                {showCommands ? t("node.settings.hideCommands") : t("node.settings.showCommands")}
              </button>
            </span>
            <span className="row-actions">
              <Button size="sm" variant="ghost" disabled={applying} onClick={() => setDirty({})}>
                {t("node.settings.discard")}
              </Button>
              {radioValue ? (
                <>
                  <Button size="sm" variant="danger" disabled={!online || invalid || applying} onClick={() => setAsk("radio")}>
                    {t("node.settings.applyForGood")}
                  </Button>
                  <Button size="sm" variant="primary" busy={applying} disabled={!online || invalid} onClick={() => void apply("trial")}>
                    {t("node.settings.tryFor", { minutes: TRIAL_MINUTES })}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" busy={applying} disabled={!online || invalid} onClick={() => void apply(null)}>
                  {t("node.settings.apply", { count: total })}
                </Button>
              )}
            </span>
          </div>
        </div>
      ) : null}

      <Confirm
        open={ask === "radio"}
        title={t("node.settings.moveTitle")}
        body={<p>{t("node.settings.moveBody", { name: contact.name, minutes: TRIAL_MINUTES })}</p>}
        confirmLabel={t("node.settings.applyForGood")}
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await apply("save");
        }}
      />
      <Confirm
        open={ask === "password"}
        title={t("node.settings.passwordTitle")}
        body={<p>{t(hasSavedPassword(key) ? "node.settings.passwordBodySaved" : "node.settings.passwordBodyUnsaved", { name: contact.name })}</p>}
        confirmLabel={t("node.settings.changePassword")}
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await changePassword();
        }}
      />
    </>
  );
}

function FieldInput({
  nodeKey,
  field,
  value,
  dirty,
  problem,
  onChange,
}: {
  nodeKey: string;
  field: SettingField;
  value: string;
  dirty: boolean;
  problem: string | undefined;
  onChange: (name: string, value: string) => void;
}) {
  const id = `setting-${nodeKey.slice(0, 8)}-${field.name}`;
  const className = ["input", dirty ? "dirty" : ""].join(" ");
  if (field.kind === "toggle") {
    return (
      <label className={["toggle", "wide", dirty ? "dirty" : ""].join(" ")} htmlFor={id}>
        <span className="toggle-text">
          <span>
            {field.label} <code className="muted small">{field.name}</code>
          </span>
          {field.hint ? <span className="field-hint">{field.hint}</span> : null}
        </span>
        <input id={id} type="checkbox" checked={value === "on"} onChange={(e) => onChange(field.name, e.target.checked ? "on" : "off")} />
      </label>
    );
  }
  let input: React.ReactNode;
  if (field.kind === "select") {
    const options = field.options?.includes(value) || !value ? field.options! : [value, ...field.options!];
    input = (
      <select id={id} className={`${className} select`} value={value} onChange={(e) => onChange(field.name, e.target.value)}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else if (field.kind === "textarea") {
    input = <textarea id={id} className={className} rows={2} value={value} onChange={(e) => onChange(field.name, e.target.value)} />;
  } else {
    input = (
      <input
        id={id}
        className={className}
        type={field.kind === "number" ? "number" : "text"}
        inputMode={field.kind === "number" ? "numeric" : /lat|lon|delay|af|freq/.test(field.name) ? "decimal" : undefined}
        value={value}
        onChange={(e) => onChange(field.name, e.target.value)}
      />
    );
  }
  return (
    <label className={["field", field.kind === "textarea" ? "wide" : "", dirty ? "dirty" : ""].join(" ")} htmlFor={id}>
      <span className="field-label">
        <span>{field.label}</span>
        {RADIO_FIELDS.includes(field) ? null : <code className="muted small">{field.name}</code>}
      </span>
      {input}
      {problem ? <span className="field-hint danger">{problem}</span> : field.hint ? <span className="field-hint">{field.hint}</span> : null}
    </label>
  );
}
