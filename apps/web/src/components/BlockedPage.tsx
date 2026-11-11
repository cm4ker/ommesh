import { useMemo } from "react";
import { hiddenCounts, toggleBlock, useBlocks, type Block } from "../lib/blocked.js";
import { useSession } from "../lib/session.js";
import { Button } from "../ui/Button.js";
import { Group } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { UnlockIcon } from "./Icons.js";
import { t } from "../i18n/index.js";

/** The senders blocked (#114): on channels by name, in rooms by the author's key, the latest first, each with Unblock. */
export function BlockedPage() {
  const state = useSession();
  const blocks = useBlocks();
  const counts = useMemo(() => hiddenCounts(state.messages, blocks), [state.messages, blocks]);
  const entries = Object.entries(blocks).sort((a, b) => b[1].at - a[1].at);
  if (entries.length === 0) return <div className="empty muted">{t("radio.blockedPage.empty")}</div>;
  const list = (title: string, items: [string, Block][], room: boolean) =>
    items.length ? (
      <Group title={title}>
        {items.map(([id, block]) => {
          // A room's author goes by the name the radio knows them by now, if it knows them.
          const name = (room ? Object.values(state.contacts).find((c) => c.key.startsWith(id.slice(2)))?.name : null) || block.name;
          const count = counts[id] ?? 0;
          return (
            <div key={id} className="line">
              <Avatar name={name} size={32} />
              <span className="line-text">
                <span>{name}</span>
                <small>{room ? t("radio.blockedPage.byKey", { count }) : t("radio.blockedPage.byName", { count })}</small>
              </span>
              <Button size="sm" onClick={() => toggleBlock(id, name)}>
                <UnlockIcon size={15} /> {t("radio.blockedPage.unblock")}
              </Button>
            </div>
          );
        })}
      </Group>
    ) : null;
  return (
    <>
      {list(
        t("radio.blockedPage.channels"),
        entries.filter(([id]) => id.startsWith("n:")),
        false,
      )}
      {list(
        t("radio.blockedPage.rooms"),
        entries.filter(([id]) => id.startsWith("k:")),
        true,
      )}
    </>
  );
}
