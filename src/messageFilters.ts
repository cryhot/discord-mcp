import {
  DiscordAPIError,
  MessageReferenceType,
  type APIEmbed,
  type Guild,
  type Message,
} from "discord.js";
import { z } from "zod";
import { messageTexts, textSourceOfMessage } from "./messageText.js";
import { snowflake } from "./tools/define.js";

/**
 * Discord search `has` filters (MessageSearchHasType): each can be negated with a
 * leading '-' to exclude messages that have it.
 */
export const HAS_TYPES = [
  "link",
  "embed",
  "file",
  "image",
  "video",
  "sound",
  "sticker",
  "poll",
  "snapshot",
] as const;

export type HasType = (typeof HAS_TYPES)[number];

/** Every `has` value Discord's search accepts: the types, and each of them negated. */
export const HAS_VALUES = [...HAS_TYPES, ...HAS_TYPES.map((type) => `-${type}` as const)] as const;

export const HAS_DESCRIPTION =
  "Filter by what messages contain: link, embed, file, image, video, sound, sticker, poll, or snapshot (a forwarded message). Prefix a value with '-' to exclude messages that have it, e.g. ['image', '-link'].";

/** The `has` parameter of the message searches. */
export const hasField = z
  .array(z.enum(HAS_VALUES))
  .min(1)
  .max(HAS_VALUES.length)
  .optional()
  .describe(HAS_DESCRIPTION);

type HasValue = (typeof HAS_VALUES)[number];

/** Who wrote a message, as Discord's search tells them apart: a webhook is not a bot. */
export const AUTHOR_TYPES = ["user", "bot", "webhook"] as const;

export type AuthorType = (typeof AUTHOR_TYPES)[number];

/** Every `author_type` value Discord's search accepts: the types, and each of them negated. */
export const AUTHOR_TYPE_VALUES = [
  ...AUTHOR_TYPES,
  ...AUTHOR_TYPES.map((type) => `-${type}` as const),
] as const;

type AuthorTypeValue = (typeof AUTHOR_TYPE_VALUES)[number];

/** A single value, or a list of them. */
export const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item).min(1).max(50)]);

export const toList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The `pinned` filter, which each tool words for itself. */
export const pinnedField = (note: string) =>
  z
    .boolean()
    .optional()
    .describe(`true: only pinned messages. false: only messages that are not pinned. ${note}`);

/** The filters on the words of a message. */
export const textFilterShape = {
  keyword: oneOrMany(z.string().min(1).max(1024))
    .optional()
    .describe(
      "Case-insensitive text to look for. Several keywords keep messages that contain any of them. Looks at the content, at the text of embeds the author wrote (not link previews), at polls and at forwarded messages.",
    ),
  regex: oneOrMany(z.string().min(1).max(500))
    .optional()
    .describe(
      "JavaScript regular expression, case-insensitive, matched against the same text as keyword. Several keep messages that match any of them. Avoid patterns with nested repetition such as (a+)+: a pathological one blocks the server.",
    ),
};

/**
 * The other filters, in the order a reader goes through them: who wrote the message, what it
 * contains, who it mentions, what it replies to, whether it is pinned. Discord's search applies
 * all of them, so they go with its query; the channel searches apply them here. Each tool words
 * `pinned` for itself, hence the note.
 */
export const propertyFilterShape = (pinnedNote: string) => ({
  author_id: oneOrMany(snowflake)
    .optional()
    .describe("Only messages written by this user ID, or by any of these."),
  role_id: oneOrMany(snowflake)
    .optional()
    .describe(
      "Only messages whose author currently has this role ID, or any of these. Authors who left the server never match.",
    ),
  author_type: oneOrMany(z.enum(AUTHOR_TYPE_VALUES))
    .optional()
    .describe(
      "Only messages written by this type of author: user, bot or webhook. Prefix a value with '-' to exclude it, e.g. '-bot'. Several plain values keep messages written by any of them; every value with '-' must hold as well.",
    ),
  has: oneOrMany(z.enum(HAS_VALUES))
    .optional()
    .describe(
      `${HAS_DESCRIPTION} Several plain values keep messages that have any of them; every value with '-' must hold as well.`,
    ),
  attachment_filename: oneOrMany(z.string().min(1).max(1024))
    .optional()
    .describe(
      "Only messages with an attachment whose filename is this text, or any of these. discord_search_guild_messages gives it to Discord, which matches the whole filename, case-sensitively (Fruit.png, not fruit or fruit.png); the channel searches match any part of the filename, ignoring case.",
    ),
  attachment_extension: oneOrMany(z.string().min(1).max(256))
    .optional()
    .describe(
      "Only messages with an attachment of this file extension (pdf or .pdf, ignoring case), or of any of these.",
    ),
  mentions: oneOrMany(snowflake)
    .optional()
    .describe("Only messages that mention this user ID, or any of these."),
  mentions_role_id: oneOrMany(snowflake)
    .optional()
    .describe("Only messages that mention this role ID, or any of these."),
  mention_everyone: z
    .boolean()
    .optional()
    .describe(
      "true: only messages that mention @everyone or @here. false: only messages that do not.",
    ),
  replied_to_user_id: oneOrMany(snowflake)
    .optional()
    .describe("Only replies to a message written by this user ID, or by any of these."),
  replied_to_message_id: oneOrMany(snowflake)
    .optional()
    .describe("Only replies to this message ID, or to any of these."),
  pinned: pinnedField(pinnedNote),
});

/** Every filter of the message searches, as zod fields to spread into a schema. */
export const messageFilterShape = (pinnedNote: string) => ({
  ...textFilterShape,
  ...propertyFilterShape(pinnedNote),
});

export interface MessageFilterArgs {
  keyword?: string | string[] | undefined;
  regex?: string | string[] | undefined;
  author_id?: string | string[] | undefined;
  role_id?: string | string[] | undefined;
  author_type?: AuthorTypeValue | AuthorTypeValue[] | undefined;
  has?: HasValue | HasValue[] | undefined;
  attachment_filename?: string | string[] | undefined;
  attachment_extension?: string | string[] | undefined;
  mentions?: string | string[] | undefined;
  mentions_role_id?: string | string[] | undefined;
  mention_everyone?: boolean | undefined;
  replied_to_user_id?: string | string[] | undefined;
  replied_to_message_id?: string | string[] | undefined;
  pinned?: boolean | undefined;
}

/** The filters Discord's search applies, which go in its query instead of being checked here. */
export type NativeFilterArgs = Omit<MessageFilterArgs, "keyword" | "regex" | "role_id">;

/** The file extension as Discord writes it: no dot, lowercase. */
const normalizeExtension = (extension: string) => extension.replace(/^\./, "").toLowerCase();

/** Writes the filters Discord's search applies as query parameters. */
export function appendNativeFilters(params: URLSearchParams, args: NativeFilterArgs): void {
  const each = (name: string, values: Iterable<string>) => {
    for (const value of values) params.append(name, value);
  };
  each("author_id", toList(args.author_id));
  each("author_type", toList(args.author_type));
  each("has", toList(args.has));
  each("attachment_filename", toList(args.attachment_filename));
  each("attachment_extension", toList(args.attachment_extension).map(normalizeExtension));
  each("mentions", toList(args.mentions));
  each("mentions_role_id", toList(args.mentions_role_id));
  if (args.mention_everyone !== undefined)
    params.set("mention_everyone", String(args.mention_everyone));
  each("replied_to_user_id", toList(args.replied_to_user_id));
  each("replied_to_message_id", toList(args.replied_to_message_id));
  if (args.pinned !== undefined) params.set("pinned", String(args.pinned));
}

/** Splits values that can be negated with a leading '-' into those wanted and those unwanted. */
function splitNegated<T extends string>(values: string[]): { wanted: Set<T>; unwanted: Set<T> } {
  return {
    wanted: new Set(values.filter((value) => !value.startsWith("-")) as T[]),
    unwanted: new Set(
      values.filter((value) => value.startsWith("-")).map((value) => value.slice(1)) as T[],
    ),
  };
}

/** What a filter reads from a message, whether it came from the gateway or from the REST API. */
export interface FilterTarget {
  authorId: string;
  authorType: AuthorType;
  /** Everything the author wrote, one string per part. */
  texts: string[];
  has: ReadonlySet<HasType>;
  pinned: boolean;
  mentionedUserIds: ReadonlySet<string>;
  mentionedRoleIds: ReadonlySet<string>;
  mentionsEveryone: boolean;
  /** The message and the author this message replies to, when it is a reply. */
  repliedToMessageId: string | undefined;
  repliedToUserId: string | undefined;
  attachmentNames: readonly string[];
}

export class MessageFilter {
  private readonly keywords: string[];
  private readonly regexes: RegExp[];
  private readonly authors: Set<string>;
  private readonly roles: Set<string>;
  private readonly wanted: Set<HasType>;
  private readonly unwanted: Set<HasType>;
  private readonly pinned: boolean | undefined;
  private readonly mentions: Set<string>;
  private readonly mentionedRoles: Set<string>;
  private readonly mentionsEveryone: boolean | undefined;
  private readonly repliedToUsers: Set<string>;
  private readonly repliedToMessages: Set<string>;
  private readonly filenames: string[];
  private readonly extensions: string[];
  private readonly wantedAuthorTypes: Set<AuthorType>;
  private readonly unwantedAuthorTypes: Set<AuthorType>;

  constructor(args: MessageFilterArgs) {
    this.keywords = toList(args.keyword).map((keyword) => keyword.toLowerCase());
    this.regexes = toList(args.regex).map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch (error) {
        throw new Error(
          `Invalid regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
    });
    this.authors = new Set(toList(args.author_id));
    this.roles = new Set(toList(args.role_id));
    ({ wanted: this.wanted, unwanted: this.unwanted } = splitNegated<HasType>(toList(args.has)));
    this.pinned = args.pinned;
    this.mentions = new Set(toList(args.mentions));
    this.mentionedRoles = new Set(toList(args.mentions_role_id));
    this.mentionsEveryone = args.mention_everyone;
    this.repliedToUsers = new Set(toList(args.replied_to_user_id));
    this.repliedToMessages = new Set(toList(args.replied_to_message_id));
    this.filenames = toList(args.attachment_filename).map((name) => name.toLowerCase());
    this.extensions = toList(args.attachment_extension).map(normalizeExtension);
    ({ wanted: this.wantedAuthorTypes, unwanted: this.unwantedAuthorTypes } =
      splitNegated<AuthorType>(toList(args.author_type)));
  }

  /** Whether the role filter needs the author's roles, which cost a lookup. */
  get needsRoles(): boolean {
    return this.roles.size > 0;
  }

  /** Whether any filter was given. */
  get isEmpty(): boolean {
    return (
      this.keywords.length === 0 &&
      this.regexes.length === 0 &&
      this.authors.size === 0 &&
      this.roles.size === 0 &&
      this.wanted.size === 0 &&
      this.unwanted.size === 0 &&
      this.pinned === undefined &&
      this.mentions.size === 0 &&
      this.mentionedRoles.size === 0 &&
      this.mentionsEveryone === undefined &&
      this.repliedToUsers.size === 0 &&
      this.repliedToMessages.size === 0 &&
      this.filenames.length === 0 &&
      this.extensions.length === 0 &&
      this.wantedAuthorTypes.size === 0 &&
      this.unwantedAuthorTypes.size === 0
    );
  }

  /** Every filter but the role one, which needs {@link hasRole}. */
  matches(target: FilterTarget): boolean {
    if (this.isEmpty) return true;
    if (this.authors.size > 0 && !this.authors.has(target.authorId)) return false;
    if (!this.matchesMetadata(target)) return false;
    if (this.wanted.size > 0 && ![...this.wanted].some((type) => target.has.has(type)))
      return false;
    if ([...this.unwanted].some((type) => target.has.has(type))) return false;
    if (
      this.keywords.length > 0 &&
      !target.texts.some((text) => {
        const lower = text.toLowerCase();
        return this.keywords.some((keyword) => lower.includes(keyword));
      })
    )
      return false;
    if (
      this.regexes.length > 0 &&
      !target.texts.some((text) => this.regexes.some((regex) => regex.test(text)))
    )
      return false;
    return true;
  }

  /** The filters on the author's type, on mentions and replies, on attachments and on pinning. */
  private matchesMetadata(target: FilterTarget): boolean {
    // A filter reads its field of the target only when it was given, as the fields can cost.
    const hasAny = (wanted: ReadonlySet<string>, held: Iterable<string>) =>
      [...held].some((id) => wanted.has(id));
    if (this.pinned !== undefined && target.pinned !== this.pinned) return false;
    if (this.mentionsEveryone !== undefined && target.mentionsEveryone !== this.mentionsEveryone)
      return false;
    if (this.wantedAuthorTypes.size > 0 && !this.wantedAuthorTypes.has(target.authorType))
      return false;
    if (this.unwantedAuthorTypes.size > 0 && this.unwantedAuthorTypes.has(target.authorType))
      return false;
    if (this.mentions.size > 0 && !hasAny(this.mentions, target.mentionedUserIds)) return false;
    if (this.mentionedRoles.size > 0 && !hasAny(this.mentionedRoles, target.mentionedRoleIds))
      return false;
    if (this.repliedToUsers.size > 0) {
      const user = target.repliedToUserId;
      if (user === undefined || !this.repliedToUsers.has(user)) return false;
    }
    if (this.repliedToMessages.size > 0) {
      const message = target.repliedToMessageId;
      if (message === undefined || !this.repliedToMessages.has(message)) return false;
    }
    if (this.filenames.length > 0 || this.extensions.length > 0) {
      const names = target.attachmentNames.map((name) => name.toLowerCase());
      if (
        this.filenames.length > 0 &&
        !names.some((name) => this.filenames.some((filename) => name.includes(filename)))
      )
        return false;
      if (
        this.extensions.length > 0 &&
        !names.some((name) => this.extensions.some((extension) => name.endsWith(`.${extension}`)))
      )
        return false;
    }
    return true;
  }

  /** The role filter, against the roles the author holds (null when they are not in the server). */
  hasRole(roleIds: ReadonlySet<string> | null): boolean {
    return (
      this.roles.size === 0 || (roleIds !== null && [...this.roles].some((id) => roleIds.has(id)))
    );
  }
}

/** Looks up what roles authors hold, once per author. */
export class RoleLookup {
  private readonly cache = new Map<string, ReadonlySet<string> | null>();

  constructor(private readonly guild: Guild) {}

  /** The author's role ids, or null when they are not in the server any more. */
  async rolesOf(userId: string): Promise<ReadonlySet<string> | null> {
    if (this.cache.has(userId)) return this.cache.get(userId) ?? null;
    let roles: ReadonlySet<string> | null;
    try {
      const member = await this.guild.members.fetch(userId);
      roles = new Set(member.roles.cache.keys());
    } catch (error) {
      // 10007: Unknown Member, the author is gone.
      if (!(error instanceof DiscordAPIError && error.code === 10007)) throw error;
      roles = null;
    }
    this.cache.set(userId, roles);
    return roles;
  }
}

const URL_PATTERN = /https?:\/\/\S+/i;

interface AttachmentLike {
  contentType: string | null | undefined;
}

/** What Discord's `has:` finds in attachments and embeds, shared by both sources. */
function hasTypes(parts: {
  content: string;
  attachments: AttachmentLike[];
  embeds: APIEmbed[];
  stickers: number;
  poll: boolean;
  snapshots: number;
}): Set<HasType> {
  const has = new Set<HasType>();
  const kind = (prefix: string) =>
    parts.attachments.some((attachment) => attachment.contentType?.startsWith(prefix));
  if (URL_PATTERN.test(parts.content)) has.add("link");
  if (parts.embeds.length > 0) has.add("embed");
  if (parts.attachments.length > 0) has.add("file");
  if (kind("image/") || parts.embeds.some((e) => e.type === "image" || e.image)) has.add("image");
  if (kind("video/") || parts.embeds.some((e) => e.type === "video" || e.type === "gifv"))
    has.add("video");
  if (kind("audio/")) has.add("sound");
  if (parts.stickers > 0) has.add("sticker");
  if (parts.poll) has.add("poll");
  if (parts.snapshots > 0) has.add("snapshot");
  return has;
}

const isText = (text: string | null | undefined): text is string =>
  typeof text === "string" && text !== "";

/** The filter's view of a discord.js message. */
export function targetOfMessage(m: Message): FilterTarget {
  const poll = m.poll;
  const reply = m.reference?.type === MessageReferenceType.Default ? m.reference : undefined;
  return {
    authorId: m.author.id,
    texts: [
      ...messageTexts(textSourceOfMessage(m)),
      ...(poll ? [poll.question.text, ...[...poll.answers.values()].map((a) => a.text)] : []),
    ].filter(isText),
    has: hasTypes({
      content: m.content,
      attachments: [...m.attachments.values()],
      embeds: m.embeds.map((embed) => embed.data),
      stickers: m.stickers.size,
      poll: poll !== null,
      snapshots: m.messageSnapshots.size,
    }),
    // Read when a filter asks for them, so a search without them never touches these fields.
    get authorType() {
      return authorTypeOf(m.webhookId, m.author.bot);
    },
    get pinned() {
      return m.pinned;
    },
    get mentionedUserIds() {
      return new Set(m.mentions.users.keys());
    },
    get mentionedRoleIds() {
      return new Set(m.mentions.roles.keys());
    },
    get mentionsEveryone() {
      return m.mentions.everyone;
    },
    get repliedToMessageId() {
      return reply?.messageId;
    },
    get repliedToUserId() {
      return reply === undefined ? undefined : m.mentions.repliedUser?.id;
    },
    get attachmentNames() {
      return [...m.attachments.values()].map((attachment) => attachment.name);
    },
  };
}

/** A webhook's messages come from a bot user too, but Discord's search tells them apart. */
function authorTypeOf(webhookId: string | null | undefined, bot: boolean | undefined): AuthorType {
  return webhookId ? "webhook" : bot ? "bot" : "user";
}

/** The part of a raw API message (a search hit) the filter reads. */
export interface RawFilterable {
  content: string;
  author: { id: string; bot?: boolean };
  webhook_id?: string;
  pinned?: boolean;
  mentions?: { id: string }[];
  mention_roles?: string[];
  mention_everyone?: boolean;
  message_reference?: { type?: number; message_id?: string };
  referenced_message?: { author?: { id: string } } | null;
  attachments?: { content_type?: string | null; filename?: string }[];
  embeds?: APIEmbed[];
  sticker_items?: unknown[];
  poll?: {
    question: { text?: string | null };
    answers: { poll_media: { text?: string | null } }[];
  };
  message_snapshots?: { message: { content: string; embeds?: APIEmbed[] } }[];
}

/** The filter's view of a message as the search endpoint returns it. */
export function targetOfRaw(m: RawFilterable): FilterTarget {
  const embeds = m.embeds ?? [];
  const snapshots = m.message_snapshots ?? [];
  const poll = m.poll;
  const reference = m.message_reference;
  const isReply =
    reference !== undefined &&
    (reference.type ?? MessageReferenceType.Default) === MessageReferenceType.Default;
  return {
    authorId: m.author.id,
    texts: [
      ...messageTexts({
        content: m.content,
        embeds,
        snapshots: snapshots.map((snapshot) => ({
          content: snapshot.message.content,
          embeds: snapshot.message.embeds ?? [],
        })),
      }),
      ...(poll ? [poll.question.text, ...poll.answers.map((a) => a.poll_media.text)] : []),
    ].filter(isText),
    has: hasTypes({
      content: m.content,
      attachments: (m.attachments ?? []).map((a) => ({ contentType: a.content_type })),
      embeds,
      stickers: m.sticker_items?.length ?? 0,
      poll: poll !== undefined,
      snapshots: snapshots.length,
    }),
    get authorType() {
      return authorTypeOf(m.webhook_id, m.author.bot);
    },
    get pinned() {
      return m.pinned ?? false;
    },
    get mentionedUserIds() {
      return new Set((m.mentions ?? []).map((user) => user.id));
    },
    get mentionedRoleIds() {
      return new Set(m.mention_roles ?? []);
    },
    get mentionsEveryone() {
      return m.mention_everyone ?? false;
    },
    get repliedToMessageId() {
      return isReply ? reference.message_id : undefined;
    },
    get repliedToUserId() {
      return isReply ? m.referenced_message?.author?.id : undefined;
    },
    get attachmentNames() {
      return (m.attachments ?? []).flatMap((attachment) =>
        attachment.filename === undefined ? [] : [attachment.filename],
      );
    },
  };
}
