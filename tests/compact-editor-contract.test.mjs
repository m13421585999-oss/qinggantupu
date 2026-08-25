import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("compact editor is a sibling edition and keeps the full studio branch intact", async () => {
  const studio = await readFile(new URL("components/RecitationStudio.tsx", root), "utf8");
  assert.match(studio, /type StudioEdition = "full" \| "compact"/);
  assert.match(studio, /studioEdition === "full" \? \([\s\S]*?<FullA4Editor/);
  assert.match(studio, /<CompactRecitationEditor/);
  assert.match(studio, /buildCompactControlSpec\(saved\.id, saved\.sourceText\)/);
  assert.match(studio, /url\.searchParams\.set\("edition", "compact"\)/);
  assert.match(studio, /studioEdition === "full" && step === 2/);
  assert.doesNotMatch(studio, /<ViewerView\s/);
  assert.doesNotMatch(studio, /<Player\s/);
});

test("compact editor exposes formal V and v markers plus one editable node per spoken token", async () => {
  const component = await readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8");
  const track = await readFile(new URL("components/TeachingProsodyTrack.tsx", root), "utf8");
  const studio = await readFile(new URL("components/RecitationStudio.tsx", root), "utf8");
  assert.match(component, /"breath_major"/);
  assert.match(component, /"breath_minor"/);
  assert.match(component, /compact-breath-major/);
  assert.match(component, /compact-breath-minor/);
  assert.match(component, /\{breath \? \([\s\S]*?compact-spoken-token/);
  assert.match(component, /<TeachingProsodyTrack/);
  assert.match(component, /className="compact-prosody-curve"/);
  assert.match(track, /new MutationObserver\(schedule\)/);
  assert.match(track, /element\.getBoundingClientRect\(\)/);
  assert.match(component, /buildTeachingProsodyPoints/);
  assert.match(component, /forcedBoundaryIndexes: sentence\.lineBreakAfterTokenIndexes/);
  assert.match(component, /adjustVisualLineBoundaries/);
  assert.match(component, /const mergeSelectedIntoLine/);
  assert.match(component, /并入上一行/);
  assert.match(component, /并入下一行/);
  assert.match(component, /className="compact-token-pinyin"/);
  assert.match(track, /teaching-curve-node is-editable/);
  assert.match(track, /onPointerMove/);
  assert.match(track, /prosodyVisualLevelFromPointerY/);
  assert.match(component, /upsertProsodyPointOverride/);
  assert.doesNotMatch(component, /pinyinEditorOpen/);
  assert.match(component, /<div className="compact-pinyin-editor">/);
  assert.match(component, /onBlur=\{saveSelectedPinyin\}/);
  assert.match(component, /pinyinDraftDirty/);
  assert.match(component, /saveSelectedPinyin/);
  assert.match(component, /applyPinyinOverrides/);
  assert.match(component, /onPinyinOverrideChange\(selectedToken\.id, value\)/);
  assert.match(component, /work\.controlSpec\?\.pinyinOverrides/);
  assert.match(studio, /pinyinOverrides\[tokenId\] = value/);
});

test("compact marker popover supports all applied marks and isolates the Spring imagery layout", async () => {
  const [component, schema, worker, css] = await Promise.all([
    readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8"),
    readFile(new URL("lib/recitation-schema.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.match(component, /function toggleStaccato/);
  assert.match(component, />一字一顿<\/button>/);
  assert.match(component, /setSceneTechniqueAt\(sentence, token, "real"\)/);
  assert.match(component, /setSceneTechniqueAt\(sentence, token, "virtual"\)/);
  assert.match(component, /isSpringSceneTechniqueWork\(work\.title\)/);
  assert.match(component, /=== "春"/);
  assert.match(component, /springSceneTechniqueMode \? null : \(/);
  assert.match(component, /has-scene-technique-row/);
  assert.match(schema, /sceneTechniqueMarks\?: SceneTechniqueMark\[\]/);
  assert.match(worker, /const sceneTechniqueMarks = sentence\.sceneTechniqueMarks/);
  assert.match(css, /\.compact-graph-line\.is-spring-scene-technique \.compact-token-row/);
  assert.match(css, /\.compact-scene-technique-slot\.is-virtual/);
  assert.match(schema, /deliveryTechniqueMarks\?: DeliveryTechniqueMark\[\]/);
  assert.match(worker, /const deliveryTechniqueMarks = sentence\.deliveryTechniqueMarks/);
  assert.match(component, /setDeliveryTechniqueAt\(sentence, token, "virtual_voice"\)/);
  assert.match(component, /setDeliveryTechniqueAt\(sentence, token, "distant_view"\)/);
  assert.match(component, /setDeliveryTechniqueAt\(sentence, token, "close_view"\)/);
  assert.match(component, /className=\{`compact-token-char[\s\S]*?is-virtual-voice/);
  assert.match(component, /className=\{`compact-distance-marker/);
  assert.match(component, /<VirtualVoiceGroupOverlay/);
  assert.match(css, /\.recitation-virtual-voice-group/);
  assert.match(css, /\.recitation-distance-glyph\.is-distant-view[\s\S]*?scaleX\(-1\)/);
});

test("compact prosody supports cancellable intonation and five-level continuous drawing without changing Full A4", async () => {
  const [component, track, full, css] = await Promise.all([
    readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8"),
    readFile(new URL("components/TeachingProsodyTrack.tsx", root), "utf8"),
    readFile(new URL("components/FullA4Editor.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(component, /COMPACT_PROSODY_LEVELS = \[0, 2, 4, 6, 8\] as const/);
  assert.match(component, /visualLevels=\{COMPACT_PROSODY_LEVELS\}/);
  assert.match(component, /continuousDrawing/);
  assert.match(component, /function toggleEndingTone/);
  assert.match(component, /sentence\.endingIntonation\.type === type \? "level" : type/);
  assert.match(component, /toggleEndingTone\(sentence, "rising"\)/);
  assert.match(component, /toggleEndingTone\(sentence, "falling"\)/);
  assert.match(component, /aria-pressed=\{selectedSentence\.endingIntonation\.type === "rising"\}/);
  assert.match(component, /changes\.reduce\([\s\S]*?upsertProsodyPointOverride/);
  assert.match(track, /onPointerDown=\{editable && continuousDrawing/);
  assert.match(track, /onPointerMove=\{editable && continuousDrawing/);
  assert.match(track, /setPointerCapture\(event\.pointerId\)/);
  assert.match(track, /interpolateProsodyPointChanges/);
  assert.match(track, /onPointsChange\(changes\)/);
  assert.match(track, /data-prosody-level-count=\{activeVisualLevels\.length\}/);
  assert.match(css, /\.compact-prosody-curve\.is-drawable\s*\{[\s\S]*?cursor: crosshair;[\s\S]*?touch-action: none;/);
  assert.doesNotMatch(full, /continuousDrawing/);
  assert.doesNotMatch(full, /COMPACT_PROSODY_LEVELS/);
});

test("compact editor paginates measured visual lines with continuous line numbers and exports one A4 PDF", async () => {
  const component = await readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8");
  const track = await readFile(new URL("components/TeachingProsodyTrack.tsx", root), "utf8");
  const prosodyVisual = await readFile(new URL("lib/prosody-visual.ts", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(component, /data-compact-measure-id/);
  assert.match(component, /data-compact-token-indexes/);
  assert.match(component, /displayOrder: index \+ 1/);
  assert.match(component, /lineTokenIndexes=\{lineBlock\?\.tokenIndexes\}/);
  assert.match(component, /protectSingleBlockPages: false/);
  assert.match(component, /paginateMeasuredPrintBlocks\(measured/);
  assert.doesNotMatch(component, /maxBlocksPerPage:/);
  assert.doesNotMatch(component, /is-eight-row-page/);
  assert.match(component, /data-compact-pdf-page/);
  assert.match(component, /pixelRatio: COMPACT_RENDER_DPR/);
  assert.match(component, /new jsPDF\(\{[\s\S]*?unit: "mm"[\s\S]*?format: "a4"/);
  assert.match(component, /pdf\.addPage\("a4", "portrait"\)/);
  assert.match(component, /pdf\.save\(safePrintFilename\(work\.title, "pdf"\)\)/);
  assert.match(css, /\.compact-a4-page \{[\s\S]*?width: 210mm;[\s\S]*?height: 297mm;/);
  assert.match(css, /--compact-a4-margin, 8\.5mm/);
  assert.match(css, /\.compact-token-manuscript\s*\{[\s\S]*?font-size: 23\.4pt/);
  assert.match(css, /\.compact-token-pinyin\s*\{[\s\S]*?font-size: 12\.9pt/);
  assert.match(css, /\.compact-sentence-number\s*\{[\s\S]*?font-size: 7\.3pt/);
  assert.match(css, /\.compact-page-body\s*\{[\s\S]*?gap: 0\.6mm/);
  assert.match(css, /\.compact-prosody-curve,[\s\S]*?height: 11\.5mm/);
  assert.match(css, /\.compact-page-legend\s*\{[\s\S]*?font-size: 8\.25pt/);
  assert.match(css, /\.compact-pause\s*\{[\s\S]*?font-weight: 900;[\s\S]*?-webkit-text-stroke: 0\.18px currentColor/);
  assert.match(component, /replace\(\/\^《\+/);
  assert.match(component, /<strong>《\{displayTitle\}》情感图谱（\{page\}\/\{total\}）<\/strong>/);
  assert.doesNotMatch(component, /朗诵情感图谱/);
  assert.match(css, /full-a4-background\.jpg/);
  assert.match(css, /\.compact-a4-page::before/);
  assert.match(css, /\.compact-a4-page::before\s*\{[\s\S]*?inset: 4\.5mm 4\.5mm 4mm/);
  assert.match(css, /\.compact-visual-line\s*\{[\s\S]*?grid-template-columns: 24mm minmax\(0, 1fr\)/);
  assert.match(component, /mapSceneAssetsToSentences/);
  assert.match(component, /mapActiveSceneAssetsBySceneId/);
  assert.match(component, /sceneAssetsByLineId\.get\(lineBlock\.id\)/);
  assert.match(component, /className="compact-scene-thumbnail"/);
  assert.match(component, /className="compact-scene-meta"/);
  assert.doesNotMatch(component, /showMeta=\{index === 0\}/);
  assert.match(component, /\/compact-scenes\/\$\{encodeURIComponent\(work\.id\)\}\/\$\{encodeURIComponent\(lineBlock\.id\)\}\.jpg/);
  assert.match(component, /className="compact-visual-line"/);
  assert.match(component, /Array\.from\(orderLabel\)/);
  assert.match(css, /\.compact-scene-meta\s*\{[\s\S]*?top: 1\.2mm;[\s\S]*?left: 1\.2mm;[\s\S]*?width: 4\.8mm/);
  assert.match(css, /\.compact-scene-meta \.compact-sentence-number\s*\{[\s\S]*?flex-direction: column/);
  assert.match(track, /stroke=\{PROSODY_COLOR\}/);
  assert.match(prosodyVisual, /PROSODY_COLOR = "#526f82"/);
  assert.match(prosodyVisual, /PROSODY_STROKE_WIDTH = 2\.4/);
  assert.match(prosodyVisual, /PROSODY_NODE_STROKE_WIDTH = 2\.05/);
  assert.match(component, /function CompactPageLegend\(\{ items \}/);
  assert.match(component, /<CompactPageLegend items=\{legendItems\} \/>/);
  assert.match(component, /usedCompactLegendItems/);
  assert.match(component, /自动图例：\{legendItems\.length\} 项/);
  assert.doesNotMatch(component, /全部显示/);
  assert.doesNotMatch(component, /全部隐藏/);
  assert.doesNotMatch(component, /恢复默认/);
  assert.match(component, /compact-legend-focus/);
  assert.match(component, /compact-legend-arrow/);
  assert.match(component, /compact-legend-prolong/);
  assert.match(component, /compact-legend-staccato/);
  assert.match(component, /compact-legend-real-scene/);
  assert.match(component, /compact-legend-virtual-scene/);
  assert.match(component, /compact-legend-virtual-voice/);
  assert.match(component, /<DistanceViewGlyph type="distant_view"/);
  assert.match(component, /<DistanceViewGlyph type="close_view"/);
  assert.match(component, /\/红\/红/);
  assert.match(css, /\.compact-page-legend\s*\{[\s\S]*?flex-wrap: wrap;[\s\S]*?padding: 1\.25mm 49\.5mm 1mm 2\.2mm/);
  assert.match(css, /\.compact-legend-option-grid\s*\{[\s\S]*?repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.compact-page-header\s*\{[\s\S]*?align-items: baseline/);
  assert.match(css, /\.compact-page-header strong\s*\{[\s\S]*?font-size: 15pt;[\s\S]*?font-weight: 800/);
  assert.match(component, /COMPACT_WATERMARKS\.map/);
  assert.match(component, /className="compact-logo-footer"/);
  assert.match(component, /src="\/full-logo\.jpeg"/);
  assert.match(css, /\.compact-watermark\s*\{[\s\S]*?rotate\(-42deg\)[\s\S]*?font-size: 17pt/);
  assert.match(css, /\.compact-logo-footer\s*\{[\s\S]*?width: 48mm;[\s\S]*?height: 18mm/);
});

test("legacy compact legend settings remain storage-compatible without replacing the full edition", async () => {
  const [studio, schema, worker] = await Promise.all([
    readFile(new URL("components/RecitationStudio.tsx", root), "utf8"),
    readFile(new URL("lib/recitation-schema.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
  ]);
  assert.match(schema, /compactLegendItems\?: CompactLegendItemId\[\]/);
  assert.match(studio, /const \[printSettingsDirty, setPrintSettingsDirty\]/);
  assert.match(studio, /const updateCompactLegendItems/);
  assert.match(studio, /onLegendItemsChange=\{updateCompactLegendItems\}/);
  assert.match(studio, /\|\| printSettingsDirty/);
  assert.match(worker, /compactLegendItems: normalizeCompactLegendItems\(source\.compactLegendItems\)/);
});
