import assert from "node:assert/strict";
import test from "node:test";

import { importControlSpec } from "../lib/control-spec-import.ts";

test("control spec import preserves hidden performance profiles without changing source text", () => {
  const sourceText = "我。";
  const imported = importControlSpec({
    performance_profile: {
      delivery_mode: "lyrical_recitation",
      emotion_tone: ["温暖", "克制"],
      continuity: "connected",
      voice_quality: "slightly_breathy",
      focus_style: "soft",
      expression_amplitude: "medium",
      avoid: ["避免喊叫"],
    },
    tokens: [
      {
        index: 0,
        char: "我",
        machine_pinyin: "wo3",
        display_pinyin: "wǒ",
        start_ms: 0,
        end_ms: 180,
      },
      { index: 1, char: "。", start_ms: 180, end_ms: 180 },
    ],
    sentences: [{
      text: sourceText,
      start_index: 0,
      end_index: 1,
      rhythm: { type: "relaxed" },
      performance_profile: {
        emotion_tone: ["思索"],
        continuity: "connected",
        voice_quality: "breathy_to_supported",
        focus_style: "breathy_to_supported",
        expression_amplitude: "low",
      },
      focus: [{
        focus_span: { start: 0, end: 0 },
        focus_core: { start: 0, end: 0 },
        focus_style: "breathy_to_supported",
        confidence: 0.9,
      }],
      pauses: [],
      prolongations: [],
      prosody: [],
      ending_intonation: { type: "level", strength: 1 },
      confidence: 0.8,
    }],
  }, sourceText, "work-test");

  assert.equal(imported.tokens.map((token) => token.char).join(""), sourceText);
  assert.equal(imported.performanceProfile?.voiceQuality, "slightly_breathy");
  assert.deepEqual(imported.performanceProfile?.emotionTone, ["温暖", "克制"]);
  assert.equal(imported.sentences[0].performanceProfile?.focusStyle, "breathy_to_supported");
  assert.deepEqual(imported.sentences[0].voiceQuality, {
    start: "breathy",
    transition: "breathy_to_supported",
    end: "solid",
  });
  assert.equal(imported.sentences[0].focus[0].preferredRealization, "combined");
});
