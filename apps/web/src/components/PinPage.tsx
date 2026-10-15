import { useEffect, useRef, useState } from "react";
import { PIN_DIGITS, pinDigits, pinFault } from "../lib/blePin.js";
import { back } from "../lib/nav.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { Block, ChoiceRow, Group } from "../ui/List.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/**
 * The radio's Bluetooth, under Connection beside its Wi-Fi: for
 * now the PIN it asks a new phone or computer for when it pairs. The
 * radio reports only the PIN it keeps, so a random one is never known here:
 * it is on the radio's screen. Saving reboots the radio, as only a radio that
 * starts takes a PIN.
 */
export function PinPage({ online }: { online: boolean }) {
  const kept = useSession().device?.blePin ?? 0;
  const [own, setOwn] = useState(kept !== 0);
  const [digits, setDigits] = useState(kept ? String(kept) : "");
  const [asking, setAsking] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  /** Set when the reader picks their own PIN, so the field takes the caret then and not when the page opens. */
  const picked = useRef(false);

  useEffect(() => {
    if (own && picked.current) field.current?.focus();
  }, [own]);

  const fault = pinFault(digits);
  const pin = own ? (fault ? null : Number(digits)) : 0;
  const changed = pin !== null && pin !== kept;

  const save = async () => {
    if (pin === null) return;
    try {
      await session.setBlePin(pin);
      setAsking(false);
      toast(t("radio.pin.rebooting"));
      back();
    } catch (error) {
      setAsking(false);
      toast(errorText(error), "error");
    }
  };

  return (
    <>
      <Group title={t("radio.pin.group")} note={t("radio.pin.note")}>
        <ChoiceRow label={t("radio.pin.random")} hint={t("radio.pin.randomHint")} checked={!own} disabled={!online} onSelect={() => setOwn(false)} />
        <ChoiceRow
          label={t("radio.pin.own")}
          hint={t("radio.pin.ownHint")}
          checked={own}
          disabled={!online}
          onSelect={() => {
            picked.current = true;
            setOwn(true);
          }}
        />
        {own ? (
          <Block>
            <div className="field">
              <input
                ref={field}
                className={["input", "mono", "pin-field", fault === "zero" ? "bad" : ""].join(" ")}
                inputMode="numeric"
                autoComplete="off"
                placeholder={"·".repeat(PIN_DIGITS)}
                aria-label={t("radio.pin.field")}
                aria-invalid={fault === "zero" ? true : undefined}
                value={digits}
                disabled={!online}
                onChange={(e) => setDigits(pinDigits(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && changed && online) setAsking(true);
                }}
              />
              {fault === "zero" ? <span className="field-hint danger">{t("radio.pin.zero")}</span> : null}
            </div>
          </Block>
        ) : null}
      </Group>
      <div className="page-actions">
        <Button variant="primary" size="lg" disabled={!changed || !online} onClick={() => setAsking(true)}>
          {t("radio.pin.apply")}
        </Button>
      </div>
      <Confirm
        open={asking}
        title={t("radio.pin.askTitle")}
        body={<p>{pin ? t("radio.pin.askOwn", { pin: String(pin) }) : t("radio.pin.askRandom")}</p>}
        confirmLabel={t("radio.pin.reboot")}
        onCancel={() => setAsking(false)}
        onConfirm={save}
      />
    </>
  );
}
