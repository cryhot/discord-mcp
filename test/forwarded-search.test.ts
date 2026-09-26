import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Collection } from "discord.js";
import { discord } from "../src/client.js";
import { messageTexts } from "../src/messageText.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";
const PLAIN = "900000000000000001";
const FORWARD = "900000000000000002";

afterEach(() => mock.restoreAll());

function fakeMessage(id: string, offsetMs: number, content: string, snapshots: unknown[] = []) {
  const createdTimestamp = Date.parse("2026-09-01T00:00:00Z") + offsetMs;
  return {
    id,
    author: { tag: "alice", id: "222222222222222222" },
    content,
    createdTimestamp,
    createdAt: new Date(createdTimestamp),
    attachments: new Collection(),
    embeds: [],
    pinned: false,
    messageSnapshots: new Collection(
      snapshots.map((s, i) => [`snapshot${i}`, s] as [string, unknown]),
    ),
  };
}

function stubChannelHistory() {
  const history = new Collection(
    [
      fakeMessage(PLAIN, 0, "hello"),
      fakeMessage(FORWARD, 1000, "", [
        { content: "the release notes", embeds: [{ data: { title: "v2", type: "rich" } }] },
      ]),
    ].map((m) => [m.id, m] as [string, unknown]),
  );
  const channel = {
    name: "chan",
    guildId: GUILD,
    isDMBased: () => false,
    isTextBased: () => true,
    messages: { fetch: async () => history },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
}

const search = async (keyword: string) => {
  const result = await messages.handlers.get("discord_search_messages")!({
    channel_id: CHANNEL,
    keyword,
  });
  return (result.structuredContent as { matches: { id: string }[] }).matches.map((m) => m.id);
};

test("search_messages matches a forward on the content it forwards", async () => {
  stubChannelHistory();
  assert.deepEqual(await search("RELEASE"), [FORWARD]);
});

test("search_messages matches a forward on the embeds it forwards", async () => {
  stubChannelHistory();
  assert.deepEqual(await search("v2"), [FORWARD]);
});

test("search_messages still matches an ordinary message and misses what nobody wrote", async () => {
  stubChannelHistory();
  assert.deepEqual(await search("hello"), [PLAIN]);
  assert.deepEqual(await search("nothing"), []);
});

test("messageTexts lists each part of what a message says, and nothing for empty parts", () => {
  const embed = { type: "rich" as const, title: "T", description: "D" };
  assert.deepEqual(
    messageTexts({
      content: "hello",
      embeds: [embed, { type: "link" as const, title: "preview" }],
      snapshots: [{ content: "", embeds: [{ ...embed, title: "FT" }] }],
    }),
    ["hello", "T", "D", "FT", "D"],
  );
  assert.deepEqual(messageTexts({ content: "", embeds: [], snapshots: [] }), []);
});
