import { t } from "../i18n/index.js";
import people from "../lib/people.json";
import { push } from "../lib/nav.js";
import { openLink } from "../lib/webLinks.js";
import { Group, LinkRow } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { ExternalIcon, UsersIcon } from "./Icons.js";

/**
 * Who makes Ommesh: everyone with code on master or an issue on GitHub, as
 * scripts/people.mjs wrote them down. The pictures ship with the app, so the
 * list looks the same with no network; the swatch behind each shows while one
 * loads.
 */
interface Person {
  login: string;
  picture: string;
}

const list: Person[] = people;

/** Where a new report or idea goes. */
const NEW_ISSUE = "https://github.com/cm4ker/ommesh/issues/new";

function Face({ person, size }: { person: Person; size: number }) {
  return <Avatar name={person.login} size={size} icon={<img src={`./${person.picture}`} alt="" loading="lazy" />} />;
}

/** About's way in: three faces and how many there are. */
export function PeopleRow() {
  return (
    <LinkRow
      label={t("radio.titles.people")}
      icon={<UsersIcon size={17} />}
      value={
        <span className="faces">
          <span className="faces-stack">
            {list.slice(0, 3).map((person) => <Face key={person.login} person={person} size={22} />)}
          </span>
          {list.length}
        </span>
      }
      onClick={() => push({ kind: "radio", page: "people" })}
    />
  );
}

/** Opens a new issue on GitHub in the system's browser. */
export function ReportRow() {
  return <LinkRow label={t("radio.about.report")} hint={t("radio.about.reportHint")} tone="accent" trailing={<ExternalIcon size={14} className="line-chev" />} onClick={() => openLink(NEW_ISSUE)} />;
}

export function PeoplePage() {
  return <>
    <Group note={t("radio.people.note")}>
      {list.map((person) => (
        <div key={person.login} className="line">
          <Face person={person} size={32} />
          <span className="line-text">{person.login}</span>
        </div>
      ))}
    </Group>
    <p className="people-thanks">{t("radio.people.thanks")}</p>
  </>;
}
