import { z } from "zod";

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
