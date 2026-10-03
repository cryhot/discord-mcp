import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DiscordAPIError } from "discord.js";
import { discord } from "../src/client.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";
const BASE = 1_000_000_000_000_000_000n;

afterEach(() => mock.restoreAll());

const idOf = (i: number) => String(BASE + BigInt(i));
const run = (tool: string, args: Record<string, unknown>) => messages.handlers.get(tool)!(args);
const body = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;

const ids = (result: Record<string, unknown>, key: string) =>
  (result[key] as { id: string }[]).map((m) => m.id);

function unknownMember() {
  return new DiscordAPIError(
    { code: 10007, message: "Unknown Member" },
    10007,
    404,
    "GET",
    "/guilds/x/members/y",
    {},
  );
}

// ─── guild search ────────────────────────────────────────────────────────────

const hit = (i: number, content: string, author = "900000000000000001") => ({
  id: idOf(i),
  channel_id: CHANNEL,
  content,
  timestamp: "2026-10-01T10:00:00.000000+00:00",
  author: { id: author, username: `user${author.slice(-1)}`, discriminator: "0" },
});

/** Serves `hits` the way the search endpoint does, `limit` at a time from `offset`. */
function stubSearch(hits: ReturnType<typeof hit>[], roles: Record<string, string[] | null> = {}) {
  const queries: URLSearchParams[] = [];
  mock.method(discord.rest, "get", (async (_route: string, options: { query: URLSearchParams }) => {
    queries.push(options.query);
    const offset = Number(options.query.get("offset") ?? 0);
    const limit = Number(options.query.get("limit"));
    return {
      total_results: hits.length,
      messages: hits.slice(offset, offset + limit).map((h) => [h]),
    };
  }) as never);
  mock.method(
    discord.guilds,
    "fetch",
    async () =>
      ({
        channels: { cache: new Map([[CHANNEL, { name: "general" }]]) },
        members: {
          fetch: async (id: string) => {
            const held = roles[id];
            if (!held) throw unknownMember();
            return { roles: { cache: new Map(held.map((role) => [role, {}])) } };
          },
        },
      }) as never,
  );
  return queries;
}

const search = (args: Record<string, unknown>) =>
  run("discord_search_guild_messages", { guild_id: GUILD, ...args });

const hits60 = Array.from({ length: 60 }, (_, k) => hit(k + 1, `hit ${k + 1}`));

test("guild search sends one parameter per value of channel_id, author_id and has", async () => {
  const queries = stubSearch([]);
  await search({
    keyword: "release",
    channel_id: [CHANNEL, "444444444444444444"],
    author_id: ["222222222222222222", "555555555555555555"],
    has: ["file", "-image"],
  });
  const q = queries[0];
  assert.equal(q.get("content"), "release");
  assert.deepEqual(q.getAll("channel_id"), [CHANNEL, "444444444444444444"]);
  assert.deepEqual(q.getAll("author_id"), ["222222222222222222", "555555555555555555"]);
  assert.deepEqual(q.getAll("has"), ["file", "-image"]);
});

test("guild search still takes query, the former name of keyword", async () => {
  const queries = stubSearch([]);
  await search({ query: "release" });
  assert.equal(queries[0].get("content"), "release");
  await assert.rejects(
    search({ keyword: "a", query: "b" }),
    /not both keyword and its former name/,
  );
});

test("regex is applied to what Discord returned, and hasMore says where to resume", async () => {
  const queries = stubSearch(hits60);
  const first = body(await search({ regex: "7$", limit: 2 }));
  assert.deepEqual(ids(first, "matches"), [7, 17].map(idOf));
  assert.equal(first.total_results, 60, "Discord's count, before regex");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 17);
  assert.ok(!queries[0].has("offset"));
  assert.equal(queries[0].get("limit"), "25");

  const second = body(await search({ regex: "7$", limit: 2, offset: 17 }));
  assert.deepEqual(ids(second, "matches"), [27, 37].map(idOf));
  assert.equal(queries[1].get("offset"), "17");
  assert.equal(second.nextOffset, 37);
});

test("limit_search caps how many of Discord's results regex looks at", async () => {
  const queries = stubSearch(hits60);
  const result = body(await search({ regex: "never matches", limit: 5, limit_search: 30 }));
  assert.deepEqual(result.matches, []);
  assert.deepEqual(
    queries.map((q) => q.get("limit")),
    ["25", "5"],
  );
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 30);
});

test("without regex or role_id the limit is exactly what is asked of Discord", async () => {
  const queries = stubSearch(hits60);
  const result = body(await search({ keyword: "hit", limit: 10, limit_search: 500 }));
  assert.equal((result.matches as unknown[]).length, 10);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].get("limit"), "10");
  assert.equal(result.nextOffset, 10);
});

test("the end of Discord's results is reported", async () => {
  stubSearch(hits60.slice(0, 10));
  const result = body(await search({ regex: "never matches" }));
  assert.equal(result.hasMore, false);
  assert.ok(!("nextOffset" in result));
});

test("role_id on a guild search keeps authors who hold the role", async () => {
  stubSearch(
    [
      hit(1, "a", "900000000000000001"),
      hit(2, "b", "900000000000000002"),
      hit(3, "c", "900000000000000003"),
    ],
    { "900000000000000001": ["100000000000000010"], "900000000000000002": ["100000000000000020"] },
  );
  const result = body(await search({ role_id: "100000000000000010" }));
  assert.deepEqual(ids(result, "matches"), [idOf(1)]);
});
