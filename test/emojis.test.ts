import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Collection } from "discord.js";
import { discord } from "../src/client.js";
import discovery from "../src/tools/discovery.js";

const GUILD = "111111111111111111";

afterEach(() => mock.restoreAll());

function emoji(id: string, name: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    animated: false,
    available: true,
    managed: false,
    roles: { cache: new Map() },
    toString: () => `<:${name}:${id}>`,
    ...extra,
  };
}

function stubEmojis(...emojis: ReturnType<typeof emoji>[]) {
  const collection = new Collection(emojis.map((e) => [e.id, e]));
  mock.method(
    discord.guilds,
    "fetch",
    async () => ({ emojis: { fetch: async () => collection } }) as never,
  );
}

test("discord_list_emojis gives the text to write and the form to react with", async () => {
  stubEmojis(
    emoji("222222222222222222", "partyparrot", {
      animated: true,
      toString: () => "<a:partyparrot:222222222222222222>",
    }),
    emoji("333333333333333333", "check", {
      roles: { cache: new Map([["444444444444444444", {}]]) },
    }),
  );
  const result = await discovery.handlers.get("discord_list_emojis")!({ guild_id: GUILD });
  const { emojis } = result.structuredContent as { emojis: Record<string, unknown>[] };
  assert.equal(emojis.length, 2);
  assert.equal(emojis[0].mention, "<a:partyparrot:222222222222222222>");
  assert.equal(emojis[0].reaction, "partyparrot:222222222222222222");
  assert.equal(emojis[0].animated, true);
  assert.deepEqual(emojis[1].roleIds, ["444444444444444444"]);
  assert.equal(emojis[1].mention, "<:check:333333333333333333>");
});

test("discord_list_emojis narrows by name, ignoring case", async () => {
  stubEmojis(emoji("222222222222222222", "PartyParrot"), emoji("333333333333333333", "check"));
  const result = await discovery.handlers.get("discord_list_emojis")!({
    guild_id: GUILD,
    name: "parrot",
  });
  const { emojis } = result.structuredContent as { emojis: { id: string }[] };
  assert.deepEqual(
    emojis.map((e) => e.id),
    ["222222222222222222"],
  );
});
