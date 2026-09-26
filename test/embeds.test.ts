import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discord } from "../src/client.js";
import { summarizeEmbed, embedText, embedTexts } from "../src/embeds.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";
const MESSAGE = "555555555555555555";

afterEach(() => mock.restoreAll());

const SUGGESTION = {
  title: "#180: Dodać end",
  description: "Please add the End dimension.",
  url: "https://example.com/s/180",
  color: 0x00ff00,
  author: { name: "player", icon_url: "https://example.com/a.png" },
  fields: [
    { name: "Status", value: "Pending", inline: true },
    { name: "Votes", value: "12 / 3" },
  ],
  footer: { text: "Suggestion #180" },
  image: { url: "https://example.com/i.png" },
  thumbnail: { url: "https://example.com/t.png" },
  timestamp: "2026-09-14T14:28:06.738Z",
};

/** A discord.js-shaped bot message whose text lives entirely in one embed. */
function botMessage(embed: Record<string, unknown>) {
  const createdAt = new Date("2026-09-14T14:28:06.738Z");
  return {
    id: MESSAGE,
    author: { tag: "Redstone Propozycje#2490" },
    content: "",
    embeds: [{ data: embed }],
    createdAt,
    createdTimestamp: createdAt.getTime(),
    attachments: { size: 0 },
    pinned: false,
  };
}

/** Stubs the channel lookup so every history fetch returns the given messages. */
function stubHistory(...msgs: ReturnType<typeof botMessage>[]): void {
  const channel = {
    name: "chan",
    guildId: GUILD,
    isDMBased: () => false,
    isTextBased: () => true,
    messages: { fetch: async () => new Map(msgs.map((m) => [m.id, m])) },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
}

test("summarizeEmbed flattens every embed part", () => {
  assert.deepEqual(summarizeEmbed(SUGGESTION), {
    title: "#180: Dodać end",
    url: "https://example.com/s/180",
    description: "Please add the End dimension.",
    color: "#00ff00",
    author: "player",
    fields: [
      { name: "Status", value: "Pending", inline: true },
      { name: "Votes", value: "12 / 3", inline: false },
    ],
    footer: "Suggestion #180",
    image_url: "https://example.com/i.png",
    thumbnail_url: "https://example.com/t.png",
    timestamp: "2026-09-14T14:28:06.738Z",
  });
});

test("summarizeEmbed zero-pads dark colors and omits absent parts", () => {
  const summary = summarizeEmbed({ description: "only text", color: 0x0000ff, fields: [] });
  assert.equal(summary.color, "#0000ff");
  assert.equal(JSON.stringify(summary), '{"description":"only text","color":"#0000ff"}');
});

test("embedTexts gives one string per part, and nothing for the embed of a link", () => {
  assert.deepEqual(embedTexts({ ...SUGGESTION, type: "rich" }), [
    "#180: Dodać end",
    "Please add the End dimension.",
    "player",
    "Status",
    "Pending",
    "Votes",
    "12 / 3",
    "Suggestion #180",
  ]);
  for (const type of ["link", "article", "image", "video", "gifv"] as const) {
    assert.deepEqual(embedTexts({ ...SUGGESTION, type }), [], type);
  }
  assert.equal(embedText({ ...SUGGESTION, type: "link" }), "");
});

test("embedText covers title, description, author, fields and footer", () => {
  const text = embedText(SUGGESTION);
  for (const part of ["#180", "End dimension", "player", "Status", "12 / 3", "Suggestion #180"]) {
    assert.ok(text.includes(part), `embed text should include "${part}"`);
  }
});

test("read_messages returns the embeds of an empty-content bot message", async () => {
  stubHistory(botMessage(SUGGESTION));
  const result = await messages.handlers.get("discord_read_messages")!({ channel_id: CHANNEL });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const { messages: read } = result.structuredContent as {
    messages: { content: string; embeds: { title?: string; fields?: unknown[] }[] }[];
  };
  assert.equal(read[0].content, "");
  assert.equal(read[0].embeds[0].title, "#180: Dodać end");
  assert.equal(read[0].embeds[0].fields?.length, 2);
});

test("search_messages matches a keyword that only appears inside an embed", async () => {
  stubHistory(botMessage(SUGGESTION));
  const search = messages.handlers.get("discord_search_messages")!;
  const hit = await search({ channel_id: CHANNEL, keyword: "end dimension" });
  const { matches } = hit.structuredContent as { matches: { id: string }[] };
  assert.deepEqual(
    matches.map((m) => m.id),
    [MESSAGE],
  );
  const miss = await search({ channel_id: CHANNEL, keyword: "nether" });
  assert.equal((miss.structuredContent as { matches: unknown[] }).matches.length, 0);
});

test("search_guild_messages maps raw REST embeds", async () => {
  mock.method(discord.rest, "get", async () => ({
    messages: [
      [
        {
          id: MESSAGE,
          content: "",
          embeds: [SUGGESTION],
          timestamp: "2026-09-14T14:28:06.738000+00:00",
          channel_id: CHANNEL,
          author: { username: "Redstone Propozycje", discriminator: "2490" },
        },
      ],
    ],
  }));
  mock.method(discord.guilds, "fetch", async () => ({ channels: { cache: new Map() } }) as never);
  const result = await messages.handlers.get("discord_search_guild_messages")!({
    guild_id: GUILD,
    query: "end",
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const { matches } = result.structuredContent as {
    matches: { embeds: { footer?: string }[] }[];
  };
  assert.equal(matches[0].embeds[0].footer, "Suggestion #180");
});
