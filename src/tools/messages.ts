import {
  ChannelType,
  TextChannel,
  PublicThreadChannel,
  PrivateThreadChannel,
  Message,
  MessageReaction,
  type Guild,
  type MessagePin,
  type RESTGetAPIGuildMessagesSearchResult,
  Routes,
  SnowflakeUtil,
  DiscordAPIError,
} from "discord.js";
import { z } from "zod";
import { scanChannel } from "../channelScan.js";
import { discord, getTextChannel, fetchChannelChecked } from "../client.js";
import { MAX_FETCH_LIMIT, DEFAULTS, AUTO_ARCHIVE_DURATIONS } from "../constants.js";
import {
  buildEmbed,
  embedFieldsShape,
  embedArraySchema,
  embedSummary,
  summarizeEmbed,
} from "../embeds.js";
import {
  MessageFilter,
  RoleLookup,
  appendNativeFilters,
  messageFilterShape,
  oneOrMany,
  propertyFilterShape,
  textFilterShape,
  targetOfMessage,
  targetOfRaw,
  toList,
  type RawFilterable,
} from "../messageFilters.js";
import { defineModule, defineTool, snowflake, guildId, intIn, structured } from "./define.js";

const channelId = snowflake.describe("ID (snowflake) of the channel or thread.");
const messageId = snowflake.describe("ID of the message.");

/**
 * History paging cursors. Discord's `GET /channels/{id}/messages` accepts at most
 * one of `before` / `after` / `around` per request, so tools exposing them reject
 * combinations at parse time instead of letting the API answer 400.
 */
const beforeCursor = snowflake.describe(
  "Return only messages older than this message ID (snowflake). Page backwards through history by passing the id of the oldest message from the previous call.",
);
const afterCursor = snowflake.describe(
  "Return only messages newer than this message ID (snowflake). Page forwards by passing the id of the newest message from the previous call.",
);
const aroundCursor = snowflake.describe(
  "Return messages centered on this message ID (snowflake): Discord splits `limit` either side of it, and an even `limit` puts the extra message on the newer side. Use it to read outward from a known message, such as a discord_search_guild_messages hit. With filters, it looks at limit_search messages around it and keeps the `limit` matches nearest to it.",
);
const sinceInstant = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error:
      "Must be an ISO 8601 date (2026-08-01) or a date-time with an explicit offset (2026-08-01T09:00:00Z).",
  })
  .describe(
    'Return only messages posted after this instant, as an ISO 8601 date or a date-time with an explicit offset (e.g. "2026-08-01" or "2026-08-01T09:00:00Z"). Convenience form of `after`: the call yields the oldest `limit` messages after that instant, so page forwards with `after` set to the newest id received.',
  );

function hasSingleCursor(args: {
  before?: string;
  after?: string;
  around?: string;
  since?: string;
}): boolean {
  return (
    [args.before, args.after, args.around, args.since].filter((value) => value !== undefined)
      .length <= 1
  );
}

/**
 * Converts an ISO 8601 instant into the snowflake an `after` cursor expects.
 * Snowflakes embed a millisecond timestamp, so a synthetic id marks that instant
 * exactly. The instant is clamped to the Discord epoch on one side (`generate`
 * returns a negative id before it) and to now on the other (ids overflow 64 bits
 * past 2154, and nothing can be posted in the future). The schema only admits a
 * date or an offset-bearing date-time, both of which `Date.parse` reads as UTC or
 * the given offset, so the result does not depend on the server's timezone.
 */
function cursorForInstant(iso: string): string {
  const timestamp = Math.min(Math.max(Date.parse(iso), Number(SnowflakeUtil.epoch)), Date.now());
  return SnowflakeUtil.generate({ timestamp }).toString();
}

/** Bot messages often carry all their text in embeds and leave `content` empty. */
const messageSummary = z.object({
  id: z.string(),
  author: z.string(),
  content: z.string(),
  embeds: z.array(embedSummary),
  timestamp: z.string(),
});

const embedsReturned =
  "embeds (title, url, description, color, author, fields, footer, image and thumbnail urls, timestamp; bots often leave content empty and put everything here)";

const attachmentSummary = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number(),
  url: z.string(),
  proxyUrl: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  description: z.string().nullable(),
  title: z.string().nullable(),
  duration: z.number().nullable(),
  waveform: z.string().nullable(),
  spoiler: z.boolean(),
});

/**
 * Looks up a reaction on a message by emoji argument.
 * The reaction cache is keyed by the emoji id (snowflake) for custom emoji and
 * by the raw unicode char for standard emoji, NOT by the "name:id" / "<:name:id>"
 * form the tool schema accepts, so a custom emoji is normalized to its id first.
 */
function findReaction(msg: Message, emoji: string): MessageReaction | undefined {
  const customId = emoji.match(/^<a?:[^:]+:(\d{17,20})>$|^[^:]+:(\d{17,20})$/);
  const key = customId ? (customId[1] ?? customId[2]) : emoji;
  return msg.reactions.cache.get(key);
}

/** Discord's page size for `GET /channels/{id}/messages/pins`. */
const PINS_PAGE_SIZE = 50;
/** Upper bound on pin pages walked per call, so a cursor that stops advancing cannot loop forever. */
const MAX_PIN_PAGES = 20;

type GuildSearchResult = Extract<RESTGetAPIGuildMessagesSearchResult, { messages: unknown }>;

/** One request to Discord's search endpoint for a server. */
async function requestGuildSearch(
  guildId: string,
  params: URLSearchParams,
): Promise<GuildSearchResult> {
  const data = (await discord.rest.get(Routes.guildMessagesSearch(guildId), {
    query: params,
  })) as RESTGetAPIGuildMessagesSearchResult;
  // Discord answers 202 with an index-not-ready body that carries no `messages`
  // key while it builds the guild's search index.
  if (!("messages" in data))
    throw new Error(
      `Discord is still building this server's message search index. Retry in ${Math.ceil(data.retry_after ?? 5)}s.`,
    );
  return data;
}

/** Thread and forum-post hits name their channel in the response's `threads`. */
function threadNames(data: GuildSearchResult): Map<string, string> {
  return new Map((data.threads ?? []).map((t) => [t.id, t.name]));
}

/** A search hit, with the name of its channel: the thread names first, as those are rarely in the channel cache, which covers the rest. */
function searchMatch(
  m: GuildSearchResult["messages"][number][number],
  names: Map<string, string>,
  guild: Guild,
) {
  return {
    id: m.id,
    author: userTag(m.author),
    content: m.content,
    embeds: (m.embeds ?? []).map(summarizeEmbed),
    timestamp: m.timestamp,
    channel_id: m.channel_id,
    channel_name:
      names.get(m.channel_id) ?? guild.channels.cache.get(m.channel_id)?.name ?? "unknown",
  };
}

/** Mirrors discord.js `User#tag`, which raw API users lack. Both "0" and "0000" mean migrated. */
function userTag(user: { username: string; discriminator: string }): string {
  return user.discriminator === "0" || user.discriminator === "0000"
    ? user.username
    : `${user.username}#${user.discriminator}`;
}

/** Most messages one channel search may look at, so that a single call stays a few pages long. */
const MAX_SEARCH_SCAN = 1000;

/** Discord serves search results 25 at a time, and nothing past this offset. */
const MAX_SEARCH_PAGE = 25;
const MAX_SEARCH_OFFSET = 9975;

const channelMessage = messageSummary.extend({ attachments: z.number(), pinned: z.boolean() });

/** Parameters of discord_search_messages, which discord_read_messages shares. */
const channelSearchSchema = z
  .object({
    channel_id: snowflake.describe("ID (snowflake) of the channel or thread to search."),
    ...messageFilterShape(
      "To list a channel's pins, prefer discord_fetch_pinned_messages: it reads the pins directly, whereas this walks the history and only sees the messages it looks at (limit_search).",
    ),
    limit: intIn(1, MAX_FETCH_LIMIT)
      .default(DEFAULTS.MESSAGES)
      .describe(
        "Max messages to return (1–100). Default 20. Walking back, the newest matches are kept; walking forward (after, since), the oldest.",
      ),
    limit_search: intIn(1, MAX_SEARCH_SCAN)
      .default(MAX_FETCH_LIMIT)
      .describe(
        "Max messages to look at, matching or not (1–1000). Default 100. Raise it to search deeper into history: it is read 100 at a time, so a high value means several calls to Discord. Ignored when it is below limit.",
      ),
    before: beforeCursor.optional(),
    after: afterCursor.optional(),
    around: aroundCursor.optional(),
    since: sinceInstant.optional(),
  })
  .refine(
    hasSingleCursor,
    "Pass at most one of before, after, around, or since: Discord treats before/after/around as mutually exclusive, and since is a form of after.",
  );

const channelSearchPaging = {
  hasMore: z
    .boolean()
    .describe(
      "Whether more history is left to look through after the messages that were looked at.",
    ),
  nextBefore: z.string().optional().describe("Pass as before to carry on walking back."),
  nextAfter: z.string().optional().describe("Pass as after to carry on walking forward."),
};

async function searchChannel(args: z.infer<typeof channelSearchSchema>) {
  const channel = await getTextChannel(args.channel_id);
  const after = args.after ?? (args.since === undefined ? undefined : cursorForInstant(args.since));
  const { messages, hasMore, nextBefore, nextAfter } = await scanChannel(
    channel,
    new MessageFilter(args),
    {
      limit: args.limit,
      limitSearch: args.limit_search,
      before: args.before,
      after,
      around: args.around,
    },
  );
  return {
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author.tag,
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      embeds: m.embeds.map((e) => summarizeEmbed(e.data)),
      attachments: m.attachments.size,
      pinned: m.pinned,
    })),
    hasMore,
    ...(nextBefore ? { nextBefore } : {}),
    ...(nextAfter ? { nextAfter } : {}),
  };
}

/** What the filters of the search tools do, said once. */
const FILTERS_DOC =
  "Filters (keyword, regex, author_id, role_id, author_type, has, attachment_filename, attachment_extension, mentions, mentions_role_id, mention_everyone, replied_to_user_id, replied_to_message_id, pinned) take one value or a list, except pinned and mention_everyone, which are true or false: a message is kept when it passes every filter given, and, within one filter, when it matches any of its values. Text filters read what the author wrote: the content, embeds they wrote (not link previews), polls and forwarded messages, but not the message a reply answers.";

/** Fields every message of a search result carries. */
const MESSAGE_FIELDS_DOC = `Each message has id, author, content, ${embedsReturned}, timestamp, attachments (count) and pinned.`;

/** Tool definitions for channel and thread messages. */
const tools = [
  defineTool({
    name: "discord_read_messages",
    description:
      "Deprecated: an alias for discord_search_messages, which takes the same parameters and does the same, plus the filters. Reads messages from a text channel or thread, oldest-to-newest. Page backwards by re-calling with before set to nextBefore (or the id of the oldest message received). Requires the View Channel and Read Message History permissions. Returns { messages: [...], hasMore }. " +
      MESSAGE_FIELDS_DOC,
    annotations: { title: "Read messages (deprecated)", readOnlyHint: true, openWorldHint: true },
    schema: channelSearchSchema,
    outputSchema: z.object({ messages: z.array(channelMessage), ...channelSearchPaging }),
    handle: async (args) => structured(await searchChannel(args)),
  }),
  defineTool({
    name: "discord_send_message",
    description:
      "Send a plain-text message to a channel or thread. For rich content (title, color, fields, images) use discord_send_embed; to attach a reply reference to an existing message use discord_reply_message. Requires the bot to have the Send Messages permission. Returns the new message ID.",
    annotations: {
      title: "Send message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe("ID (snowflake) of the target channel or thread."),
      content: z.string().describe("Plain-text body of the message (max 2000 characters)."),
    }),
    handle: async ({ channel_id, content }) => {
      const channel = await getTextChannel(channel_id);
      const sent = await channel.send(content);
      return {
        content: [{ type: "text", text: `✅ Message sent (id: ${sent.id}) in #${channel.name}.` }],
      };
    },
  }),
  defineTool({
    name: "discord_reply_message",
    description:
      "Reply to a specific message, attaching a reply reference so clients show it as a threaded reply. Use discord_send_message for a standalone message with no reference. Requires the Send Messages permission. Returns the new reply's message ID.",
    annotations: {
      title: "Reply to message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message to reply to."),
      content: z.string().describe("Plain-text body of the reply (max 2000 characters)."),
    }),
    handle: async ({ channel_id, message_id, content }) => {
      const channel = await getTextChannel(channel_id);
      const target = await channel.messages.fetch({ message: message_id, cache: false });
      const sent = await target.reply(content);
      return {
        content: [
          {
            type: "text",
            text: `✅ Reply sent (id: ${sent.id}) to message ${message_id} in #${channel.name}.`,
          },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_edit_message",
    description:
      "Edit the text content of a message previously sent by this bot. Discord forbids editing other users' messages, so this fails for non-bot messages. Use discord_edit_embed for embed messages. Works in text channels and threads. Returns the edited message ID.",
    annotations: {
      title: "Edit message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe(
        "ID of the message to edit. Must be a message authored by this bot.",
      ),
      content: z
        .string()
        .describe(
          "New plain-text content that fully replaces the existing content (max 2000 characters).",
        ),
    }),
    handle: async ({ channel_id, message_id, content }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      if (msg.author.id !== discord.user?.id)
        throw new Error("Can only edit messages sent by the bot.");
      const edited = await msg.edit(content);
      return {
        content: [{ type: "text", text: `✅ Message ${edited.id} edited in #${channel.name}.` }],
      };
    },
  }),
  defineTool({
    name: "discord_add_reaction",
    description:
      "Add a single emoji reaction to a message as the bot. Requires the Add Reactions and Read Message History permissions. Use discord_remove_reactions to undo. Idempotent: re-adding the bot's existing reaction has no effect.",
    annotations: {
      title: "Add reaction",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message to react to."),
      emoji: z
        .string()
        .describe("Unicode emoji (e.g. '👍') or a custom emoji in 'name:id' format."),
    }),
    handle: async ({ channel_id, message_id, emoji }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      await msg.react(emoji);
      return {
        content: [
          {
            type: "text",
            text: `✅ Reacted with ${emoji} to message ${msg.id} in #${channel.name}.`,
          },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_create_thread",
    description:
      "Create a thread, either branching from an existing message (pass message_id) or as a standalone thread in a text channel (omit message_id). Standalone creation requires a parent text channel and fails if channel_id is itself a thread. Requires the Create Public Threads permission. Returns the new thread's ID.",
    annotations: {
      title: "Create thread",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe(
        "ID (snowflake) of the parent text channel. For a message-based thread, the channel containing message_id.",
      ),
      name: z.string().describe("Name of the thread to create (max 100 characters)."),
      message_id: snowflake
        .optional()
        .describe(
          "Optional. Message to branch the thread from. If omitted, a standalone thread is created in the channel.",
        ),
      auto_archive_duration: z
        .literal([...AUTO_ARCHIVE_DURATIONS])
        .default(1440)
        .describe(
          "Minutes of inactivity before auto-archiving: 60, 1440, 4320, or 10080. Default 1440 (24h).",
        ),
    }),
    handle: async ({ channel_id, name, message_id, auto_archive_duration }) => {
      const channel = await getTextChannel(channel_id);
      const duration = auto_archive_duration;
      if (message_id) {
        const msg = await channel.messages.fetch({ message: message_id, cache: false });
        const thread = await msg.startThread({ name, autoArchiveDuration: duration });
        return {
          content: [
            {
              type: "text",
              text: `✅ Thread "${thread.name}" created from message (id: ${thread.id}).`,
            },
          ],
        };
      }
      if (!(channel instanceof TextChannel)) {
        throw new Error(
          `Standalone thread creation requires a parent TextChannel; ${channel_id} is itself a thread. Pass a message_id to start a thread from a message instead.`,
        );
      }
      const thread = await channel.threads.create({
        name,
        autoArchiveDuration: duration,
        type: ChannelType.PublicThread,
      });
      return {
        content: [{ type: "text", text: `✅ Thread "${thread.name}" created (id: ${thread.id}).` }],
      };
    },
  }),
  defineTool({
    name: "discord_bulk_delete_messages",
    description:
      "Permanently delete multiple recent messages in one call. IRREVERSIBLE. SAFE BY DEFAULT: dry_run is true unless explicitly set to false, so call it first to preview, then re-call with dry_run:false to actually delete. Discord only allows bulk-deleting messages younger than 14 days; older ones are skipped. Requires the Manage Messages permission. Returns the number deleted.",
    annotations: {
      title: "Bulk delete messages",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe(
        "ID (snowflake) of the channel or thread to delete messages from.",
      ),
      count: intIn(2, MAX_FETCH_LIMIT).describe("Number of recent messages to delete (2–100)."),
      dry_run: z
        .boolean()
        .default(true)
        .describe(
          "If true (default), only reports how many would be deleted without deleting. Set false to actually delete.",
        ),
    }),
    handle: async ({ channel_id, count, dry_run }) => {
      const channel = await getTextChannel(channel_id);
      if (dry_run) {
        const recent = await channel.messages.fetch({ limit: count, cache: false });
        const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const deletable = recent.filter((m) => m.createdTimestamp > cutoff).size;
        return {
          content: [
            {
              type: "text",
              text: `🔍 Dry run: ${deletable} of the ${recent.size} most recent messages in #${channel.name} would be deleted (${recent.size - deletable} older than 14 days are skipped). Re-call with dry_run:false to delete.`,
            },
          ],
        };
      }
      const deleted = await channel.bulkDelete(count, true);
      return {
        content: [
          { type: "text", text: `✅ Deleted ${deleted.size} messages in #${channel.name}.` },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_send_embed",
    description:
      "Send a single rich embed (title, description, color, fields, author, footer, images, timestamp). Use discord_send_message for plain text, or discord_send_multiple_embeds to send several embeds at once. Requires the Send Messages and Embed Links permissions. Returns the new message ID.",
    annotations: {
      title: "Send embed",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe("ID (snowflake) of the target channel or thread."),
      ...embedFieldsShape,
    }),
    handle: async ({ channel_id, ...embedArgs }) => {
      const channel = await getTextChannel(channel_id);
      const sent = await channel.send({ embeds: [buildEmbed(embedArgs)] });
      return {
        content: [{ type: "text", text: `✅ Embed sent (id: ${sent.id}) in #${channel.name}.` }],
      };
    },
  }),
  defineTool({
    name: "discord_edit_embed",
    description:
      "Replace the embed on a message previously sent by this bot. Only this bot's messages can be edited. This is a full replace, not a merge: provided fields are applied and omitted fields are dropped from the embed. Returns a confirmation.",
    annotations: {
      title: "Edit embed",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe(
        "ID of the message to edit. Must be a message authored by this bot (an embed is added if it has none).",
      ),
      ...embedFieldsShape,
    }),
    handle: async ({ channel_id, message_id, ...embedArgs }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      if (msg.author.id !== discord.user?.id)
        throw new Error("Can only edit embeds sent by the bot.");
      await msg.edit({ embeds: [buildEmbed(embedArgs)] });
      return {
        content: [
          { type: "text", text: `✅ Embed edited on message ${message_id} in #${channel.name}.` },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_send_multiple_embeds",
    description:
      "Send up to 10 embeds in a single message, with optional text above them. Use discord_send_embed for a single embed. Requires the Send Messages and Embed Links permissions. Returns the new message ID.",
    annotations: {
      title: "Send multiple embeds",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe("ID (snowflake) of the target channel or thread."),
      content: z.string().optional().describe("Optional plain text shown above the embeds."),
      embeds: embedArraySchema.describe("Array of embed objects to send (max 10)."),
    }),
    handle: async ({ channel_id, content, embeds }) => {
      const channel = await getTextChannel(channel_id);
      const built = embeds.map((e) => buildEmbed(e));
      const sent = await channel.send({ content: content || undefined, embeds: built });
      return {
        content: [
          {
            type: "text",
            text: `✅ ${built.length} embeds sent (id: ${sent.id}) in #${channel.name}.`,
          },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_delete_message",
    description:
      "Permanently delete one specific message. IRREVERSIBLE. The bot can always delete its own messages; deleting another user's message requires the Manage Messages permission. Use discord_bulk_delete_messages to remove many at once. An optional reason is recorded in the audit log.",
    annotations: {
      title: "Delete message",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message to delete."),
      reason: z.string().optional().describe("Optional reason recorded in the server audit log."),
    }),
    handle: async ({ channel_id, message_id, reason }) => {
      const channel = await getTextChannel(channel_id);
      await channel.messages.fetch({ message: message_id, cache: false });
      // msg.delete() cannot carry an audit-log reason; the raw REST call sets X-Audit-Log-Reason.
      await discord.rest.delete(Routes.channelMessage(channel.id, message_id), { reason });
      return { content: [{ type: "text", text: `✅ Message ${message_id} deleted.` }] };
    },
  }),
  defineTool({
    name: "discord_pin_message",
    description:
      "Pin or unpin a message in a channel, controlled by the pin flag. Requires the Pin Messages permission (a dedicated permission since early 2026, separate from Manage Messages). A channel holds at most 50 pins. Idempotent: pinning an already-pinned message (or unpinning an unpinned one) has no additional effect.",
    annotations: {
      title: "Pin or unpin message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message to pin or unpin."),
      pin: z.boolean().describe("true to pin the message, false to unpin it."),
    }),
    handle: async ({ channel_id, message_id, pin }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      if (pin) {
        await msg.pin();
      } else {
        await msg.unpin();
      }
      return { content: [{ type: "text", text: `✅ Message ${pin ? "pinned" : "unpinned"}.` }] };
    },
  }),
  defineTool({
    name: "discord_search_messages",
    description:
      "Read and search the messages of a text channel or thread. With no filter it reads the latest messages; with filters it walks the history and keeps those that match. " +
      FILTERS_DOC +
      " It looks at limit_search messages (100 by default) and returns up to limit matches, oldest-to-newest. When hasMore is true, carry on with before set to nextBefore (or after set to nextAfter when walking forward with after or since). For a whole server at once, with Discord's own index and no depth limit, use discord_search_guild_messages. Requires the View Channel and Read Message History permissions (and, for role_id, access to the server's members). Returns { matches: [...], hasMore }. " +
      MESSAGE_FIELDS_DOC,
    annotations: { title: "Search messages", readOnlyHint: true, openWorldHint: true },
    schema: channelSearchSchema,
    outputSchema: z.object({ matches: z.array(channelMessage), ...channelSearchPaging }),
    handle: async (args) => {
      const { messages, ...paging } = await searchChannel(args);
      return structured({ matches: messages, ...paging });
    },
  }),
  defineTool({
    name: "discord_search_guild_messages",
    description:
      "Search a server's messages with Discord's native search index, across every channel and thread the bot can read, with no limit on how far back it looks. Age-restricted (NSFW) channels are excluded unless include_nsfw is true. " +
      FILTERS_DOC +
      " Differences with discord_search_messages: keyword is a single text (Discord's index takes one) and also matches embed text; channel_id is accepted here; every filter but regex and role_id is applied by Discord, whereas regex and role_id are applied here to what Discord returned. limit is how many messages to return (1–100, fetched 25 at a time); limit_search only matters with regex or role_id, and is how many of Discord's results to look at, since a result that does not pass them is dropped. total_results is Discord's count before regex and role_id. When hasMore is true, carry on with offset set to nextOffset: Discord caps offset at 9975, so narrow the search with min_id and max_id to go past the first 10000 hits. Returns { total_results, matches: [...], hasMore }, each match also carrying channel_id and channel_name. " +
      MESSAGE_FIELDS_DOC +
      " Requires READ_MESSAGE_HISTORY. Use discord_search_messages to search one channel.",
    annotations: { title: "Search guild messages", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      guild_id: guildId,
      channel_id: oneOrMany(snowflake)
        .optional()
        .describe("Only this channel or thread ID, or any of these."),
      keyword: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe(
          "Text to search for (case-insensitive, max 1024 characters). One keyword only. Optional when another filter such as has, author_id, or channel_id narrows the search.",
        ),
      query: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe("Deprecated: the former name of keyword."),
      regex: textFilterShape.regex,
      ...propertyFilterShape("Applied by Discord."),
      min_id: snowflake
        .optional()
        .describe("Only messages newer than this message ID (snowflake)."),
      max_id: snowflake
        .optional()
        .describe("Only messages older than this message ID (snowflake)."),
      sort_order: z
        .enum(["desc", "asc"])
        .optional()
        .describe("Time order of the results: desc (Discord's default, newest first) or asc."),
      include_nsfw: z
        .boolean()
        .default(false)
        .describe(
          "Include results from age-restricted (NSFW) channels. Default false, which is Discord's default too.",
        ),
      offset: intIn(0, 9975)
        .optional()
        .describe(
          "Number of results to skip, for paging (0-9975). Discord caps it at 9975, so narrow the search with min_id/max_id to reach hits past the first 10000. Use nextOffset from the previous call.",
        ),
      limit: intIn(1, MAX_FETCH_LIMIT)
        .default(25)
        .describe("Max messages to return (1–100). Default 25."),
      limit_search: intIn(1, MAX_SEARCH_SCAN)
        .default(MAX_FETCH_LIMIT)
        .describe(
          "Max results of Discord to look at when regex or role_id drop some (1–1000). Default 100. Ignored without them, and when it is below limit.",
        ),
    }),
    outputSchema: z.object({
      total_results: z.number(),
      matches: z.array(
        messageSummary.extend({
          channel_id: z.string(),
          channel_name: z.string(),
        }),
      ),
      hasMore: z.boolean().describe("Whether Discord has results left after the ones looked at."),
      nextOffset: z.number().optional().describe("Pass as offset to carry on."),
    }),
    handle: async (args) => {
      const { guild_id, query, channel_id, min_id, max_id } = args;
      if (args.keyword !== undefined && query !== undefined && args.keyword !== query)
        throw new Error("Pass keyword, not both keyword and its former name query.");
      const keyword = args.keyword ?? query;
      const params = new URLSearchParams({ limit: String(args.limit) });
      if (keyword !== undefined) params.set("content", keyword);
      for (const id of toList(channel_id)) params.append("channel_id", id);
      appendNativeFilters(params, args);
      if (min_id) params.set("min_id", min_id);
      if (max_id) params.set("max_id", max_id);
      if (args.sort_order) params.set("sort_order", args.sort_order);
      if (args.include_nsfw) params.set("include_nsfw", "true");
      if (args.offset !== undefined) params.set("offset", String(args.offset));

      // Discord applies every filter but regex and role_id, which are applied
      // here, so a result that does not pass them is dropped and more are looked at.
      const local = new MessageFilter({ regex: args.regex, role_id: args.role_id });
      const guild = await discord.guilds.fetch(guild_id);
      const roles = local.needsRoles ? new RoleLookup(guild) : undefined;
      const budget = local.isEmpty ? args.limit : Math.max(args.limit_search, args.limit);
      const names = new Map<string, string>();
      const matches: ReturnType<typeof searchMatch>[] = [];
      let offset = args.offset ?? 0;
      let total: number;
      let looked = 0;
      walk: for (;;) {
        const size = Math.min(MAX_SEARCH_PAGE, budget - looked);
        const page = new URLSearchParams(params);
        page.set("limit", String(size));
        if (offset > 0) page.set("offset", String(offset));
        const data = await requestGuildSearch(guild_id, page);
        total = data.total_results;
        for (const [id, name] of threadNames(data)) names.set(id, name);
        const hits = data.messages.flat();
        for (const m of hits) {
          looked += 1;
          offset += 1;
          const passes =
            (local.isEmpty || local.matches(targetOfRaw(m as RawFilterable))) &&
            (roles === undefined || local.hasRole(await roles.rolesOf(m.author.id)));
          if (passes) matches.push(searchMatch(m, names, guild));
          if (matches.length >= args.limit || looked >= budget) break walk;
        }
        // A short page, or the last offset Discord serves, is the end.
        if (hits.length < size || offset > MAX_SEARCH_OFFSET) break;
      }

      const hasMore = offset < total && offset <= MAX_SEARCH_OFFSET;
      return structured({
        total_results: total,
        matches,
        hasMore,
        ...(hasMore ? { nextOffset: offset } : {}),
      });
    },
  }),
  defineTool({
    name: "discord_crosspost_message",
    description:
      "Publish (crosspost) a message from an Announcement channel to every server that follows it. Only works in announcement channels on a message that has not already been published. Requires the Send Messages permission (and Manage Messages for messages authored by others). Returns a confirmation.",
    annotations: {
      title: "Crosspost message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe(
        "ID (snowflake) of the announcement channel containing the message.",
      ),
      message_id: messageId.describe("ID of the message to publish to followers."),
    }),
    handle: async ({ channel_id, message_id }) => {
      const channel = await fetchChannelChecked(channel_id);
      if (!channel || channel.type !== ChannelType.GuildAnnouncement)
        throw new Error(
          "Channel is not an announcement channel; only announcement-channel messages can be published.",
        );
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      try {
        await msg.crosspost();
      } catch (err) {
        // 40033 = already crossposted: treat as success so the tool is truly idempotent.
        if (err instanceof DiscordAPIError && Number(err.code) === 40033) {
          return {
            content: [{ type: "text", text: `✅ Message ${message_id} was already published.` }],
          };
        }
        throw err;
      }
      return {
        content: [
          {
            type: "text",
            text: `✅ Message ${msg.id} published to all followers of #${channel.name}.`,
          },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_remove_reactions",
    description:
      "Remove reactions from a message. With no emoji: removes ALL reactions. With emoji only: removes every reaction of that emoji. With emoji and user_id: removes that one user's reaction. Removing all reactions or another user's reaction requires the Manage Messages permission. Use discord_add_reaction to add.",
    annotations: {
      title: "Remove reactions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message to remove reactions from."),
      emoji: z
        .string()
        .optional()
        .describe(
          "Unicode emoji or custom emoji 'name:id'. Omit to remove ALL reactions on the message.",
        ),
      user_id: snowflake
        .optional()
        .describe(
          "Remove only this user's reaction for the given emoji. Requires emoji to be set.",
        ),
    }),
    handle: async ({ channel_id, message_id, emoji, user_id }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      if (!emoji) {
        await msg.reactions.removeAll();
        return {
          content: [{ type: "text", text: `✅ All reactions removed from message ${msg.id}.` }],
        };
      }
      const reaction = findReaction(msg, emoji);
      if (!reaction)
        throw new Error(`No reaction found for emoji "${emoji}" on message ${msg.id}.`);
      if (user_id) {
        await reaction.users.remove(user_id);
        return {
          content: [
            {
              type: "text",
              text: `✅ Removed ${emoji} reaction from user ${user_id} on message ${msg.id}.`,
            },
          ],
        };
      }
      await reaction.remove();
      return {
        content: [
          { type: "text", text: `✅ All ${emoji} reactions removed from message ${msg.id}.` },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_get_reactions",
    description:
      "List the users who reacted to a message with a specific emoji. Returns { reactions: [...] } with id, username, bot flag. Read-only.",
    annotations: { title: "Get reactions", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message to inspect."),
      emoji: z.string().describe("Unicode emoji or custom emoji 'name:id' to list reactors for."),
      limit: intIn(1, MAX_FETCH_LIMIT)
        .default(DEFAULTS.LIMIT)
        .describe("Max users to return (1–100). Default 25."),
    }),
    outputSchema: z.object({
      reactions: z.array(
        z.object({
          id: z.string(),
          username: z.string(),
          bot: z.boolean(),
        }),
      ),
    }),
    handle: async ({ channel_id, message_id, emoji, limit }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      const reaction = findReaction(msg, emoji);
      if (!reaction)
        throw new Error(`No reaction found for emoji "${emoji}" on message ${msg.id}.`);
      const users = await reaction.users.fetch({ limit });
      const result = [...users.values()].map((u) => ({
        id: u.id,
        username: u.username,
        bot: u.bot,
      }));
      return structured({ reactions: result });
    },
  }),
  defineTool({
    name: "discord_get_message_attachments",
    description:
      "List the file attachments of a message. Returns { attachments: [...] } with id, filename, title (the original name when Discord strips non-ASCII from filename), url, proxyUrl, contentType, size in bytes, width, height, alt-text description, voice-message duration and waveform, spoiler flag. Discord signs CDN urls with a 24-hour expiry and does not re-sign on every fetch; re-call this tool if a stored url has expired. Requires the View Channel and Read Message History permissions. Read-only. Use discord_read_messages to find messages with attachments.",
    annotations: { title: "Get message attachments", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the message.",
      ),
      message_id: messageId.describe("ID of the message whose attachments to list."),
    }),
    outputSchema: z.object({ attachments: z.array(attachmentSummary) }),
    handle: async ({ channel_id, message_id }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      const attachments = [...msg.attachments.values()].map((a) => ({
        id: a.id,
        filename: a.name,
        contentType: a.contentType,
        size: a.size,
        url: a.url,
        proxyUrl: a.proxyURL,
        width: a.width,
        height: a.height,
        description: a.description,
        title: a.title,
        duration: a.duration,
        waveform: a.waveform,
        spoiler: a.spoiler,
      }));
      return structured({ attachments });
    },
  }),
  defineTool({
    name: "discord_fetch_pinned_messages",
    description: `List all pinned messages in a channel, most recently pinned first, following Discord's 50-per-request pin pages (up to 1000 pins). They are all read first, then filtered. ${FILTERS_DOC} Returns { messages: [...] } with id, author, content, ${embedsReturned}, timestamp, pinnedAt. Read-only. Use discord_pin_message to change which messages are pinned.`,
    annotations: { title: "Fetch pinned messages", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      channel_id: snowflake.describe("ID (snowflake) of the channel or thread to list pins from."),
      ...messageFilterShape(
        "Accepted for consistency with the other searches: every message here is pinned, so true changes nothing, and false matches nothing, so no message is returned and Discord is not called.",
      ),
    }),
    outputSchema: z.object({
      messages: z.array(messageSummary.extend({ pinnedAt: z.string() })),
    }),
    handle: async (args) => {
      if (args.pinned === false) return structured({ messages: [] });
      const channel = await getTextChannel(args.channel_id);
      // Every pin is pinned: the filter has nothing to check there.
      const filter = new MessageFilter({ ...args, pinned: undefined });
      const roles = filter.needsRoles ? new RoleLookup(channel.guild) : undefined;
      // The pins endpoint pages at 50, newest pin first: walk back by pin time while it has more.
      const pins: MessagePin<true>[] = [];
      let before: Date | undefined;
      for (let page = 0; page < MAX_PIN_PAGES; page++) {
        const { items, hasMore } = await channel.messages.fetchPins({
          before,
          limit: PINS_PAGE_SIZE,
          cache: false,
        });
        pins.push(...items);
        const oldest = items.at(-1)?.pinnedAt;
        if (!hasMore || !oldest || oldest.getTime() === before?.getTime()) break;
        before = oldest;
      }
      const result = [];
      for (const { message: m, pinnedAt } of pins) {
        if (!filter.isEmpty && !filter.matches(targetOfMessage(m))) continue;
        if (roles && !filter.hasRole(await roles.rolesOf(m.author.id))) continue;
        result.push({
          id: m.id,
          author: m.author.tag,
          content: m.content,
          embeds: m.embeds.map((e) => summarizeEmbed(e.data)),
          timestamp: m.createdAt.toISOString(),
          pinnedAt: pinnedAt.toISOString(),
        });
      }
      return structured({ messages: result });
    },
  }),
  defineTool({
    name: "discord_forward_message",
    description:
      "Forward an existing message to another channel using Discord's native forward, which preserves the original attribution. Works across text channels and threads. Use discord_send_message to compose new content instead. Requires the Send Messages permission in the target channel. Returns a confirmation.",
    annotations: {
      title: "Forward message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: channelId.describe(
        "ID (snowflake) of the channel or thread containing the source message.",
      ),
      message_id: messageId.describe("ID of the message to forward."),
      target_channel_id: snowflake.describe("ID (snowflake) of the destination channel or thread."),
    }),
    handle: async ({ channel_id, message_id, target_channel_id }) => {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch({ message: message_id, cache: false });
      const targetChannel = await getTextChannel(target_channel_id);
      // ThreadChannel<boolean> is the abstract base for PublicThreadChannel / PrivateThreadChannel;
      // any runtime instance is one of them, but the type narrowing can't be expressed without a cast.
      await msg.forward(
        targetChannel as TextChannel | PublicThreadChannel<boolean> | PrivateThreadChannel,
      );
      return {
        content: [
          { type: "text", text: `✅ Message ${msg.id} forwarded to #${targetChannel.name}.` },
        ],
      };
    },
  }),
];

export default defineModule(tools);
