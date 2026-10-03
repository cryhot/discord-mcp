import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discord } from "../src/client.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";
const AUTHOR = "900000000000000001";
const BASE = 1_000_000_000_000_000_000n;

afterEach(() => mock.restoreAll());

const idOf = (i: number) => String(BASE + BigInt(i));

function pin(i: number, content: string) {
  return {
    message: {
      id: idOf(i),
      createdTimestamp: i,
      createdAt: new Date(i),
      author: { id: AUTHOR, tag: "someone", bot: false },
      content,
      embeds: [],
      attachments: new Map(),
      stickers: new Map(),
      messageSnapshots: new Map(),
      poll: null,
      pinned: true,
    },
    pinnedAt: new Date(1_000_000 - i),
  };
}

/** Serves two pages of pins, the way the pins endpoint does, and records the cursors asked. */
function stubPins(pages: ReturnType<typeof pin>[][]) {
  const calls: Record<string, unknown>[] = [];
  const channel = {
    name: "chan",
    guildId: GUILD,
    guild: { members: { fetch: async () => ({ roles: { cache: new Map() } }) } },
    isDMBased: () => false,
    isTextBased: () => true,
    messages: {
      fetchPins: async (options: Record<string, unknown>) => {
        calls.push(options);
        const items = pages[calls.length - 1] ?? [];
        return { items, hasMore: calls.length < pages.length };
      },
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
  return calls;
}

const run = (args: Record<string, unknown>) =>
  messages.handlers.get("discord_fetch_pinned_messages")!({ channel_id: CHANNEL, ...args });

const idsOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { messages: { id: string }[] }).messages.map((m) => m.id);

test("the pins are filtered across every page, not just the first", async () => {
  const calls = stubPins([
    [pin(1, "hay"), pin(2, "needle")],
    [pin(3, "hay"), pin(4, "needle")],
  ]);
  const result = await run({ keyword: "needle" });
  assert.equal(calls.length, 2, "both pages are read before the filter is applied");
  assert.deepEqual(idsOf(result), [idOf(2), idOf(4)]);
});

test("without a filter every pin is returned", async () => {
  stubPins([[pin(1, "a"), pin(2, "b")]]);
  assert.deepEqual(idsOf(await run({})), [idOf(1), idOf(2)]);
});

test("the pins can be filtered by regex and by author", async () => {
  stubPins([[pin(1, "v1"), pin(2, "v22"), pin(3, "text")]]);
  assert.deepEqual(idsOf(await run({ regex: "^v\\d+$" })), [idOf(1), idOf(2)]);
  stubPins([[pin(1, "v1")]]);
  assert.deepEqual(idsOf(await run({ author_id: "800000000000000001" })), []);
});
