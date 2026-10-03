import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "discord.js";
import {
  MessageFilter,
  targetOfMessage,
  targetOfRaw,
  type FilterTarget,
  type RawFilterable,
} from "../src/messageFilters.js";

const AUTHOR = "999999999999999999";

function target(texts: string[], has: FilterTarget["has"] = new Set(), authorId = AUTHOR) {
  return { authorId, texts, has } satisfies FilterTarget;
}

test("keyword keeps a message that contains any of the keywords, ignoring case", () => {
  const filter = new MessageFilter({ keyword: ["Alpha", "beta"] });
  assert.ok(filter.matches(target(["an ALPHA release"])));
  assert.ok(filter.matches(target(["x", "the Beta"])));
  assert.ok(!filter.matches(target(["gamma"])));
  assert.ok(new MessageFilter({ keyword: "alpha" }).matches(target(["Alpha"])));
});

test("regex keeps a message that matches any pattern, ignoring case", () => {
  const filter = new MessageFilter({ regex: ["^v\\d+$", "release"] });
  assert.ok(filter.matches(target(["V12"])));
  assert.ok(filter.matches(target(["a Release note"])));
  assert.ok(!filter.matches(target(["nothing"])));
});

test("an invalid regex is refused and named", () => {
  assert.throws(() => new MessageFilter({ regex: "(unclosed" }), /Invalid regex "\(unclosed"/);
});

test("different filters must all pass, the values of one filter are alternatives", () => {
  const filter = new MessageFilter({
    keyword: "deploy",
    regex: "\\d+",
    author_id: [AUTHOR, "111111111111111111"],
  });
  assert.ok(filter.matches(target(["deploy 42"])));
  assert.ok(!filter.matches(target(["deploy now"])), "no digits");
  assert.ok(!filter.matches(target(["42"])), "no keyword");
  assert.ok(
    !filter.matches(target(["deploy 42"], new Set(), "222222222222222222")),
    "other author",
  );
});

test("has keeps messages with any of the wanted types and none of the unwanted ones", () => {
  const withFile = target([], new Set(["file"]));
  const withImage = target([], new Set(["file", "image"]));
  const withPoll = target([], new Set(["poll"]));
  assert.ok(new MessageFilter({ has: ["image", "poll"] }).matches(withPoll));
  assert.ok(new MessageFilter({ has: ["image", "poll"] }).matches(withImage));
  assert.ok(!new MessageFilter({ has: ["image", "poll"] }).matches(withFile));
  const filter = new MessageFilter({ has: ["file", "-image"] });
  assert.ok(filter.matches(withFile));
  assert.ok(!filter.matches(withImage));
  assert.ok(
    new MessageFilter({ has: "-poll" }).matches(withFile),
    "an exclusion alone keeps the rest",
  );
});

test("the role filter needs the author's roles, and never matches an author who left", () => {
  const filter = new MessageFilter({ role_id: ["10", "20"] });
  assert.ok(filter.needsRoles);
  assert.ok(filter.hasRole(new Set(["20", "30"])));
  assert.ok(!filter.hasRole(new Set(["30"])));
  assert.ok(!filter.hasRole(null));
  assert.ok(new MessageFilter({}).hasRole(null), "no role filter keeps everyone");
});

test("a filter given nothing is empty and keeps every message", () => {
  const filter = new MessageFilter({});
  assert.ok(filter.isEmpty);
  assert.ok(filter.matches(target([])));
  assert.ok(!new MessageFilter({ keyword: "x" }).isEmpty);
});

const embed = (data: Record<string, unknown>) => ({ data });

function fakeMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    author: { id: AUTHOR },
    content: "",
    embeds: [],
    attachments: new Map(),
    stickers: new Map(),
    messageSnapshots: new Map(),
    poll: null,
    ...overrides,
  } as unknown as Message;
}

test("the text of a message is what its author wrote: content, own embeds, poll, forward", () => {
  const { texts } = targetOfMessage(
    fakeMessage({
      content: "hello",
      embeds: [
        embed({
          type: "rich",
          title: "T",
          description: "D",
          author: { name: "A" },
          fields: [{ name: "N", value: "V" }],
          footer: { text: "F" },
        }),
        embed({ type: "link", title: "a preview", description: "of a page" }),
      ],
      poll: { question: { text: "Q?" }, answers: new Map([[1, { text: "yes" }]]) },
      messageSnapshots: new Map([
        ["1", { content: "forwarded", embeds: [embed({ type: "rich", title: "FT" })] }],
      ]),
      referencedMessage: { content: "the message a reply answers" },
    }),
  );
  assert.deepEqual(texts, ["hello", "T", "D", "A", "N", "V", "F", "forwarded", "FT", "Q?", "yes"]);
});

test("has reads what a message contains", () => {
  const attachment = (contentType: string) => ({ contentType });
  const has = (overrides: Record<string, unknown>) =>
    [...targetOfMessage(fakeMessage(overrides)).has].sort();
  assert.deepEqual(has({ content: "see https://example.com/x" }), ["link"]);
  assert.deepEqual(has({ embeds: [embed({ type: "link" })] }), ["embed"]);
  assert.deepEqual(has({ attachments: new Map([["a", attachment("image/png")]]) }), [
    "file",
    "image",
  ]);
  assert.deepEqual(has({ attachments: new Map([["a", attachment("video/mp4")]]) }), [
    "file",
    "video",
  ]);
  assert.deepEqual(has({ attachments: new Map([["a", attachment("audio/ogg")]]) }), [
    "file",
    "sound",
  ]);
  assert.deepEqual(has({ attachments: new Map([["a", attachment("text/plain")]]) }), ["file"]);
  assert.deepEqual(has({ stickers: new Map([["s", {}]]) }), ["sticker"]);
  assert.deepEqual(has({ poll: { question: { text: "Q" }, answers: new Map() } }), ["poll"]);
  assert.deepEqual(has({ messageSnapshots: new Map([["1", { content: "", embeds: [] }]]) }), [
    "snapshot",
  ]);
  assert.deepEqual(has({}), []);
});

test("a raw search hit gives the same texts and types as the discord.js message", () => {
  const raw: RawFilterable = {
    content: "hello https://example.com",
    author: { id: AUTHOR },
    attachments: [{ content_type: "image/png" }],
    embeds: [
      { type: "rich", title: "T", fields: [{ name: "N", value: "V" }] },
      { type: "link", title: "a preview" },
    ],
    sticker_items: [{}],
    poll: { question: { text: "Q?" }, answers: [{ poll_media: { text: "yes" } }] },
    message_snapshots: [
      { message: { content: "forwarded", embeds: [{ type: "rich", title: "FT" }] } },
    ],
  };
  const message = fakeMessage({
    content: "hello https://example.com",
    attachments: new Map([["a", { contentType: "image/png" }]]),
    embeds: [
      embed({ type: "rich", title: "T", fields: [{ name: "N", value: "V" }] }),
      embed({ type: "link", title: "a preview" }),
    ],
    stickers: new Map([["s", {}]]),
    poll: { question: { text: "Q?" }, answers: new Map([[1, { text: "yes" }]]) },
    messageSnapshots: new Map([
      ["1", { content: "forwarded", embeds: [embed({ type: "rich", title: "FT" })] }],
    ]),
  });
  const fromRaw = targetOfRaw(raw);
  const fromMessage = targetOfMessage(message);
  assert.deepEqual(fromRaw.texts, fromMessage.texts);
  assert.deepEqual([...fromRaw.has].sort(), [...fromMessage.has].sort());
  assert.equal(fromRaw.authorId, fromMessage.authorId);
});
