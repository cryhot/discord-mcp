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

// ─── channel history ─────────────────────────────────────────────────────────

interface Fake {
  id: string;
  createdTimestamp: number;
  createdAt: Date;
  author: { id: string; tag: string; bot: boolean };
  content: string;
  embeds: unknown[];
  attachments: Map<string, unknown>;
  stickers: Map<string, unknown>;
  messageSnapshots: Map<string, unknown>;
  poll: null;
  pinned: boolean;
}

function fake(i: number, content: string, author = "900000000000000001"): Fake {
  return {
    id: idOf(i),
    createdTimestamp: i,
    createdAt: new Date(i),
    author: { id: author, tag: `user${author.slice(-1)}`, bot: false },
    content,
    embeds: [],
    attachments: new Map(),
    stickers: new Map(),
    messageSnapshots: new Map(),
    poll: null,
    pinned: false,
  };
}

/** `count` messages, numbered 1..count from the oldest; every `step`th one says "needle". */
const history = (count: number, author?: (i: number) => string, step = 10) =>
  Array.from({ length: count }, (_, k) =>
    fake(k + 1, (k + 1) % step === 0 ? "needle" : "hay", author?.(k + 1)),
  );

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

/** Serves the history the way Discord does: pages of up to `limit`, the newest first. */
function stubHistory(all: Fake[], roles: Record<string, string[] | null> = {}) {
  const calls: Record<string, unknown>[] = [];
  const fetchedMembers: string[] = [];
  const channel = {
    name: "chan",
    guildId: GUILD,
    guild: {
      members: {
        fetch: async (id: string) => {
          fetchedMembers.push(id);
          const held = roles[id];
          if (!held) throw unknownMember();
          return { roles: { cache: new Map(held.map((role) => [role, {}])) } };
        },
      },
    },
    isDMBased: () => false,
    isTextBased: () => true,
    messages: {
      fetch: async (options: {
        limit: number;
        before?: string;
        after?: string;
        around?: string;
      }) => {
        calls.push(options);
        const ascending = [...all].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        let page: Fake[];
        if (options.before) {
          page = ascending
            .filter((m) => BigInt(m.id) < BigInt(options.before!))
            .slice(-options.limit);
        } else if (options.after) {
          page = ascending
            .filter((m) => BigInt(m.id) > BigInt(options.after!))
            .slice(0, options.limit);
        } else if (options.around) {
          // As Discord does: half of `limit` either side, the extra one on the newer side.
          const at = ascending.findIndex((m) => m.id === options.around);
          const older = Math.floor((options.limit - 1) / 2);
          page = ascending.slice(Math.max(0, at - older), at + (options.limit - 1 - older) + 1);
        } else {
          page = ascending.slice(-options.limit);
        }
        return new Map([...page].reverse().map((m) => [m.id, m]));
      },
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
  return { calls, fetchedMembers };
}

const ids = (result: Record<string, unknown>, key: string) =>
  (result[key] as { id: string }[]).map((m) => m.id);

test("without a filter, search reads only the latest messages asked for, oldest first", async () => {
  const { calls } = stubHistory(history(250));
  const result = body(await run("discord_search_messages", { channel_id: CHANNEL, limit: 5 }));
  assert.deepEqual(ids(result, "matches"), [246, 247, 248, 249, 250].map(idOf));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 5, "no filter, so no reason to read more than the limit");
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBefore, idOf(246));
  assert.ok(!("nextAfter" in result));
});

test("a filter walks back through pages until it has enough matches", async () => {
  const { calls } = stubHistory(history(250, undefined, 50));
  const result = body(
    await run("discord_search_messages", {
      channel_id: CHANNEL,
      keyword: "needle",
      limit: 3,
      limit_search: 1000,
    }),
  );
  // Newest first, the matches are 250, 200 and 150: the third one is the first of the second page.
  assert.deepEqual(ids(result, "matches"), [150, 200, 250].map(idOf));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].before, idOf(151));
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBefore, idOf(150), "resume right after the last message looked at");
});

test("limit_search caps how many messages are looked at, not how many are returned", async () => {
  const { calls } = stubHistory(history(250, undefined, 50));
  const result = body(
    await run("discord_search_messages", {
      channel_id: CHANNEL,
      keyword: "needle",
      limit: 10,
      limit_search: 100,
    }),
  );
  assert.deepEqual(ids(result, "matches"), [200, 250].map(idOf));
  assert.equal(calls.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBefore, idOf(151));
});

test("the end of the history is reported, with nothing to resume from", async () => {
  stubHistory(history(30));
  const result = body(
    await run("discord_search_messages", { channel_id: CHANNEL, keyword: "needle", limit: 10 }),
  );
  assert.deepEqual(ids(result, "matches"), [10, 20, 30].map(idOf));
  assert.equal(result.hasMore, false);
  assert.ok(!("nextBefore" in result) && !("nextAfter" in result));
});

test("after walks forward from a message and says where to carry on", async () => {
  const { calls } = stubHistory(history(30));
  const result = body(
    await run("discord_search_messages", { channel_id: CHANNEL, after: idOf(10), limit: 5 }),
  );
  assert.deepEqual(ids(result, "matches"), [11, 12, 13, 14, 15].map(idOf));
  assert.equal(calls[0].after, idOf(10));
  assert.equal(result.hasMore, true);
  assert.equal(result.nextAfter, idOf(15));
  assert.ok(!("nextBefore" in result));
});

test("since is turned into an after cursor", async () => {
  const { calls } = stubHistory(history(5));
  await run("discord_search_messages", { channel_id: CHANNEL, since: "2026-10-01", limit: 3 });
  assert.match(String(calls[0].after), /^\d{17,20}$/);
  assert.equal(calls[0].before, undefined);
});

test("around without a filter asks for limit messages centered on the anchor", async () => {
  const { calls } = stubHistory(history(40));
  const result = body(
    await run("discord_search_messages", { channel_id: CHANNEL, around: idOf(20), limit: 5 }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].around, idOf(20));
  assert.equal(calls[0].limit, 5, "no filter, so no reason to read more than the limit");
  assert.deepEqual(ids(result, "matches"), [18, 19, 20, 21, 22].map(idOf));
  assert.equal(result.hasMore, false);
});

test("around with a filter reads limit_search messages and keeps the matches nearest the anchor", async () => {
  const { calls } = stubHistory(history(40));
  const result = body(
    await run("discord_search_messages", {
      channel_id: CHANNEL,
      around: idOf(22),
      keyword: "needle",
      limit: 2,
      limit_search: 30,
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 30);
  // The needles are 10, 20, 30 and 40: 20 and 30 are the closest to 22, shown oldest first.
  assert.deepEqual(ids(result, "matches"), [20, 30].map(idOf));
  assert.equal(result.hasMore, false);
});

test("more than one of before, after, around and since is refused", async () => {
  stubHistory(history(5));
  await assert.rejects(
    run("discord_search_messages", { channel_id: CHANNEL, before: idOf(3), after: idOf(1) }),
    /at most one of before, after, around, or since/,
  );
});

test("role_id looks each author's roles up once and drops authors who left", async () => {
  const author = (i: number) =>
    ["900000000000000001", "900000000000000002", "900000000000000003"][i % 3];
  const { fetchedMembers } = stubHistory(history(60, author), {
    "900000000000000001": ["100000000000000010"],
    "900000000000000002": ["100000000000000030"],
    // 900000000000000003 left the server
  });
  const result = body(
    await run("discord_search_messages", {
      channel_id: CHANNEL,
      role_id: ["100000000000000010", "100000000000000020"],
      limit: 100,
      limit_search: 100,
    }),
  );
  const authors = new Set((result.matches as { author: string }[]).map((m) => m.author));
  assert.deepEqual([...authors], ["user1"]);
  assert.equal((result.matches as unknown[]).length, 20);
  assert.equal(fetchedMembers.length, 3, "one lookup per author, not per message");
});

test("read_messages is the same search under its old name and key", async () => {
  stubHistory(history(30));
  const read = body(await run("discord_read_messages", { channel_id: CHANNEL, limit: 4 }));
  const search = body(await run("discord_search_messages", { channel_id: CHANNEL, limit: 4 }));
  assert.deepEqual(read.messages, search.matches);
  assert.equal(read.hasMore, true);
  const description = messages.definitions.find(
    (d) => d.name === "discord_read_messages",
  )!.description;
  assert.match(description ?? "", /^Deprecated: an alias for discord_search_messages/);
});
