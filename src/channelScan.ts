/**
 * Walks a channel's history looking for the messages that pass a filter. Discord's channel
 * endpoint cannot filter, so the pages are fetched and filtered here: `limit` is how many
 * matches to return, `limitSearch` how many messages to look at before giving up, and the
 * result says where to resume when there is more history to look through.
 */

import type { GuildTextBasedChannel, Message } from "discord.js";
import { MAX_FETCH_LIMIT } from "./constants.js";
import { MessageFilter, RoleLookup, targetOfMessage } from "./messageFilters.js";

export interface ScanOptions {
  /** Matches to return. */
  limit: number;
  /** Messages to look at, matching or not. */
  limitSearch: number;
  /** Walk back from this message (the default is the newest). */
  before?: string | undefined;
  /** Walk forward from this message. */
  after?: string | undefined;
  /** Take the page of messages around this one, without walking any further. */
  around?: string | undefined;
}

export interface ScanResult {
  /** The matches, oldest first. */
  messages: Message[];
  /** Whether more history is left to look through. */
  hasMore: boolean;
  /** Pass this as `before` to continue a backward walk. */
  nextBefore?: string;
  /** Pass this as `after` to continue a forward walk. */
  nextAfter?: string;
}

export async function scanChannel(
  channel: GuildTextBasedChannel,
  filter: MessageFilter,
  options: ScanOptions,
): Promise<ScanResult> {
  const roles = filter.needsRoles ? new RoleLookup(channel.guild) : undefined;
  const keep = async (message: Message) =>
    (filter.isEmpty || filter.matches(targetOfMessage(message))) &&
    (roles === undefined || filter.hasRole(await roles.rolesOf(message.author.id)));
  const oldestFirst = (a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp;

  if (options.around !== undefined) {
    // Without a filter the page is the answer: `limit` messages either side of the anchor.
    // With one, look at `limitSearch` of them and keep the matches nearest to the anchor.
    const page = await channel.messages.fetch({
      limit: filter.isEmpty
        ? options.limit
        : Math.min(MAX_FETCH_LIMIT, Math.max(options.limit, options.limitSearch)),
      cache: false,
      around: options.around,
    });
    const anchor = BigInt(options.around);
    const distance = (message: Message) => {
      const gap = BigInt(message.id) - anchor;
      return gap < 0n ? -gap : gap;
    };
    const matches: Message[] = [];
    for (const message of page.values()) {
      if (await keep(message)) matches.push(message);
    }
    matches.sort((a, b) => (distance(a) < distance(b) ? -1 : distance(a) > distance(b) ? 1 : 0));
    return { messages: matches.slice(0, options.limit).sort(oldestFirst), hasMore: false };
  }

  const forward = options.after !== undefined;
  // Without a filter every message is a match: no need to look further than the limit.
  const budget = filter.isEmpty ? options.limit : Math.max(options.limitSearch, options.limit);
  let cursor = forward ? options.after : options.before;
  let scanned = 0;
  let hasMore = false;
  let last: Message | undefined;
  const matches: Message[] = [];

  walk: for (;;) {
    const size = Math.min(MAX_FETCH_LIMIT, budget - scanned);
    if (size <= 0) break;
    const page = await channel.messages.fetch({
      limit: size,
      cache: false,
      ...(forward ? { after: cursor } : { before: cursor }),
    });
    // The newest message is first, whichever way the page was asked for.
    const ordered = [...page.values()].sort((a, b) =>
      forward ? oldestFirst(a, b) : oldestFirst(b, a),
    );
    for (const [index, message] of ordered.entries()) {
      scanned += 1;
      last = message;
      if (await keep(message)) matches.push(message);
      if (matches.length >= options.limit || scanned >= budget) {
        // Stopped before the end of a page, or at the end of a full one: there may be more.
        hasMore = index < ordered.length - 1 || ordered.length === size;
        break walk;
      }
    }
    // A short page is the end of the history.
    if (ordered.length < size) break;
    cursor = ordered.at(-1)?.id;
  }

  return {
    messages: matches.sort(oldestFirst),
    hasMore,
    ...(hasMore && last ? (forward ? { nextAfter: last.id } : { nextBefore: last.id }) : {}),
  };
}
