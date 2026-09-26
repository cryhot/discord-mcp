import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discord } from "../src/client.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";

afterEach(() => mock.restoreAll());

const handler = (name: string) => messages.handlers.get(name)!;

/** Stubs the channel lookup with a message-capable guild channel carrying `extra`. */
function stubChannel(extra: Record<string, unknown>) {
  const channel = {
    id: CHANNEL,
    name: "chan",
    guildId: GUILD,
    type: 0,
    isDMBased: () => false,
    isTextBased: () => true,
    isThread: () => false,
    ...extra,
  };
  return mock.method(discord.channels, "fetch", async () => channel as never);
}

function fakePin(n: number, pinnedAt: number) {
  const id = String(700000000000000000n + BigInt(n));
  return {
    message: {
      id,
      author: { tag: "user" },
      content: `pin ${n}`,
      createdAt: new Date(pinnedAt - 1000),
      embeds: [],
    },
    pinnedAt: new Date(pinnedAt),
  };
}

test("fetch_pinned_messages follows hasMore with the oldest pinnedAt as the cursor", async () => {
  const start = Date.parse("2026-09-01T00:00:00Z");
  const first = Array.from({ length: 50 }, (_, i) => fakePin(i, start - i * 60_000));
  const second = Array.from({ length: 3 }, (_, i) => fakePin(50 + i, start - (50 + i) * 60_000));
  const calls: Record<string, unknown>[] = [];
  stubChannel({
    messages: {
      fetchPins: async (options: Record<string, unknown>) => {
        calls.push(options);
        return calls.length === 1
          ? { items: first, hasMore: true }
          : { items: second, hasMore: false };
      },
    },
  });
  const result = await handler("discord_fetch_pinned_messages")({ channel_id: CHANNEL });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].before, undefined, "the first page starts at the newest pin");
  assert.equal(
    (calls[1].before as Date).toISOString(),
    first.at(-1)!.pinnedAt.toISOString(),
    "the next page starts before the oldest pin received",
  );
  assert.equal(calls[0].limit, 50);
  assert.equal(calls[0].cache, false);
  const { messages: pins } = result.structuredContent as { messages: { id: string }[] };
  assert.equal(pins.length, 53, "every page is returned");
  assert.equal(pins[0].id, first[0].message.id);
  assert.equal(pins.at(-1)!.id, second.at(-1)!.message.id);
});

test("fetch_pinned_messages stops when the cursor does not advance", async () => {
  const page = [fakePin(1, Date.parse("2026-09-01T00:00:00Z"))];
  let calls = 0;
  stubChannel({
    messages: {
      fetchPins: async () => {
        calls++;
        return { items: page, hasMore: true };
      },
    },
  });
  await handler("discord_fetch_pinned_messages")({ channel_id: CHANNEL });
  assert.equal(calls, 2, "a repeated page must end the walk instead of looping");
});
