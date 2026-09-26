import type { APIEmbed, Message } from "discord.js";
import { embedTexts } from "./embeds.js";

/** What a message says, whichever way it was received: gateway message or raw API message. */
export interface TextSource {
  content: string;
  embeds: readonly Readonly<APIEmbed>[];
  /** What a forward carries: Discord keeps the original in snapshots, the forward's own content is empty. */
  snapshots: readonly { content: string; embeds: readonly Readonly<APIEmbed>[] }[];
}

/** Everything a message says, one string per part: its content, its embeds, and what a forward carries. */
export function messageTexts(source: TextSource): string[] {
  return [
    source.content,
    ...source.embeds.flatMap(embedTexts),
    ...source.snapshots.flatMap((snapshot) => [
      snapshot.content,
      ...snapshot.embeds.flatMap(embedTexts),
    ]),
  ].filter((text) => text !== "");
}

/** What a gateway message says, as a {@link TextSource}. */
export function textSourceOfMessage(m: Message): TextSource {
  return {
    content: m.content,
    embeds: m.embeds.map((embed) => embed.data),
    snapshots: [...m.messageSnapshots.values()].map((snapshot) => ({
      content: snapshot.content,
      embeds: snapshot.embeds.map((embed) => embed.data),
    })),
  };
}
