const TONE_MARKS: Record<string, readonly string[]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};

/** Convert machine pinyin such as `xiang3` or `lü4` to display pinyin. */
export function toDisplayPinyin(machinePinyin: string): string {
  const normalized = machinePinyin
    .trim()
    .toLowerCase()
    .replace(/u:/g, "ü")
    .replace(/v/g, "ü");
  const match = normalized.match(/^(.*?)([0-5])?$/);
  if (!match) return normalized;

  const syllable = match[1];
  const tone = Number(match[2] ?? 0);
  if (tone < 1 || tone > 4) return syllable;

  const vowelIndex = accentVowelIndex(syllable);
  if (vowelIndex < 0) return syllable;

  const vowel = syllable[vowelIndex];
  const marked = TONE_MARKS[vowel]?.[tone - 1];
  if (!marked) return syllable;
  return `${syllable.slice(0, vowelIndex)}${marked}${syllable.slice(vowelIndex + 1)}`;
}

function accentVowelIndex(syllable: string): number {
  const a = syllable.indexOf("a");
  if (a >= 0) return a;
  const e = syllable.indexOf("e");
  if (e >= 0) return e;
  const ou = syllable.indexOf("ou");
  if (ou >= 0) return ou;

  for (let index = syllable.length - 1; index >= 0; index -= 1) {
    if ("iouü".includes(syllable[index])) return index;
  }
  return -1;
}
