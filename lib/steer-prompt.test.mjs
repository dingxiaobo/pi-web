import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { STEER_PREFIX, steerPromptText } = await jiti.import("./steer-prompt.ts");

test("a steer's text goes out under BTW: so the model reads a remark, not a new task", () => {
  assert.equal(STEER_PREFIX, "BTW:\n");
  assert.equal(steerPromptText("also check the tests"), "BTW:\nalso check the tests");
  assert.equal(steerPromptText("多行\n文本"), "BTW:\n多行\n文本");
  // Idempotent in effect: the user's own BTW reads once, under ours.
  assert.equal(steerPromptText("BTW: already"), "BTW:\nBTW: already");
});

test("an empty steer and a command keep their text", () => {
  // Images only: nothing to introduce.
  assert.equal(steerPromptText(""), "");
  assert.equal(steerPromptText("   "), "   ");
  // A command is read by its first character, so it is never introduced.
  assert.equal(steerPromptText("/compact"), "/compact");
  assert.equal(steerPromptText("!npm test"), "!npm test");
});

test("only a steer is prefixed: a follow-up and a plain prompt send what was typed", () => {
  const source = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  // One choke point: the shared streaming send, gated on the behavior.
  const wiring = source.match(/message: behavior === "steer" \? steerPromptText\(message\) : message,/g) ?? [];
  assert.equal(wiring.length, 1, "the prefix is applied once, at the shared send");
  // Steer and follow-up both come through it, and nothing else sends a steer.
  assert.match(source, /const handleSteer = useCallback[\s\S]{0,200}sendStreamingPrompt\(message, "steer", images\);/);
  assert.match(source, /const handleFollowUp = useCallback[\s\S]{0,200}sendStreamingPrompt\(message, "followUp", images\);/);
  assert.doesNotMatch(source, /behavior === "followUp" \? steerPromptText/);
});
