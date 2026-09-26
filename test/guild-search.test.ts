import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { Routes } from "discord.js";
import { discord } from "../src/client.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";
const USER = "222222222222222222";

afterEach(() => mock.restoreAll());

const handler = (name: string) => messages.handlers.get(name)!;

const THREAD = "888888888888888888";
const ELSEWHERE = "121212121212121212";

function rawHit(id: string, channelId: string, content: string) {
  return {
    id,
    type: 0,
    content,
    timestamp: "2026-09-01T10:00:00.000000+00:00",
    channel_id: channelId,
    author: { id: USER, username: "alice", discriminator: "0" },
    embeds: [],
    attachments: [],
  };
}

/** Stubs the search route with `body` and the guild channel cache; returns the recorded GETs. */
function stubSearch(body: unknown) {
  const gets: { route: string; query: URLSearchParams }[] = [];
  mock.method(discord.rest, "get", (async (route: string, options: { query: URLSearchParams }) => {
    gets.push({ route, query: options.query });
    return body;
  }) as never);
  mock.method(
    discord.guilds,
    "fetch",
    async () => ({ channels: { cache: new Map([[CHANNEL, { name: "general" }]]) } }) as never,
  );
  return gets;
}

const search = (args: Record<string, unknown>) =>
  handler("discord_search_guild_messages")({ guild_id: GUILD, ...args });

test("search_guild_messages forwards every paging and filter parameter", async () => {
  const gets = stubSearch({ total_results: 0, doing_deep_historical_index: false, messages: [] });
  await search({
    query: "release",
    channel_id: CHANNEL,
    author_id: USER,
    has: ["image", "-link"],
    min_id: "400000000000000000",
    max_id: "500000000000000000",
    sort_order: "asc",
    include_nsfw: true,
    offset: 50,
    limit: 10,
  });
  assert.equal(gets.length, 1);
  assert.equal(gets[0].route, Routes.guildMessagesSearch(GUILD));
  const q = gets[0].query;
  assert.equal(q.get("content"), "release");
  assert.equal(q.get("channel_id"), CHANNEL);
  assert.equal(q.get("author_id"), USER);
  assert.deepEqual(q.getAll("has"), ["image", "-link"], "each has value is its own parameter");
  assert.equal(q.get("min_id"), "400000000000000000");
  assert.equal(q.get("max_id"), "500000000000000000");
  assert.equal(q.get("sort_order"), "asc");
  assert.equal(q.get("include_nsfw"), "true");
  assert.equal(q.get("offset"), "50");
  assert.equal(q.get("limit"), "10");
});

test("search_guild_messages sends only what was asked, and query is optional", async () => {
  const gets = stubSearch({ total_results: 0, doing_deep_historical_index: false, messages: [] });
  await search({ has: ["file"] });
  assert.deepEqual([...gets[0].query.keys()].sort(), ["has", "limit"]);
  assert.equal(gets[0].query.get("limit"), "25");
});

test("search_guild_messages returns total_results and names thread hits from the response", async () => {
  stubSearch({
    total_results: 42,
    doing_deep_historical_index: false,
    messages: [
      [rawHit("900000000000000001", CHANNEL, "in a channel")],
      [rawHit("900000000000000002", THREAD, "in a forum post")],
      [rawHit("900000000000000003", ELSEWHERE, "in an uncached channel")],
    ],
    threads: [{ id: THREAD, name: "bug-report", type: 11 }],
  });
  const result = await search({ query: "in" });
  assert.ok(!result.isError, JSON.stringify(result.content));
  const out = result.structuredContent as {
    total_results: number;
    matches: { channel_id: string; channel_name: string; author: string }[];
  };
  assert.equal(out.total_results, 42);
  assert.deepEqual(
    out.matches.map((m) => m.channel_name),
    ["general", "bug-report", "unknown"],
  );
  assert.equal(out.matches[0].author, "alice");
});

test("search_guild_messages reports an index that is still building", async () => {
  stubSearch({
    message: "Index not yet available.",
    code: 110000,
    documents_indexed: 0,
    retry_after: 3,
  });
  await assert.rejects(() => search({ query: "x" }), /still building.*Retry in 3s/);
});

test("search_guild_messages rejects out-of-range offsets and unknown has types", async () => {
  const gets = stubSearch({ total_results: 0, doing_deep_historical_index: false, messages: [] });
  await assert.rejects(() => search({ query: "x", offset: 9976 }), ZodError);
  await assert.rejects(() => search({ query: "x", has: ["gif"] }), ZodError);
  await assert.rejects(() => search({ query: "x", sort_order: "newest" }), ZodError);
  assert.equal(gets.length, 0);
});
