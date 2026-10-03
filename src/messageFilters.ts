import { DiscordAPIError, type APIEmbed, type Guild, type Message } from "discord.js";
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

/** A single value, or a list of them. */
export const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item).min(1).max(50)]);

export const toList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The filters every message-search tool accepts, as zod fields to spread into a schema. */
export const messageFilterShape = {
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
  author_id: oneOrMany(snowflake)
    .optional()
    .describe("Only messages written by this user ID, or by any of these."),
  role_id: oneOrMany(snowflake)
    .optional()
    .describe(
      "Only messages whose author currently has this role ID, or any of these. Authors who left the server never match.",
    ),
  has: oneOrMany(z.enum(HAS_VALUES))
    .optional()
    .describe(
      `${HAS_DESCRIPTION} Several plain values keep messages that have any of them; every value with '-' must hold as well.`,
    ),
};

export interface MessageFilterArgs {
  keyword?: string | string[] | undefined;
  regex?: string | string[] | undefined;
  author_id?: string | string[] | undefined;
  role_id?: string | string[] | undefined;
  has?: HasValue | HasValue[] | undefined;
}

/** What a filter reads from a message, whether it came from the gateway or from the REST API. */
export interface FilterTarget {
  authorId: string;
  /** Everything the author wrote, one string per part. */
  texts: string[];
  has: ReadonlySet<HasType>;
}

export class MessageFilter {
  private readonly keywords: string[];
  private readonly regexes: RegExp[];
  private readonly authors: Set<string>;
  private readonly roles: Set<string>;
  private readonly wanted: Set<HasType>;
  private readonly unwanted: Set<HasType>;

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
    const has = toList(args.has);
    this.wanted = new Set(has.filter((value) => !value.startsWith("-")) as HasType[]);
    this.unwanted = new Set(
      has.filter((value) => value.startsWith("-")).map((value) => value.slice(1)) as HasType[],
    );
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
      this.unwanted.size === 0
    );
  }

  /** Every filter but the role one, which needs {@link hasRole}. */
  matches(target: FilterTarget): boolean {
    if (this.isEmpty) return true;
    if (this.authors.size > 0 && !this.authors.has(target.authorId)) return false;
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
  };
}

/** The part of a raw API message (a search hit) the filter reads. */
export interface RawFilterable {
  content: string;
  author: { id: string };
  attachments?: { content_type?: string | null }[];
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
  };
}
