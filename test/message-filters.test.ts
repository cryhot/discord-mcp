import { test } from "node:test";
import assert from "node:assert/strict";
import { HAS_TYPES, HAS_VALUES, hasField } from "../src/messageFilters.js";

test("every has type can also be given negated, and nothing else is accepted", () => {
  assert.equal(HAS_VALUES.length, HAS_TYPES.length * 2);
  for (const type of HAS_TYPES) {
    assert.ok(hasField.safeParse([type]).success, type);
    assert.ok(hasField.safeParse([`-${type}`]).success, `-${type}`);
  }
  assert.ok(!hasField.safeParse(["gif"]).success);
  assert.ok(!hasField.safeParse([]).success, "an empty list filters nothing");
});
