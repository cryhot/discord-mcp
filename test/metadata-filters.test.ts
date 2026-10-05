import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discord } from "../src/client.js";
import {
  MessageFilter,
  targetOfMessage,
  targetOfRaw,
  type FilterTarget,
  type RawFilterable,
} from "../src/messageFilters.js";
import messages from "../src/tools/messages.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";
const USER_A = "900000000000000001";
const USER_B = "900000000000000002";
const ROLE_1 = "700000000000000001";
const ROLE_2 = "700000000000000002";
const BASE = 1_000_000_000_000_000_000n;

afterEach(() => mock.restoreAll());

const idOf = (i: number) => String(BASE + BigInt(i));
const run = (tool: string, args: Record<string, unknown>) => messages.handlers.get(tool)!(args);
const body = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;
const ids = (result: Record<string, unknown>, key: string) =>
  (result[key] as { id: string }[]).map((m) => m.id);

// ─── the filter, on what it reads of a message ───────────────────────────────

function target(overrides: Partial<FilterTarget> = {}): FilterTarget {
  return {
    authorId: USER_A,
    authorType: "user",
    texts: [],
    has: new Set(),
    pinned: false,
    mentionedUserIds: new Set(),
    mentionedRoleIds: new Set(),
    mentionsEveryone: false,
    repliedToMessageId: undefined,
    repliedToUserId: undefined,
    attachmentNames: [],
    ...overrides,
  };
}

test("every new filter makes a filter that is not empty", () => {
  for (const args of [
    { pinned: false },
    { mentions: USER_A },
    { mentions_role_id: ROLE_1 },
    { mention_everyone: false },
    { replied_to_user_id: USER_A },
    { replied_to_message_id: idOf(1) },
    { attachment_filename: "a" },
    { attachment_extension: "pdf" },
    { author_type: "-bot" },
  ] as const) {
    assert.equal(new MessageFilter(args).isEmpty, false, JSON.stringify(args));
  }
});

test("pinned and mention_everyone keep what is true or false, and keep both when absent", () => {
  assert.ok(new MessageFilter({ pinned: true }).matches(target({ pinned: true })));
  assert.ok(!new MessageFilter({ pinned: true }).matches(target({ pinned: false })));
  assert.ok(new MessageFilter({ pinned: false }).matches(target({ pinned: false })));
  assert.ok(!new MessageFilter({ pinned: false }).matches(target({ pinned: true })));
  const everyone = target({ mentionsEveryone: true });
  assert.ok(new MessageFilter({ mention_everyone: true }).matches(everyone));
  assert.ok(!new MessageFilter({ mention_everyone: false }).matches(everyone));
  assert.ok(new MessageFilter({ mention_everyone: false }).matches(target()));
});

test("mentions keeps a message that mentions any of the users or roles", () => {
  const message = target({
    mentionedUserIds: new Set([USER_B]),
    mentionedRoleIds: new Set([ROLE_2]),
  });
  assert.ok(new MessageFilter({ mentions: [USER_A, USER_B] }).matches(message));
  assert.ok(!new MessageFilter({ mentions: USER_A }).matches(message));
  assert.ok(new MessageFilter({ mentions_role_id: [ROLE_1, ROLE_2] }).matches(message));
  assert.ok(!new MessageFilter({ mentions_role_id: ROLE_1 }).matches(message));
  assert.ok(!new MessageFilter({ mentions: USER_A }).matches(target()), "mentions nobody");
});

test("replied_to_* keep the replies to those users or messages, and nothing else", () => {
  const reply = target({ repliedToMessageId: idOf(5), repliedToUserId: USER_B });
  assert.ok(new MessageFilter({ replied_to_user_id: [USER_A, USER_B] }).matches(reply));
  assert.ok(!new MessageFilter({ replied_to_user_id: USER_A }).matches(reply));
  assert.ok(new MessageFilter({ replied_to_message_id: idOf(5) }).matches(reply));
  assert.ok(!new MessageFilter({ replied_to_message_id: idOf(6) }).matches(reply));
  assert.ok(!new MessageFilter({ replied_to_user_id: USER_B }).matches(target()), "not a reply");
  assert.ok(!new MessageFilter({ replied_to_message_id: idOf(5) }).matches(target()));
});

test("attachment_filename matches a part of a name, attachment_extension its end, ignoring case", () => {
  const files = target({ attachmentNames: ["Budget 2027.PDF", "notes.txt"] });
  assert.ok(new MessageFilter({ attachment_filename: "budget" }).matches(files));
  assert.ok(new MessageFilter({ attachment_filename: ["zzz", "NOTES.TXT"] }).matches(files));
  assert.ok(!new MessageFilter({ attachment_filename: "report" }).matches(files));
  assert.ok(new MessageFilter({ attachment_extension: "pdf" }).matches(files));
  assert.ok(new MessageFilter({ attachment_extension: ".PDF" }).matches(files), "dot and case");
  assert.ok(new MessageFilter({ attachment_extension: ["csv", "txt"] }).matches(files));
  assert.ok(!new MessageFilter({ attachment_extension: "csv" }).matches(files));
  assert.ok(
    !new MessageFilter({ attachment_extension: "pdf" }).matches(
      target({ attachmentNames: ["a.pdf.txt"] }),
    ),
    "the extension is the last one",
  );
  assert.ok(!new MessageFilter({ attachment_extension: "pdf" }).matches(target()), "no file");
});

test("author_type keeps any wanted type and none of the unwanted ones", () => {
  const user = target({ authorType: "user" });
  const bot = target({ authorType: "bot" });
  const webhook = target({ authorType: "webhook" });
  const wanted = new MessageFilter({ author_type: ["bot", "webhook"] });
  assert.ok(!wanted.matches(user) && wanted.matches(bot) && wanted.matches(webhook));
  const unwanted = new MessageFilter({ author_type: ["-bot", "-webhook"] });
  assert.ok(unwanted.matches(user) && !unwanted.matches(bot) && !unwanted.matches(webhook));
  const mixed = new MessageFilter({ author_type: ["bot", "webhook", "-webhook"] });
  assert.ok(mixed.matches(bot) && !mixed.matches(webhook) && !mixed.matches(user));
  assert.ok(new MessageFilter({ author_type: "-bot" }).matches(user), "an exclusion alone");
});

test("a filter without the new fields never reads them", () => {
  const poisoned = new Proxy(target(), {
    get(real, key) {
      if (["pinned", "authorType", "mentionedUserIds", "attachmentNames"].includes(String(key)))
        throw new Error(`read ${String(key)}`);
      return Reflect.get(real, key);
    },
  });
  assert.ok(new MessageFilter({ author_id: USER_A }).matches(poisoned));
});

// ─── what a message gives the filter ─────────────────────────────────────────

interface Meta {
  bot?: boolean;
  webhook?: boolean;
  pinned?: boolean;
  mentions?: string[];
  roles?: string[];
  everyone?: boolean;
  /** The message this one replies to, and who wrote it. */
  replyTo?: [string, string];
  /** The same reference, as a forward. */
  forwardOf?: string;
  files?: string[];
}

function message(i: number, meta: Meta = {}) {
  const reference = meta.replyTo
    ? { type: 0, messageId: meta.replyTo[0], channelId: CHANNEL }
    : meta.forwardOf
      ? { type: 1, messageId: meta.forwardOf, channelId: CHANNEL }
      : null;
  return {
    id: idOf(i),
    createdTimestamp: i,
    createdAt: new Date(i),
    author: { id: USER_A, tag: "someone", bot: meta.bot ?? false },
    webhookId: meta.webhook ? "800000000000000001" : null,
    content: `message ${i}`,
    embeds: [],
    attachments: new Map(
      (meta.files ?? []).map((name, k) => [String(k), { name, contentType: null }]),
    ),
    stickers: new Map(),
    messageSnapshots: new Map(),
    poll: null,
    pinned: meta.pinned ?? false,
    mentions: {
      users: new Map((meta.mentions ?? []).map((id) => [id, { id }])),
      roles: new Map((meta.roles ?? []).map((id) => [id, { id }])),
      everyone: meta.everyone ?? false,
      repliedUser: meta.replyTo ? { id: meta.replyTo[1] } : null,
    },
    reference,
  };
}

test("a discord.js message gives its mentions, reply, attachments, author type and pin", () => {
  const read = targetOfMessage(
    message(1, {
      pinned: true,
      mentions: [USER_B],
      roles: [ROLE_1],
      everyone: true,
      replyTo: [idOf(7), USER_B],
      files: ["a.pdf"],
    }) as never,
  );
  assert.equal(read.pinned, true);
  assert.deepEqual([...read.mentionedUserIds], [USER_B]);
  assert.deepEqual([...read.mentionedRoleIds], [ROLE_1]);
  assert.equal(read.mentionsEveryone, true);
  assert.equal(read.repliedToMessageId, idOf(7));
  assert.equal(read.repliedToUserId, USER_B);
  assert.deepEqual(read.attachmentNames, ["a.pdf"]);
  assert.equal(read.authorType, "user");
});

test("a forward is not a reply, and a webhook is a webhook although it is also a bot", () => {
  const forward = targetOfMessage(message(1, { forwardOf: idOf(7) }) as never);
  assert.equal(forward.repliedToMessageId, undefined);
  assert.equal(forward.repliedToUserId, undefined);
  assert.equal(targetOfMessage(message(2, { bot: true }) as never).authorType, "bot");
  assert.equal(
    targetOfMessage(message(3, { bot: true, webhook: true }) as never).authorType,
    "webhook",
  );
});

test("a raw search hit gives the same fields as the discord.js message", () => {
  const raw: RawFilterable = {
    content: "hi",
    author: { id: USER_A, bot: true },
    webhook_id: "800000000000000001",
    pinned: true,
    mentions: [{ id: USER_B }],
    mention_roles: [ROLE_1],
    mention_everyone: true,
    message_reference: { type: 0, message_id: idOf(7) },
    referenced_message: { author: { id: USER_B } },
    attachments: [{ filename: "a.pdf", content_type: "application/pdf" }],
  };
  const read = targetOfRaw(raw);
  assert.equal(read.authorType, "webhook");
  assert.equal(read.pinned, true);
  assert.deepEqual([...read.mentionedUserIds], [USER_B]);
  assert.deepEqual([...read.mentionedRoleIds], [ROLE_1]);
  assert.equal(read.mentionsEveryone, true);
  assert.equal(read.repliedToMessageId, idOf(7));
  assert.equal(read.repliedToUserId, USER_B);
  assert.deepEqual(read.attachmentNames, ["a.pdf"]);
  const forward = targetOfRaw({
    content: "",
    author: { id: USER_A },
    message_reference: { type: 1, message_id: idOf(7) },
  });
  assert.equal(forward.repliedToMessageId, undefined);
  assert.equal(forward.authorType, "user");
  assert.equal(forward.pinned, false);
});

// ─── the channel search ──────────────────────────────────────────────────────

const history = [
  message(1, { mentions: [USER_B] }),
  message(2, { roles: [ROLE_1] }),
  message(3, { everyone: true }),
  message(4, { replyTo: [idOf(1), USER_B] }),
  message(5, { files: ["Budget.PDF"] }),
  message(6, { files: ["notes.txt", "data.csv"] }),
  message(7, { bot: true }),
  message(8, { bot: true, webhook: true }),
  message(9, { pinned: true, files: ["minutes.pdf"] }),
];

function stubChannel() {
  const channel = {
    name: "chan",
    guildId: GUILD,
    guild: {},
    isDMBased: () => false,
    isTextBased: () => true,
    messages: {
      fetch: async () => new Map([...history].reverse().map((m) => [m.id, m])),
      fetchPins: async () => ({
        items: history
          .filter((m) => m.pinned || m.mentions.users.size > 0)
          .map((m) => ({
            message: m,
            pinnedAt: new Date(1_000_000 - m.createdTimestamp),
          })),
        hasMore: false,
      }),
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
  return channel;
}

const searchChannel = async (args: Record<string, unknown>) =>
  ids(body(await run("discord_search_messages", { channel_id: CHANNEL, ...args })), "matches");

test("search_messages filters a channel by every new filter", async () => {
  stubChannel();
  const at = (...numbers: number[]) => numbers.map(idOf);
  assert.deepEqual(await searchChannel({ pinned: true }), at(9));
  assert.equal((await searchChannel({ pinned: false })).length, 8);
  assert.deepEqual(await searchChannel({ mentions: USER_B }), at(1));
  assert.deepEqual(await searchChannel({ mentions_role_id: [ROLE_1, ROLE_2] }), at(2));
  assert.deepEqual(await searchChannel({ mention_everyone: true }), at(3));
  assert.deepEqual(await searchChannel({ replied_to_user_id: USER_B }), at(4));
  assert.deepEqual(await searchChannel({ replied_to_message_id: idOf(1) }), at(4));
  assert.deepEqual(await searchChannel({ attachment_filename: "budget" }), at(5));
  assert.deepEqual(await searchChannel({ attachment_extension: "pdf" }), at(5, 9));
  assert.deepEqual(await searchChannel({ attachment_extension: [".csv", "TXT"] }), at(6));
  assert.deepEqual(await searchChannel({ author_type: "bot" }), at(7));
  assert.deepEqual(await searchChannel({ author_type: "webhook" }), at(8));
  assert.deepEqual(await searchChannel({ author_type: ["bot", "webhook"] }), at(7, 8));
  assert.deepEqual(
    await searchChannel({ author_type: ["-bot", "-webhook"] }),
    at(1, 2, 3, 4, 5, 6, 9),
  );
});

test("the new filters combine with each other and with the old ones", async () => {
  stubChannel();
  assert.deepEqual(
    await searchChannel({ attachment_extension: "pdf", pinned: false }),
    [5].map(idOf),
  );
  assert.deepEqual(
    await searchChannel({ attachment_extension: "pdf", keyword: "message 9" }),
    [9].map(idOf),
  );
  assert.deepEqual(await searchChannel({ author_type: "bot", pinned: true }), []);
});

// ─── the pinned messages ─────────────────────────────────────────────────────

test("fetch_pinned_messages filters the pins, and pinned=true changes nothing", async () => {
  stubChannel();
  const pins = async (args: Record<string, unknown>) =>
    ids(
      body(await run("discord_fetch_pinned_messages", { channel_id: CHANNEL, ...args })),
      "messages",
    );
  assert.deepEqual(await pins({}), [1, 9].map(idOf));
  assert.deepEqual(await pins({ pinned: true }), [1, 9].map(idOf));
  assert.deepEqual(await pins({ mentions: USER_B }), [1].map(idOf));
  assert.deepEqual(await pins({ attachment_extension: "pdf" }), [9].map(idOf));
  assert.deepEqual(await pins({ author_type: "bot" }), []);
});

test("fetch_pinned_messages with pinned=false matches nothing and does not call Discord", async () => {
  const channel = stubChannel();
  const fetchPins = mock.method(channel.messages, "fetchPins");
  const fetchChannel = discord.channels.fetch as unknown as ReturnType<typeof mock.fn>;
  const result = body(
    await run("discord_fetch_pinned_messages", { channel_id: CHANNEL, pinned: false }),
  );
  assert.deepEqual(result.messages, []);
  assert.equal(fetchPins.mock.callCount(), 0);
  assert.equal(fetchChannel.mock.callCount(), 0);
});

// ─── the search of a server, which Discord filters ───────────────────────────

function stubGuildSearch() {
  const queries: URLSearchParams[] = [];
  mock.method(discord.rest, "get", (async (_route: string, options: { query: URLSearchParams }) => {
    queries.push(options.query);
    return { total_results: 0, messages: [] };
  }) as never);
  mock.method(
    discord.guilds,
    "fetch",
    async () => ({ channels: { cache: new Map() }, members: { fetch: async () => ({}) } }) as never,
  );
  return queries;
}

test("search_guild_messages hands every new filter to Discord as query parameters", async () => {
  const queries = stubGuildSearch();
  await run("discord_search_guild_messages", {
    guild_id: GUILD,
    pinned: false,
    mentions: [USER_A, USER_B],
    mentions_role_id: ROLE_1,
    mention_everyone: true,
    replied_to_user_id: USER_B,
    replied_to_message_id: [idOf(1), idOf(2)],
    attachment_filename: "budget",
    attachment_extension: [".PDF", "csv"],
    author_type: ["bot", "-webhook"],
  });
  assert.equal(queries.length, 1);
  const query = queries[0];
  assert.equal(query.get("pinned"), "false");
  assert.deepEqual(query.getAll("mentions"), [USER_A, USER_B]);
  assert.deepEqual(query.getAll("mentions_role_id"), [ROLE_1]);
  assert.equal(query.get("mention_everyone"), "true");
  assert.deepEqual(query.getAll("replied_to_user_id"), [USER_B]);
  assert.deepEqual(query.getAll("replied_to_message_id"), [idOf(1), idOf(2)]);
  assert.deepEqual(query.getAll("attachment_filename"), ["budget"]);
  assert.deepEqual(query.getAll("attachment_extension"), ["pdf", "csv"], "no dot, lowercase");
  assert.deepEqual(query.getAll("author_type"), ["bot", "-webhook"]);
});

test("search_guild_messages sends only the filters it was given", async () => {
  const queries = stubGuildSearch();
  await run("discord_search_guild_messages", { guild_id: GUILD, keyword: "x" });
  for (const name of [
    "pinned",
    "mentions",
    "mentions_role_id",
    "mention_everyone",
    "replied_to_user_id",
    "replied_to_message_id",
    "attachment_filename",
    "attachment_extension",
    "author_type",
  ])
    assert.ok(!queries[0].has(name), name);
});

// ─── the schemas ─────────────────────────────────────────────────────────────

const NEW_FILTERS = [
  "pinned",
  "mentions",
  "mentions_role_id",
  "mention_everyone",
  "replied_to_user_id",
  "replied_to_message_id",
  "attachment_filename",
  "attachment_extension",
  "author_type",
];

/** Every filter, in the order a reader goes through them. */
const FILTER_ORDER = [
  "keyword",
  "regex",
  "author_id",
  "role_id",
  "author_type",
  "has",
  "attachment_filename",
  "attachment_extension",
  "mentions",
  "mentions_role_id",
  "mention_everyone",
  "replied_to_user_id",
  "replied_to_message_id",
  "pinned",
];

const propertiesOf = (tool: string) =>
  (
    messages.definitions.find((d) => d.name === tool)!.inputSchema as {
      required?: string[];
      properties: Record<string, { description?: string }>;
    }
  ).properties;

test("the three search tools advertise the new filters, all optional", () => {
  for (const tool of [
    "discord_search_messages",
    "discord_fetch_pinned_messages",
    "discord_search_guild_messages",
  ]) {
    const definition = messages.definitions.find((d) => d.name === tool)!;
    const schema = definition.inputSchema as { required?: string[] };
    for (const name of NEW_FILTERS) {
      assert.ok(name in propertiesOf(tool), `${tool} lacks ${name}`);
      assert.ok(!(schema.required ?? []).includes(name), `${name} must stay optional`);
    }
    assert.match(definition.description, /mention_everyone/, `${tool} names the filters`);
  }
});

test("pinned is worded for each tool", () => {
  assert.match(
    propertiesOf("discord_search_messages").pinned.description!,
    /prefer discord_fetch_pinned_messages/,
  );
  assert.match(
    propertiesOf("discord_fetch_pinned_messages").pinned.description!,
    /consistency.*false matches nothing/,
  );
  assert.match(propertiesOf("discord_search_guild_messages").pinned.description!, /Discord/);
  assert.match(
    propertiesOf("discord_search_guild_messages").attachment_filename.description!,
    /whole filename, case-sensitively/,
  );
});

test("the filters come in the same natural order in the three search tools", () => {
  for (const tool of [
    "discord_search_messages",
    "discord_fetch_pinned_messages",
    "discord_search_guild_messages",
  ]) {
    assert.deepEqual(
      Object.keys(propertiesOf(tool)).filter((name) => FILTER_ORDER.includes(name)),
      FILTER_ORDER,
      tool,
    );
  }
});
