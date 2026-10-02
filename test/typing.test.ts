import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discord } from "../src/client.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";

afterEach(() => mock.restoreAll());

test("discord_send_typing triggers the typing indicator once and posts nothing", async () => {
  let typed = 0;
  let sent = 0;
  const channel = {
    name: "chan",
    guildId: GUILD,
    isDMBased: () => false,
    isTextBased: () => true,
    sendTyping: async () => void typed++,
    send: async () => void sent++,
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
  const result = await messages.handlers.get("discord_send_typing")!({ channel_id: CHANNEL });
  assert.equal(typed, 1);
  assert.equal(sent, 0, "typing must not post a message");
  assert.match(result.content[0].text ?? "", /Typing indicator shown in #chan/);
});

test("discord_send_typing rejects a channel that cannot hold messages", async () => {
  mock.method(discord.channels, "fetch", async () => null as never);
  await assert.rejects(
    messages.handlers.get("discord_send_typing")!({ channel_id: CHANNEL }),
    /not a message-capable guild channel/,
  );
});
