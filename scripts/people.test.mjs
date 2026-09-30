import { test } from "node:test";
import assert from "node:assert/strict";
import { people, renderPeople, replaceSection } from "./people.mjs";

const user = (login, type = "User") => ({ login, type, avatar_url: `https://avatars.githubusercontent.com/u/${login.length}?v=4` });
const issue = (login, pull = false) => ({ user: user(login), ...(pull ? { pull_request: {} } : {}) });

test("the owner leads, then code, then reports; pull requests and bots are not reports", () => {
  const list = people({
    owner: "cm4ker",
    contributors: [{ ...user("cm4ker"), contributions: 264 }, { ...user("DyGygg"), contributions: 1 }, { ...user("dependabot[bot]", "Bot"), contributions: 3 }],
    issues: [issue("Wandering79"), issue("DyGygg"), issue("DyGygg"), issue("DyGygg", true), issue("cm4ker"), issue("Alksndr55"), issue("Alksndr55"), issue("Wandering79"), issue("Wandering79"), { user: user("github-actions[bot]", "Bot") }],
  });
  assert.deepEqual(list.map((p) => [p.login, p.commits, p.reports]), [["cm4ker", 264, 1], ["DyGygg", 1, 2], ["Wandering79", 0, 3], ["Alksndr55", 0, 2]]);
});

test("six people to a row, a picture and a name each, no links", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ login: `p${i}`, avatar: "https://avatars.githubusercontent.com/u/1?v=4", commits: 0, reports: 1 }));
  const html = renderPeople(list);
  assert.equal(html.match(/<tr>/g).length, 2);
  assert.match(html, /u\/1\?v=4&s=128" width="64"/);
  assert.match(html, /<br \/><b>p0<\/b><\/td>/);
  assert.doesNotMatch(html, /<a /);
});

test("only the text between the markers changes", () => {
  const text = "# Title\n\n<!-- people:start -->\nold\n<!-- people:end -->\n\nAfter.\n";
  assert.equal(replaceSection(text, "new"), "# Title\n\n<!-- people:start -->\nnew\n<!-- people:end -->\n\nAfter.\n");
  assert.equal(replaceSection(text.replace(/\n/g, "\r\n"), "a\nb"), "# Title\r\n\r\n<!-- people:start -->\r\na\r\nb\r\n<!-- people:end -->\r\n\r\nAfter.\r\n");
  assert.equal(replaceSection("<!-- people:start -->\n<!-- people:end -->", "new"), "<!-- people:start -->\nnew\n<!-- people:end -->");
  assert.throws(() => replaceSection("# No markers\n", "new"), /markers/);
});
