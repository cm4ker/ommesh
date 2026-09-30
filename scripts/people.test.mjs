import { test } from "node:test";
import assert from "node:assert/strict";
import { people, renderPeople, replaceSection, role } from "./people.mjs";

const user = (login, type = "User") => ({ login, type, avatar_url: `https://avatars.githubusercontent.com/u/${login.length}?v=4` });
const issue = (login, pull = false) => ({ user: user(login), ...(pull ? { pull_request: {} } : {}) });

test("the owner leads, then code, then reports; pull requests and bots are not reports", () => {
  const list = people({
    owner: "cm4ker",
    contributors: [{ ...user("cm4ker"), contributions: 264 }, { ...user("DyGygg"), contributions: 1 }, { ...user("dependabot[bot]", "Bot"), contributions: 3 }],
    issues: [issue("Wandering79"), issue("DyGygg"), issue("DyGygg"), issue("DyGygg", true), issue("cm4ker"), issue("Alksndr55"), issue("Alksndr55"), issue("Wandering79"), issue("Wandering79"), { user: user("github-actions[bot]", "Bot") }],
  });
  assert.deepEqual(list.map((p) => [p.login, p.commits, p.reports]), [["cm4ker", 264, 1], ["DyGygg", 1, 2], ["Wandering79", 0, 3], ["Alksndr55", 0, 2]]);
  assert.equal(role(list[0], "en"), "maintainer · 1 report");
  assert.equal(role(list[1], "ru"), "код · 2 обращения");
  assert.equal(role(list[2], "en"), "3 reports");
});

test("Russian counts take the right form", () => {
  const form = (reports) => role({ commits: 0, reports }, "ru");
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111].map(form),
    ["1 обращение", "2 обращения", "5 обращений", "11 обращений", "12 обращений", "21 обращение", "22 обращения", "25 обращений", "111 обращений"]);
});

test("six people to a row, avatars asked at twice the shown size", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ login: `p${i}`, avatar: "https://avatars.githubusercontent.com/u/1?v=4", commits: 0, reports: 1 }));
  const html = renderPeople(list, "en");
  assert.equal(html.match(/<tr>/g).length, 2);
  assert.match(html, /u\/1\?v=4&s=128" width="64"/);
});

test("only the text between the markers changes", () => {
  const text = "# Title\n\n<!-- people:start -->\nold\n<!-- people:end -->\n\nAfter.\n";
  assert.equal(replaceSection(text, "new"), "# Title\n\n<!-- people:start -->\nnew\n<!-- people:end -->\n\nAfter.\n");
  assert.equal(replaceSection(text.replace(/\n/g, "\r\n"), "a\nb"), "# Title\r\n\r\n<!-- people:start -->\r\na\r\nb\r\n<!-- people:end -->\r\n\r\nAfter.\r\n");
  assert.throws(() => replaceSection("# No markers\n", "new"), /markers/);
});
