import { useState } from "react";
import { AclRole, AdvType, contactConversation, isConversationType, isFavourite, isNodeType, NoReplyError } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { agoPhrase } from "../lib/format.js";
import { bearingDeg, compass, distanceKm, formatDistance, hasPosition } from "../lib/geo.js";
import { useWide } from "../lib/layout.js";
import { openConversation, openNodePage, showOnMap, useNav, type NodePage } from "../lib/nav.js";
import { heardAt, isAdmin, kindLabel } from "../lib/nodes.js";
import { forgetPassword, hasSavedPassword, useSavedPasswords } from "../lib/secrets.js";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { IconButton } from "../ui/Button.js";
import { Confirm, Prompt } from "../ui/Dialog.js";
import { Group, InfoRow, LinkRow } from "../ui/List.js";
import { showMenu, type MenuItem } from "../ui/Menu.js";
import { Avatar } from "./Avatar.js";
import { ChatNotices } from "./ChatNotices.js";
import { HeroName } from "./HeroName.js";
import { AirIcon, ChartIcon, ChatIcon, CheckIcon, CopyIcon, EditIcon, LockIcon, MapIcon, MoreIcon, PowerIcon, ShieldIcon, SlidersIcon, StarFilledIcon, StarIcon, TerminalIcon, TrashIcon, UsersIcon, CloseIcon } from "./Icons.js";
import { NodeReadings } from "./NodeReadings.js";
import { ClockRow } from "./node/Clock.js";
import { QueuePill } from "./node/QueuePill.js";
import { SignIn } from "./node/SignIn.js";
import { NotOnRadio } from "./ContactsPages.js";
import { Gone, ScreenHead, type Chrome } from "./ScreenHead.js";
import { ForgetRouteRow, RouteLink } from "./tools/RouteSheet.js";

const PAGES: Record<NodePage, { label: Key; icon: React.ReactNode; admin: boolean }> = {
  neighbours: { label: "mesh.tab.neighbours", icon: <UsersIcon size={17} />, admin: false },
  history: { label: "mesh.tab.history", icon: <ChartIcon size={17} />, admin: false },
  settings: { label: "mesh.tab.settings", icon: <SlidersIcon size={17} />, admin: true },
  access: { label: "mesh.tab.access", icon: <ShieldIcon size={17} />, admin: true },
  console: { label: "mesh.tab.console", icon: <TerminalIcon size={17} />, admin: true },
};

/** A sign-in's role, as the firmware's ACL has it (`aclRoleName`), in the reader's words. */
function roleName(role: number): string {
  switch (role & 3) {
    case AclRole.Admin:
      return t("mesh.role.admin");
    case AclRole.ReadWrite:
      return t("mesh.role.readWrite");
    case AclRole.ReadOnly:
      return t("mesh.role.readOnly");
    default:
      return t("mesh.role.guest");
  }
}

export function nodePages(type: number): NodePage[] {
  if (type === AdvType.Repeater) return ["neighbours", "settings", "access", "console"];
  if (type === AdvType.Room) return ["settings", "access", "console"];
  return ["history", "settings", "access", "console"];
}

/**
 * One node, whoever it is: a person, a repeater, a room, a sensor. What is
 * done most sits in the buttons at the top; what is done rarely is in More.
 * A repeater, room or sensor you have signed in to also shows how it is
 * doing, and opens its own screens.
 */
export function Profile({ contactKey, chrome }: { contactKey: string; chrome: Chrome }) {
  const state = useSession();
  const saved = useSavedPasswords();
  // Beside the map, the node is on it already; beside a node's page, which a neighbour's profile opens from, it is not.
  const wide = useWide();
  const nav = useNav();
  const mapBeside = wide && nav.section === "mesh" && nav.stacks.mesh.at(-2)?.kind !== "node";
  const contact = state.contacts[contactKey];
  const [ask, setAsk] = useState<"rename" | "remove" | "forget" | "reboot" | "signin" | null>(null);
  const online = state.status === "ready";

  if (!contact) {
    const removed = state.removed[contactKey]?.contact;
    if (!removed) return <Gone chrome={chrome} title={t("mesh.profile.contact")} text={t("mesh.profile.gone")} />;
    const name = removed.name || removed.prefix;
    return (
      <div className="screen">
        <ScreenHead chrome={chrome} />
        <div className="screen-scroll">
          <div className="hero">
            <Avatar name={name} type={removed.type} size={68} />
            <HeroName name={name} label={t("common.copyName")} />
            <span className="muted">{t("mesh.profile.kindHeard", { kind: kindLabel(removed.type), time: agoPhrase(heardAt(removed) || null) })}</span>
          </div>
          <NotOnRadio contactKey={contactKey} />
          {isConversationType(removed.type) && state.messages.some((m) => m.conversation === contactConversation(contactKey)) ? (
            <Group>
              <LinkRow icon={<ChatIcon size={17} />} label={t("mesh.profile.openChat")} onClick={() => openConversation(contactConversation(contactKey))} />
            </Group>
          ) : null}
        </div>
      </div>
    );
  }

  const key = contact.key;
  const name = contact.name || contact.prefix;
  const node = isNodeType(contact.type);
  const routed = isConversationType(contact.type);
  const login = state.logins[key];
  const signedIn = !!login?.ok;
  const admin = isAdmin(login);
  const managed = login !== undefined || state.statusHistory[key] !== undefined || saved.includes(key);
  const self = state.self;
  const placed = hasPosition(contact.lat, contact.lon);
  const where =
    self && placed && hasPosition(self.lat, self.lon)
      ? t("mesh.profile.whereOfYou", { distance: formatDistance(distanceKm(self.lat, self.lon, contact.lat, contact.lon)), direction: compass(bearingDeg(self.lat, self.lon, contact.lat, contact.lon)) })
      : placed
        ? ""
        : t("mesh.profile.noPosition");
  const heard = heardAt(contact) || null;
  const owner = state.ownerInfo[key];

  const cli = (command: string, done: string) => () =>
    void act(async () => {
      try {
        await session.runCli(key, command);
      } catch (e) {
        // A reboot sends no reply.
        if (!(command === "reboot" && e instanceof NoReplyError)) throw e;
      }
    }, done);

  const more = () => {
    const items: MenuItem[] = [
      { label: t("common.rename"), icon: <EditIcon size={17} />, onSelect: () => setAsk("rename"), disabled: !online },
      { label: t("mesh.profile.shareOnAir"), icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: () => void act(() => session.shareContact(key), t("mesh.profile.shared", { name })) },
      { label: t("mesh.profile.copyKey"), icon: <CopyIcon size={17} />, onSelect: () => void navigator.clipboard?.writeText(key).then(() => toast(t("common.copied"))) },
    ];
    if (admin) {
      items.push(
        { label: t("mesh.profile.advertMesh"), icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: cli("advert", t("mesh.profile.advertised", { name })) },
        { label: t("mesh.profile.advertNear"), icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: cli("advert.zerohop", t("mesh.profile.advertisedNearby", { name })) },
      );
      if (contact.type !== AdvType.Sensor) items.push({ label: t("mesh.profile.clearStats"), icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: cli("clear stats", t("mesh.profile.statsCleared")) });
      if (contact.type === AdvType.Repeater) items.push({ label: owner ? t("mesh.profile.askOwnerAgain") : t("mesh.profile.askOwner"), icon: <AirIcon size={17} />, air: true, disabled: !online, onSelect: () => void act(() => session.requestOwnerInfo(key)) });
      items.push({ label: t("mesh.profile.rebootName", { name }), icon: <PowerIcon size={17} />, danger: true, disabled: !online, onSelect: () => setAsk("reboot") });
    }
    if (node && managed) items.push({ label: t("mesh.profile.forgetNode"), icon: <CloseIcon size={17} />, danger: true, onSelect: () => setAsk("forget") });
    items.push({ label: contact.unsaved ? t("mesh.profile.removeFromList") : t("mesh.profile.removeContact"), icon: <TrashIcon size={17} />, danger: true, disabled: !online && !contact.unsaved, onSelect: () => setAsk("remove") });
    showMenu(items, { title: name });
  };

  const signedMenu = () =>
    showMenu(
      [
        { label: admin ? t("mesh.profile.signInAgain") : t("mesh.profile.signInAdmin"), icon: <LockIcon size={17} />, air: true, disabled: !online, onSelect: () => setAsk("signin") },
        { label: t("mesh.profile.signOut"), icon: <CloseIcon size={17} />, air: true, disabled: !online, onSelect: () => void act(() => session.logout(key), t("mesh.profile.signedOut")) },
      ],
      { title: login?.role === null || login?.role === undefined ? t("mesh.profile.signedInTitle", { name }) : t("mesh.profile.signedInAsTitle", { name, role: roleName(login.role) }) },
    );

  return (
    <div className="screen">
      <ScreenHead
        chrome={chrome}
        actions={
          <>
            {node ? <QueuePill nodeKey={key} /> : null}
            <IconButton label={isFavourite(contact) ? t("mesh.profile.unfavourite") : t("mesh.profile.favourite")} disabled={!online} onClick={() => void act(() => session.setFavourite(key, !isFavourite(contact)))}>
              {isFavourite(contact) ? <StarFilledIcon size={19} className="star" /> : <StarIcon size={19} />}
            </IconButton>
          </>
        }
      />
      <div className="screen-scroll">
        <div className="hero">
          <Avatar name={name} type={contact.type} size={68} />
          <HeroName name={name} label={t("common.copyName")} />
          <span className="muted">{t("mesh.profile.kindHeard", { kind: kindLabel(contact.type), time: agoPhrase(heard) })}</span>
          {where ? <span className="muted">{where}</span> : null}
        </div>

        {contact.unsaved ? <NotOnRadio contactKey={key} /> : null}

        <div className="hero-actions">
          {routed ? (
            <button type="button" className="hero-act primary" onClick={() => openConversation(contactConversation(key))}>
              <ChatIcon size={20} />
              {t("mesh.message")}
            </button>
          ) : null}
          {node ? (
            signedIn ? (
              <button type="button" className="hero-act" onClick={signedMenu}>
                <CheckIcon size={20} />
                {admin ? t("mesh.profile.admin") : t("mesh.profile.signedIn")}
              </button>
            ) : (
              <button type="button" className={["hero-act", routed ? "" : "primary"].join(" ")} disabled={!online} onClick={() => setAsk("signin")}>
                <LockIcon size={20} />
                {t("mesh.profile.signIn")}
              </button>
            )
          ) : null}
          {mapBeside ? null : (
            <button type="button" className="hero-act" disabled={!placed} onClick={() => showOnMap(key, true)}>
              <MapIcon size={20} />
              {t("mesh.profile.onMap")}
            </button>
          )}
          <button type="button" className="hero-act" onClick={more}>
            <MoreIcon size={20} />
            {t("common.more")}
          </button>
        </div>

        <Group>
          <RouteLink contactKey={key} />
          <ForgetRouteRow contactKey={key} />
        </Group>

        {isConversationType(contact.type) ? <ChatNotices conversation={contactConversation(key)} direct={contact.type !== AdvType.Room} /> : null}

        {!node || managed || signedIn ? <NodeReadings contact={contact} /> : null}

        {node ? (
          <Group title={t("mesh.profile.manage")} note={signedIn ? (admin ? undefined : t("mesh.profile.needAdmin")) : t("mesh.profile.signInToSee")}>
            <ClockRow contact={contact} />
            {nodePages(contact.type).map((page) => {
              const locked = !signedIn || (PAGES[page].admin && !admin);
              return (
                <LinkRow
                  key={page}
                  icon={PAGES[page].icon}
                  label={t(PAGES[page].label)}
                  disabled={locked}
                  trailing={locked ? <LockIcon size={14} className="line-chev" /> : undefined}
                  onClick={() => openNodePage(key, page)}
                />
              );
            })}
          </Group>
        ) : null}

        <Group title={t("mesh.profile.details")}>
          <LinkRow label={t("mesh.profile.publicKey")} value={<span className="mono">{key.slice(0, 16)}…</span>} trailing={<CopyIcon size={14} className="line-chev" />} onClick={() => void navigator.clipboard?.writeText(key).then(() => toast(t("common.copied")))} />
          {placed ? (
            <InfoRow label={t("mesh.profile.position")} mono>
              {contact.lat.toFixed(5)}, {contact.lon.toFixed(5)}
            </InfoRow>
          ) : null}
          {owner ? (
            <>
              <InfoRow label={t("mesh.profile.firmware")} mono>
                {owner.firmware}
              </InfoRow>
              <InfoRow label={t("mesh.profile.owner")}>{owner.owner ? <span className="multiline">{owner.owner}</span> : t("mesh.profile.notSet")}</InfoRow>
            </>
          ) : null}
          {login?.firmwareLevel != null ? <InfoRow label={t("mesh.profile.firmwareLevel")}>{login.firmwareLevel}</InfoRow> : null}
        </Group>
      </div>

      <SignIn open={ask === "signin"} nodeKey={key} onClose={() => setAsk(null)} onSignedIn={() => { setAsk(null); toast(t("mesh.profile.signedInTo", { name })); }} />
      <Prompt
        open={ask === "rename"}
        title={t("common.rename")}
        label={t("mesh.profile.renameLabel")}
        initial={contact.name}
        submitLabel={t("common.save")}
        onCancel={() => setAsk(null)}
        onSubmit={async (value) => {
          if (value.trim()) await act(() => session.renameContact(key, value.trim()));
          setAsk(null);
        }}
      />
      <Confirm
        open={ask === "remove"}
        title={t("mesh.profile.removeTitle", { name })}
        body={contact.unsaved ? <p>{t("mesh.profile.removeUnsaved")}</p> : <p>{t("mesh.profile.removeBody")}</p>}
        confirmLabel={t("mesh.profile.remove")}
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          if (await act(() => session.removeContact(key), t("mesh.profile.removed"))) (chrome.onClose ?? chrome.onBack)?.();
        }}
      />
      <Confirm
        open={ask === "forget"}
        title={t("mesh.profile.forgetTitle", { name })}
        body={<p>{hasSavedPassword(key) ? t("mesh.profile.forgetBodyPassword") : t("mesh.profile.forgetBody")}</p>}
        confirmLabel={t("mesh.profile.forget")}
        danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null);
          await forgetPassword(key).catch(() => undefined);
          await session.logout(key).catch(() => undefined);
          session.forgetNode(key);
          toast(t("mesh.profile.forgotten"));
        }}
      />
      <Confirm
        open={ask === "reboot"}
        title={t("mesh.profile.rebootTitle", { name })}
        body={<p>{t("mesh.profile.rebootBody")}</p>}
        confirmLabel={t("mesh.profile.reboot")}
        danger
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          setAsk(null);
          cli("reboot", t("mesh.profile.rebootSent", { name }))();
        }}
      />
    </div>
  );
}
