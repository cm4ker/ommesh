import { useState, type ReactNode } from "react";
import { SERIAL_BAUD } from "@meshnet/meshcore";
import type { Connector, FoundDevice, PortAccess } from "../../transports/index.js";
import { BAUDS, choiceOf, isDefault, LINE_CHOICES, setPortSettings, usePortSettings, validBaud, type LinesChoice, type PortSettings } from "../../transports/portSettings.js";
import { openJournal, useJournal } from "../../lib/portJournal.js";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Field.js";
import { showMenu } from "../../ui/Menu.js";
import { ChevronDownIcon, ChevronUpIcon, LogIcon, SlidersIcon } from "../Icons.js";
import { t } from "../../i18n/index.js";

/** A port's speed and lines in a few words, where they differ from the defaults: "57600 · DTR off, RTS off". */
export function portSummary(settings: PortSettings): string {
  return [settings.baud !== SERIAL_BAUD ? String(settings.baud) : null, settings.lines !== "auto" ? t(`connect.serial.lines.${settings.lines}`) : null].filter(Boolean).join(" · ");
}

/**
 * A cable's port in the radio card: a button that opens its settings under it
 * (the speed, the DTR and RTS lines, the port's log), with a summary of what
 * is changed while they are closed.
 */
export function PortSection({ connector, access, device }: { connector: Connector; access: PortAccess; device: FoundDevice }) {
  const [open, setOpen] = useState(false);
  const settings = usePortSettings(access.key(device));
  const summary = portSummary(settings);
  return (
    <>
      <div className="port-toggle-row">
        <Button size="sm" className={open ? "pressed" : undefined} aria-expanded={open} onClick={() => setOpen(!open)}>
          <SlidersIcon size={15} />
          {t("connect.serial.settings")}
          {!open && summary ? <span className="port-summary">{summary}</span> : null}
          {open ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        </Button>
      </div>
      {open ? <PortFields access={access} connector={connector} device={device} settings={settings} /> : null}
    </>
  );
}

function PortFields({ access, connector, device, settings }: { access: PortAccess; connector: Connector; device: FoundDevice; settings: PortSettings }) {
  const key = access.key(device);
  const journal = useJournal();
  const logOpen = journal.device?.id === device.id && journal.connector === connector;
  const save = (patch: Partial<PortSettings>) => setPortSettings(key, { ...settings, ...patch });
  return (
    <div className="port-fields">
      <SpeedField baud={settings.baud} onBaud={(baud) => save({ baud })} />
      <LinesField choice={settings.lines} port={device.name} auto={access.autoLines(device)} onChoice={(lines) => save({ lines })} />
      <div>
        <Button size="sm" className={logOpen ? "pressed" : undefined} aria-pressed={logOpen} onClick={() => openJournal(connector, device)}>
          <LogIcon size={15} />
          {t("connect.serial.log")}
        </Button>
      </div>
    </div>
  );
}

/** A field that looks like a select and opens a menu of choices under itself. */
function Pick({ id, children, onOpen }: { id: string; children: ReactNode; onOpen: (at: { x: number; y: number }, width: number) => void }) {
  return (
    <button
      id={id}
      type="button"
      className="input port-pick"
      aria-haspopup="menu"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onOpen({ x: box.left, y: box.bottom + 4 }, box.width);
      }}
    >
      <span className="port-pick-value">{children}</span>
      <ChevronDownIcon size={14} />
    </button>
  );
}

function SpeedField({ baud, onBaud }: { baud: number; onBaud: (baud: number) => void }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(String(baud));
  const typed = Number(text.trim());
  const error = text.trim() === "" ? null : typed === 1200 ? t("connect.serial.speedBoot") : validBaud(typed) ? null : t("connect.serial.speedBad");
  const listed = BAUDS.includes(baud);
  const done = () => {
    if (validBaud(typed)) onBaud(typed);
    setTyping(false);
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor="port-speed">
        {t("connect.serial.speed")}
      </label>
      {typing ? (
        <Input
          id="port-speed"
          className="input mono"
          value={text}
          inputMode="numeric"
          placeholder={t("connect.serial.speedTyped")}
          aria-invalid={error !== null}
          autoFocus
          onChange={(event) => setText(event.target.value.replace(/\D/g, ""))}
          onBlur={done}
          onKeyDown={(event) => {
            if (event.key === "Enter") done();
            if (event.key === "Escape") {
              event.stopPropagation();
              setTyping(false);
            }
          }}
        />
      ) : (
        <Pick
          id="port-speed"
          onOpen={(at, width) =>
            showMenu(
              [
                ...BAUDS.map((b) => ({ label: String(b), hint: b === SERIAL_BAUD ? "MeshCore" : undefined, checked: b === baud, onSelect: () => onBaud(b) })),
                {
                  label: listed ? t("connect.serial.speedOther") : `${t("connect.serial.speedOther")} ${baud}`,
                  checked: !listed,
                  group: true,
                  onSelect: () => {
                    setText(String(baud));
                    setTyping(true);
                  },
                },
              ],
              { at, minWidth: width, hints: true, title: t("connect.serial.speed") },
            )
          }
        >
          <span className="mono">{baud}</span>
        </Pick>
      )}
      {typing && error ? <span className="field-hint port-error">{error}</span> : null}
    </div>
  );
}

function LinesField({ choice, port, auto, onChoice }: { choice: LinesChoice; port: string; auto: { dtr: boolean; rts: boolean } | null; onChoice: (choice: LinesChoice) => void }) {
  const now = auto ? t(`connect.serial.lines.${choiceOf(auto)}`) : null;
  const hint = (c: LinesChoice) => (c === "auto" ? (now ? t("connect.serial.hint.autoNow", { port, lines: now }) : t("connect.serial.hint.auto")) : t(`connect.serial.hint.${c}`));
  return (
    <div className="field">
      <label className="field-label" htmlFor="port-lines">
        {t("connect.serial.lines")}
      </label>
      <Pick
        id="port-lines"
        onOpen={(at, width) =>
          showMenu(
            LINE_CHOICES.map((c) => ({ label: t(`connect.serial.lines.${c}`), hint: hint(c), checked: c === choice, onSelect: () => onChoice(c) })),
            { at, minWidth: width, hints: true, title: t("connect.serial.lines") },
          )
        }
      >
        {t(`connect.serial.lines.${choice}`)}
        {choice === "auto" && now ? <span className="port-pick-note">{t("connect.serial.linesNow", { lines: now })}</span> : null}
      </Pick>
    </div>
  );
}

/** A port's speed and lines at the end of its row in the list, where they are not the defaults. */
export function PortRowSummary({ access, device }: { access: PortAccess; device: FoundDevice }) {
  const settings = usePortSettings(access.key(device));
  return isDefault(settings) ? null : <span className="port-row-summary">{portSummary(settings)}</span>;
}
