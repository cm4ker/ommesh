import { useEffect, useMemo, useRef, useState } from "react";
import { MeshCoreError, ErrCode, PUB_KEY_PREFIX_SIZE, type SessionState } from "@meshnet/meshcore";
import { isFault, KEY_DIGITS, keyDigits, readKey, type FoundKey, type KeyFault } from "../lib/keyFile.js";
import { awaitKey, useKeyNote } from "../lib/radioKey.js";
import { agoPhrase } from "../lib/format.js";
import { back } from "../lib/nav.js";
import { session, storage } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { ActionRow, Block, Group } from "../ui/List.js";
import { CheckIcon, FileIcon, TextIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

type Self = NonNullable<SessionState["self"]>;

/**
 * Gives the radio a key back, from a file saved here or pasted as hex. What
 * the key is shows before anything is sent: whose it is, if this device has
 * its chats, or why the radio would not take it. The radio takes it only
 * once asked again in a dialog, then reboots and comes back as that node.
 */
export function KeyPage({ self, online }: { self: Self; online: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  /** A key read from a file: the file stands in for the field until the field is typed in. */
  const [fromFile, setFromFile] = useState<FoundKey | null>(null);
  const [known, setKnown] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const note = useKeyNote(self.key);

  useEffect(() => {
    let live = true;
    void storage.listRadios().then((keys) => live && setKnown(new Set(keys)), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const pasted = useMemo(() => readKey(text), [text]);
  const found: FoundKey | KeyFault = fromFile ?? pasted;
  const key = isFault(found) ? null : found;
  const same = key?.publicKey === self.key;
  const digits = keyDigits(text).length;

  const pick = async (file: File) => {
    const read = readKey(await file.text());
    if (isFault(read)) return toast(faultText(read, true), "error");
    setText("");
    setFromFile(read);
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      setFromFile(null);
      setText(clip.trim());
    } catch {
      toast(t("radio.key.pasteFailed"), "error");
    }
  };

  const give = async () => {
    if (!key) return;
    try {
      const took = await session.importKey(key.privateKey, key.name ?? undefined);
      setAsking(false);
      if (!took) return toast(t("radio.key.refused"), "error");
      awaitKey(key.publicKey);
      toast(t("radio.key.rebooting"));
      back();
    } catch (error) {
      setAsking(false);
      toast(error instanceof MeshCoreError && error.code === ErrCode.IllegalArg ? t("radio.key.unfit") : errorText(error), "error");
    }
  };

  // What is wrong with the field; a file that is no key was told about when picked.
  const fault = !fromFile && isFault(pasted) && pasted.fault !== "empty" ? faultText(pasted, false) : null;
  const shown = key ? short(key.publicKey) : "";

  return (
    <>
      <Group title={t("radio.key.fromFile")}>
        <ActionRow icon={<FileIcon size={17} />} label={t("radio.key.pick")} hint={fromFile ? t("radio.key.picked", { name: fromFile.name ?? shown }) : t("radio.key.pickHint")} onClick={() => picker.current?.click()} />
      </Group>
      <input
        ref={picker}
        type="file"
        accept=".json,.txt,application/json,text/plain"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Cleared, so the same file can be picked again.
          e.currentTarget.value = "";
          if (file) void pick(file);
        }}
      />
      <Group>
        <Block>
          <div className="field">
            <div className="key-paste-head">
              <label className="field-label" htmlFor="radio-key">
                {t("radio.key.paste")}
              </label>
              {typeof navigator.clipboard?.readText === "function" ? (
                <Button size="sm" onClick={() => void paste()}>
                  <TextIcon size={15} />
                  {t("radio.key.pasteButton")}
                </Button>
              ) : null}
            </div>
            <textarea
              id="radio-key"
              className={["input", "mono", "key-paste", fault ? "bad" : ""].join(" ")}
              rows={4}
              value={text}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              aria-invalid={fault ? true : undefined}
              onChange={(e) => {
                setFromFile(null);
                setText(e.target.value);
              }}
            />
            <span className={["field-hint", "key-paste-hint", fault ? "danger" : ""].join(" ")}>
              <span>{fault ?? t("radio.key.pasteHint")}</span>
              {text ? <span className="key-paste-count">{`${digits}/${KEY_DIGITS}`}</span> : null}
            </span>
          </div>
        </Block>
      </Group>
      {key ? (
        <Group>
          <Block className="key-whose">
            <CheckIcon size={18} className={same ? "" : "ok"} />
            <span>
              <b>{same ? t("radio.key.same") : key.name ? t("radio.key.whoNamed", { name: key.name }) : t("radio.key.whoUnnamed", { key: shown })}</b>
              {same ? null : (
                <small>
                  {key.name ? (
                    <>
                      <span className="mono">{shown}</span>
                      {" · "}
                    </>
                  ) : null}
                  {known.has(key.publicKey) ? t("radio.key.hasChats") : t("radio.key.noChats")}
                </small>
              )}
            </span>
          </Block>
        </Group>
      ) : null}
      <div className="page-actions">
        <Button variant="primary" size="lg" disabled={!key || same || !online} onClick={() => setAsking(true)}>
          {t("radio.key.apply")}
        </Button>
      </div>
      <Confirm
        open={asking && key !== null}
        title={key?.name ? t("radio.key.askTitleNamed", { name: key.name }) : t("radio.key.askTitle")}
        body={
          key ? (
            <>
              {key.saved !== null ? <p className="muted">{t("radio.key.askFile", { when: agoPhrase(key.saved) })}</p> : null}
              <dl className="key-compare">
                <div>
                  <dt>{t("radio.key.askKey")}</dt>
                  <dd>
                    <span className="mono">{shown}</span>
                    <small>{t("radio.key.askNow", { value: short(self.key) })}</small>
                  </dd>
                </div>
                {key.name && key.name !== self.name ? (
                  <div>
                    <dt>{t("radio.key.askName")}</dt>
                    <dd>
                      {key.name}
                      <small>{t("radio.key.askNow", { value: self.name })}</small>
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p>{known.has(key.publicKey) ? t("radio.key.askBodyChats") : t("radio.key.askBody")}</p>
              {note.saved === undefined ? <p className="muted">{t("radio.key.askLoses", { name: self.name })}</p> : null}
            </>
          ) : null
        }
        confirmLabel={t("radio.key.apply")}
        onCancel={() => setAsking(false)}
        onConfirm={give}
      />
    </>
  );
}

/** A public key as the reader sees it elsewhere: its first bytes, then an ellipsis. */
function short(key: string): string {
  return `${key.slice(0, PUB_KEY_PREFIX_SIZE * 2 + 4)}…`;
}

/** Why a text is no key, in a sentence. `file` when it came from a file rather than the field. */
function faultText(found: KeyFault, file: boolean): string {
  switch (found.fault) {
    case "empty":
    case "notKey":
      return t("radio.key.notKey");
    case "newer":
      return t("radio.key.newer");
    case "notHex":
      return file ? t("radio.key.notKey") : t("radio.key.notHex");
    case "length":
      if (file) return t("radio.key.notKey");
      return found.digits < KEY_DIGITS ? t("radio.key.short", { count: KEY_DIGITS - found.digits }) : t("radio.key.long", { digits: found.digits });
    case "shape":
      return t("radio.key.shape");
    case "prefix":
      return t("radio.key.prefix");
  }
}
