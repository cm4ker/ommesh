import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channelConversation, contactConversation, fromHex, isConversationType, isFavourite } from "@meshnet/meshcore";
import { freeChannelIndex, hashtagName, hashtagSecret, parseSecret, randomSecret } from "../lib/channels.js";
import { utf8Length } from "../lib/format.js";
import { openConversation, openProfile } from "../lib/nav.js";
import { heardAt, kindLabel } from "../lib/nodes.js";
import { readPasted } from "../lib/pastedKey.js";
import { routeWords } from "../lib/routes.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { SearchField } from "../ui/Field.js";
import { Group, LinkRow } from "../ui/List.js";
import { Sheet } from "../ui/Sheet.js";
import { Avatar } from "./Avatar.js";
import { HashIcon, LockIcon, PersonAddIcon, PersonIcon, PlusIcon, TextIcon } from "./Icons.js";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";

type Step = "menu" | "people" | "key" | "public" | "create" | "join";

/**
 * Ways to start talking, a person's and a channel's apart: someone the radio
 * has heard, or someone by the key they sent; a public channel known by name,
 * a private one someone shared, or a new one. Both "by key" rows ask for a
 * key, so each sits under its own heading, and a channel's key pasted for a
 * person is passed on to the channel's form.
 */
export function NewChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>("menu");
  const [query, setQuery] = useState("");
  const [shared, setShared] = useState<{ secret: string; name: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setStep("menu");
    setQuery("");
    setShared(null);
  }, [open]);
  const title =
    step === "people"
      ? t("chats.newChat.people")
      : step === "key"
        ? t("chats.newChat.byKeyTitle")
        : step === "public"
          ? t("chats.newChat.public")
          : step === "create"
            ? t("chats.newChat.create")
            : step === "join"
              ? t("chats.newChat.private")
              : t("chats.newChat.title");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      find={step === "people" ? <SearchField value={query} onValue={setQuery} placeholder={t("chats.list.find")} aria-label={t("chats.newChat.findLabel")} autoFocus /> : undefined}
    >
      {step === "menu" ? (
        <>
          <Group title={t("chats.newChat.person")}>
            <LinkRow icon={<PersonIcon size={18} />} label={t("chats.newChat.heard")} hint={t("chats.newChat.peopleHint")} onClick={() => setStep("people")} />
            <LinkRow icon={<PersonAddIcon size={18} />} label={t("chats.newChat.byKey")} hint={t("chats.newChat.byKeyHint")} onClick={() => setStep("key")} />
          </Group>
          <Group title={t("chats.newChat.channel")}>
            <LinkRow icon={<HashIcon size={18} />} label={t("chats.newChat.publicShort")} hint={t("chats.newChat.publicHint")} onClick={() => setStep("public")} />
            <LinkRow icon={<LockIcon size={18} />} label={t("chats.newChat.privateShort")} hint={t("chats.newChat.privateHint")} onClick={() => setStep("join")} />
            <LinkRow icon={<PlusIcon size={18} />} label={t("chats.newChat.createShort")} hint={t("chats.newChat.createHint")} onClick={() => setStep("create")} />
          </Group>
        </>
      ) : step === "people" ? (
        <People query={query} onDone={onClose} />
      ) : step === "key" ? (
        <KeyForm
          onDone={onClose}
          onChannel={(secret, name) => {
            setShared({ secret, name });
            setStep("join");
          }}
        />
      ) : step === "public" ? (
        <PublicChannelForm onDone={onClose} />
      ) : (
        <ChannelForm join={step === "join"} shared={step === "join" ? shared : null} onDone={onClose} />
      )}
    </Sheet>
  );
}

function People({ query, onDone }: { query: string; onDone: () => void }) {
  const state = useSession();
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(state.contacts)
      .filter((c) => isConversationType(c.type) && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(isFavourite(b)) - Number(isFavourite(a)) || heardAt(b) - heardAt(a));
  }, [state.contacts, query]);
  return rows.length === 0 ? (
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
  );
}

/** The radio keeps a contact's name in 32 bytes, the last of them its end. */
const NAME_BYTES = 31;

/**
 * Someone the radio has not heard, by the key they sent, bare or in a link.
 * The name the link carries, or the one typed, stands until their own advert
 * comes. A key that is someone already on the radio just opens their chat.
 */
function KeyForm({ onDone, onChannel }: { onDone: () => void; onChannel: (secret: string, name: string) => void }) {
  const state = useSession();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pasted = readPasted(text);
  const node = pasted?.kind === "node" ? pasted : null;
  const own = !!node && node.key === state.self?.key;
  const held = node ? state.contacts[node.key] : undefined;
  const known = held && !held.unsaved ? held : undefined;
  const long = utf8Length(name.trim()) > NAME_BYTES;
  const fault =
    pasted?.kind === "unknown" ? t("chats.newChat.keyUnknown") : pasted?.kind === "private" ? t("chats.newChat.keyPrivate") : own ? t("chats.newChat.keyOwn") : null;

  const take = (value: string) => {
    setText(value);
    setError(null);
    const read = readPasted(value);
    setName(read?.kind === "node" ? read.name : "");
  };

  const paste = async () => {
    try {
      take((await navigator.clipboard.readText()).trim());
    } catch {
      toast(t("radio.key.pasteFailed"), "error");
    }
  };

  const open = (key: string, type: number) => {
    if (isConversationType(type)) openConversation(contactConversation(key));
    else openProfile(key);
    onDone();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!node || own || long) return;
    if (known) return open(known.key, known.type);
    setBusy(true);
    setError(null);
    try {
      await session.addByKey({ key: node.key, type: node.type, name: name.trim(), lat: node.lat, lon: node.lon });
      open(node.key, held?.type ?? node.type);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack sheet-form" onSubmit={submit}>
      <div className="field">
        <div className="key-paste-head">
          <label className="field-label" htmlFor="new-chat-key">
            {t("chats.newChat.keyOrLink")}
          </label>
          {typeof navigator.clipboard?.readText === "function" ? (
            <Button size="sm" onClick={() => void paste()}>
              <TextIcon size={15} />
              {t("radio.key.pasteButton")}
            </Button>
          ) : null}
        </div>
        <textarea
          id="new-chat-key"
          className={["input", "mono", "key-paste", fault ? "bad" : ""].join(" ")}
          rows={3}
          value={text}
          placeholder={t("chats.newChat.keyPlaceholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-invalid={fault ? true : undefined}
          onChange={(e) => take(e.target.value)}
          autoFocus
        />
        <span className={["field-hint", fault ? "danger" : ""].join(" ")}>{fault ?? (pasted?.kind === "channel" ? t("chats.newChat.keyChannel") : t("chats.newChat.keyHint"))}</span>
      </div>
      {pasted?.kind === "channel" ? (
        <div className="row-actions">
          <Button onClick={() => onChannel(pasted.secret, pasted.name)}>
            <LockIcon size={16} />
            {t("chats.newChat.joinChannel")}
          </Button>
        </div>
      ) : null}
      {node && !own ? (
        <>
          <div className="key-whose">
            <Avatar name={known?.name || name.trim() || node.key} type={known?.type ?? node.type} size={36} />
            <span>
              <b>{known?.name || name.trim() || known?.prefix || node.key.slice(0, 12)}</b>
              <small>
                {kindLabel(known?.type ?? node.type)} · {known ? routeWords(known).text : t("chats.newChat.notHeard")}
              </small>
            </span>
          </div>
          {known ? null : (
            <label className="field">
              <span className="field-label">{t("chats.newChat.nameIt")}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={long ? true : undefined} autoCapitalize="words" />
              <span className={["field-hint", long ? "danger" : ""].join(" ")}>{long ? t("chats.newChat.nameTooLong", { max: NAME_BYTES }) : t("chats.newChat.nameHint")}</span>
            </label>
          )}
        </>
      ) : null}
      {error ? <p className="connect-error">{error}</p> : null}
      {node && !own ? (
        <Button variant="primary" size="lg" type="submit" busy={busy} disabled={long || (!known && state.status !== "ready")}>
          {known ? (isConversationType(known.type) ? t("chats.newChat.openChat") : t("common.open")) : isConversationType(node.type) ? t("chats.newChat.addAndWrite") : t("chats.newChat.add")}
        </Button>
      ) : null}
    </form>
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
  const name = hashtagName(text);
  const key = name ? hashtagSecret(name) : null;
  const index = freeChannelIndex(state, key ?? undefined);
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

function ChannelForm({ join, shared, onDone }: { join: boolean; shared: { secret: string; name: string } | null; onDone: () => void }) {
  const state = useSession();
  const [name, setName] = useState(shared?.name ?? "");
  const [key, setKey] = useState(() => shared?.secret ?? (join ? "" : randomSecret()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secret = parseSecret(key);
  const index = freeChannelIndex(state, secret ?? undefined);

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
