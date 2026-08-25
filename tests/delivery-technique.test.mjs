import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  setDeliveryTechniqueAt,
  virtualVoiceTokenRuns,
} from "../lib/delivery-technique.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const token = {
  id: "token-0",
  index: 0,
  char: "看",
  startMs: 0,
  endMs: 0,
  confidence: 1,
};

const sentence = {
  id: "sentence-1",
  order: 1,
  text: "看",
  function: "",
  rhythm: "relaxed",
  continuity: "connected",
  prosody: [],
  endingIntonation: { type: "level", strength: 1 },
  focus: [],
  voiceQuality: { start: "neutral", end: "neutral" },
  pauses: [],
  prolongations: [],
  tokens: [token],
  teachingCue: "",
  avoid: [],
  confidence: 1,
  timeRange: { startMs: 0, endMs: 0 },
};

test("virtual voice coexists with one mutually exclusive distance mark", () => {
  const withVoice = setDeliveryTechniqueAt(sentence, token, "virtual_voice");
  const withDistant = setDeliveryTechniqueAt(withVoice, token, "distant_view");
  assert.deepEqual(
    withDistant.deliveryTechniqueMarks.map((mark) => mark.type).sort(),
    ["distant_view", "virtual_voice"],
  );

  const withClose = setDeliveryTechniqueAt(withDistant, token, "close_view");
  assert.deepEqual(
    withClose.deliveryTechniqueMarks.map((mark) => mark.type).sort(),
    ["close_view", "virtual_voice"],
  );

  const withoutClose = setDeliveryTechniqueAt(withClose, token, "close_view");
  assert.deepEqual(withoutClose.deliveryTechniqueMarks.map((mark) => mark.type), ["virtual_voice"]);

  const cleared = setDeliveryTechniqueAt(withoutClose, token, "virtual_voice");
  assert.equal(cleared.deliveryTechniqueMarks, undefined);
});

test("distance view glyph uses the compact emoji raster artwork", async () => {
  const component = await readFile(resolve(root, "components/RecitationTechniqueGlyphs.tsx"), "utf8");
  assert.match(component, /\/distant-view-emoji\.png/);
  assert.match(component, /\/close-view-emoji\.png/);
  assert.match(component, /is-distant-view/);
  await Promise.all([
    access(resolve(root, "public/distant-view-emoji.png")),
    access(resolve(root, "public/close-view-emoji.png")),
  ]);
});

test("virtual voice cue keeps a strong, readable rounded dashed frame", async () => {
  const css = await readFile(resolve(root, "app/globals.css"), "utf8");
  assert.match(css, /\.recitation-virtual-voice-group\s*\{[\s\S]*?border:\s*0\.065em dashed #a92f23;[\s\S]*?border-radius:\s*0\.28em;/);
});

test("consecutive virtual voice characters form one run without crossing gaps", () => {
  const marked = {
    ...sentence,
    tokens: [0, 1, 2, 4].map((index) => ({ ...token, id: `token-${index}`, index })),
    deliveryTechniqueMarks: [0, 1, 2, 4].map((index) => ({
      id: `mark-${index}`,
      tokenId: `token-${index}`,
      tokenIndex: index,
      type: "virtual_voice",
      source: "human",
    })),
  };
  assert.deepEqual(virtualVoiceTokenRuns(marked, [0, 1, 2, 4]), [[0, 1, 2], [4]]);
  assert.deepEqual(virtualVoiceTokenRuns(marked, [0, 1, 4]), [[0, 1], [4]]);
});

test("Chushibiao spacing leaves room between virtual-voice frames and pauses", async () => {
  const css = await readFile(resolve(root, "app/globals.css"), "utf8");
  assert.doesNotMatch(css, /\.compact-editor-workspace\.is-chushibiao-virtual-spacing \.compact-graph-track\s*\{[\s\S]*?--compact-token-gap:/);
  assert.match(css, /\.compact-editor-workspace\.is-chushibiao-virtual-spacing[\s\S]*?\.compact-token-unit:has\(\.compact-token-char\.is-virtual-voice\)\s*\{\s*margin-inline:\s*0\.08em;/);
  assert.match(css, /\.compact-token-unit:has\(\.compact-token-char\.is-virtual-voice\) \.compact-pause\s*\{\s*margin-left:\s*0\.2em;/);
  assert.match(css, /\.full-editor-workspace\.is-chushibiao-virtual-spacing \.full-pause\s*\{\s*margin-inline:\s*0\.3em;/);
});
