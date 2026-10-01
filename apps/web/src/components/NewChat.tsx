import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channelConversation, contactConversation, fromHex, isConversationType, isFavourite } from "@meshnet/meshcore";
import { freeChannelIndex, hashtagName, hashtagSecret, parseSecret, randomSecret } from "../lib/channels.js";
import { openConversation } from "../lib/nav.js";
import { heardAt, kindLabel } from "../lib/nodes.js";
import { routeWords } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { Button } from "../ui/Button.js";
import { SearchField } from "../ui/Field.js";
import { Group, LinkRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { Avatar } from "./Avatar.js";
import { HashIcon, KeyIcon, PersonIcon, PlusIcon } from "./Icons.js";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";

type Step = "menu" | "people" | "public" | "create" | "join";

/** Four ways to start talking: to someone the radio has heard, on a public channel known by name, on one someone shared, or on a new one. */
export function NewChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>("menu");
  useEffect(() => {
    if (open) setStep("menu");
  }, [open]);
  const title =
    step === "people"
      ? t("chats.newChat.people")
      : step === "public"
        ? t("chats.newChat.public")
        : step === "create"
          ? t("chats.newChat.create")
          : step === "join"
            ? t("chats.newChat.private")
            : t("chats.newChat.title");
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {step === "menu" ? (
        <Group>
          <LinkRow icon={<PersonIcon size={18} />} label={t("chats.newChat.people")} hint={t("chats.newChat.peopleHint")} onClick={() => setStep("people")} />
          <LinkRow icon={<HashIcon size={18} />} label={t("chats.newChat.public")} hint={t("chats.newChat.publicHint")} onClick={() => setStep("public")} />
          <LinkRow icon={<KeyIcon size={18} />} label={t("chats.newChat.private")} hint={t("chats.newChat.privateHint")} onClick={() => setStep("join")} />
          <LinkRow icon={<PlusIcon size={18} />} label={t("chats.newChat.create")} hint={t("chats.newChat.createHint")} onClick={() => setStep("create")} />
        </Group>
      ) : step === "people" ? (
        <People onDone={onClose} />
      ) : step === "public" ? (
        <PublicChannelForm onDone={onClose} />
      ) : (
        <ChannelForm join={step === "join"} onDone={onClose} />
      )}
    </Sheet>
  );
}

function People({ onDone }: { onDone: () => void }) {
  const state = useSession();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(state.contacts)
      .filter((c) => isConversationType(c.type) && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(isFavourite(b)) - Number(isFavourite(a)) || heardAt(b) - heardAt(a));
  }, [state.contacts, query]);
  return (
    <>
      <SearchField value={query} onValue={setQuery} placeholder={t("chats.list.find")} aria-label={t("chats.newChat.findLabel")} autoFocus />
      {rows.length === 0 ? (
        <p className="group-note">{query ? t("chats.newChat.nobodyNamed") : t("chats.newChat.nobodyYet")}</p>
      ) : (
        <ul className="list" role="list">
          {rows.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                className="row"
                onClick={() => {
                  openConversation(contactConversation(c.key));
                  onDone();
                }}
              >
                <Avatar name={c.name || c.prefix} type={c.type} size={36} />
                <span className="row-main">
                  <span className="row-title">{c.name || c.prefix}</span>
                  <span className="row-sub muted">
                    {kindLabel(c.type)} · {routeWords(c).text}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A public channel: the name is all there is, its key is derived from it, so
 * anyone who knows "#berlin" reads it. The key is shown so two people can
 * compare it with another app's. A channel the radio already has is opened.
 */
function PublicChannelForm({ onDone }: { onDone: () => void }) {
  const state = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = freeChannelIndex(state);
  const name = hashtagName(text);
  const key = name ? hashtagSecret(name) : null;
  const existing = name ? state.channels.find((c) => c.name.toLowerCase() === name) : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name) return;
    if (existing) {
      openConversation(channelConversation(existing.index));
      onDone();
      return;
    }
    if (index < 0) return;
    setBusy(true);
    setError(null);
    try {
      await session.setChannel(index, name, fromHex(hashtagSecret(name)));
      openConversation(channelConversation(index));
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (index < 0 && !existing) return <p className="group-note">{t("chats.newChat.slotsFull")}</p>;

  return (
    <form className="stack sheet-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">{t("chats.channel.name")}</span>
        <span className="input-prefixed">
          <span className="input-prefix" aria-hidden="true">#</span>
          <input
            className="input"
            value={text.replace(/^#+/, "")}
            maxLength={30}
            onChange={(e) => setText(e.target.value)}
            placeholder="berlin"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </span>
        <span className="field-hint">{existing ? t("chats.newChat.alreadyHas") : t("chats.newChat.anyoneReads")}</span>
      </label>
      {key ? (
        <div className="field">
          <span className="field-label">{t("chats.newChat.keyFromName")}</span>
          <span className="key-text mono muted">{key.match(/.{4}/g)!.join(" ")}</span>
        </div>
      ) : null}
      {error ? <p className="connect-error">{error}</p> : null}
      <Button variant="primary" size="lg" type="submit" busy={busy} disabled={!name || state.status !== "ready"}>
        {existing ? t("common.open") : t("chats.newChat.join")}
      </Button>
    </form>
  );
}

function ChannelForm({ join, onDone }: { join: boolean; onDone: () => void }) {
  const state = useSession();
  const [name, setName] = useState("");
  const [key, setKey] = useState(() => (join ? "" : randomSecret()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = freeChannelIndex(state);
  const secret = parseSecret(key);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!secret || !name.trim() || index < 0) return;
    setBusy(true);
    setError(null);
    try {
      await session.setChannel(index, name.trim(), fromHex(secret));
      openConversation(channelConversation(index));
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (index < 0) return <p className="group-note">{t("chats.newChat.slotsFull")}</p>;

  return (
    <form className="stack sheet-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">{t("chats.channel.name")}</span>
        <input className="input" value={name} maxLength={31} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field-label">{t("chats.newChat.key")}</span>
        <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("chats.newChat.keyPlaceholder")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <span className={["field-hint", key && !secret ? "danger" : ""].join(" ")}>
          {key && !secret ? t("chats.newChat.keyInvalid") : join ? t("chats.newChat.keySame") : t("chats.newChat.keyRandom")}
        </span>
      </label>
      {error ? <p className="connect-error">{error}</p> : null}
      <Button variant="primary" size="lg" type="submit" busy={busy} disabled={!secret || !name.trim() || state.status !== "ready"}>
        {join ? t("chats.newChat.join") : t("chats.newChat.createButton")}
      </Button>
    </form>
  );
}
