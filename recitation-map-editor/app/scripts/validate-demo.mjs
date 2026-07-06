import fs from 'node:fs';

const demo = JSON.parse(fs.readFileSync(new URL('../src/data/demo-recitation-map.json', import.meta.url), 'utf8'));
const errors = [];
if (!demo.meta?.title) errors.push('meta.title missing');
if (!Array.isArray(demo.segments) || demo.segments.length === 0) errors.push('segments missing');
for (const [segmentIndex, segment] of demo.segments.entries()) {
  if (!segment.id) errors.push(`segments[${segmentIndex}].id missing`);
  for (const [tokenIndex, token] of segment.tokens.entries()) {
    if (!token.text) errors.push(`segments[${segmentIndex}].tokens[${tokenIndex}].text missing`);
    if (!token.pinyin) errors.push(`segments[${segmentIndex}].tokens[${tokenIndex}].pinyin missing`);
  }
  for (const [pointIndex, point] of segment.prosody_curve.points.entries()) {
    if (!['low', 'mid_low', 'mid', 'mid_high', 'high'].includes(point.level)) {
      errors.push(`segments[${segmentIndex}].prosody_curve.points[${pointIndex}].level invalid`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Demo data passed basic validation.');
