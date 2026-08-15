"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { PrintGraphTrack } from "@/components/print/PrintGraphTrack";
import {
  DEFAULT_A4_PRINT_SETTINGS,
  paginateMeasuredPrintBlocks,
  safePrintFilename,
  type PrintPagePlan,
  type SentencePrintBlock,
} from "@/lib/print-layout";
import {
  RHYTHM_LABELS,
  type PrintSettings,
  type RecitationWork,
} from "@/lib/recitation-schema";
import { mapSceneAssetsToSentences } from "@/lib/visual-assets";

function paragraphIdsForSentences(work: RecitationWork) {
  const paragraphStarts: number[] = [0];
  for (let index = 0; index < work.sourceText.length; index += 1) {
    if (work.sourceText[index] === "\n") paragraphStarts.push(index + 1);
  }
  let cursor = 0;
  return work.controlSpec?.sentences.map((sentence) => {
    const found = work.sourceText.indexOf(sentence.text, cursor);
    const sourceIndex = found >= 0 ? found : cursor;
    cursor = found >= 0 ? found + sentence.text.length : cursor + sentence.text.length;
    let paragraph = 0;
    for (let index = 0; index < paragraphStarts.length; index += 1) {
      if (paragraphStarts[index] > sourceIndex) break;
      paragraph = index;
    }
    return `paragraph-${paragraph + 1}`;
  }) ?? [];
}

function usePrintBlocks(work: RecitationWork) {
  return useMemo<SentencePrintBlock[]>(() => {
    const sentences = work.controlSpec?.sentences ?? [];
    const sceneAssets = mapSceneAssetsToSentences(work.visuals, sentences);
    const paragraphIds = paragraphIdsForSentences(work);
    return sentences.map((sentence, index) => ({
      id: sentence.id,
      paragraphId: paragraphIds[index] ?? `paragraph-${index + 1}`,
      sentenceIds: [sentence.id],
      sentence,
      sceneImageUrl: sceneAssets.get(sentence.id)?.url,
    }));
  }, [work]);
}

function PrintSceneVisual({ block }: { block: SentencePrintBlock }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const showImage = Boolean(block.sceneImageUrl && block.sceneImageUrl !== failedUrl);
  return (
    <div className={`a4-scene-visual ${showImage ? "has-image" : "uses-fallback"}`}>
      {showImage && block.sceneImageUrl ? (
        // Persisted work visuals are same-origin R2 assets and are safe to rasterize for PDF.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={block.sceneImageUrl}
          alt={`${block.sentence.text}的作品插图`}
          loading="eager"
          decoding="async"
          onError={() => setFailedUrl(block.sceneImageUrl)}
        />
      ) : <span className="a4-scene-fallback" role="img" aria-label="淡墨作品插图后备背景" />}
      <b>{String(block.sentence.order).padStart(2, "0")}</b>
      <small>{RHYTHM_LABELS[block.sentence.rhythm]}</small>
    </div>
  );
}

function PrintSentenceBlock({
  block,
  measure = false,
}: {
  block: SentencePrintBlock;
  measure?: boolean;
}) {
  return (
    <section
      className="a4-print-sentence"
      data-print-block-id={measure ? undefined : block.id}
      data-print-measure-id={measure ? block.id : undefined}
      data-paragraph-id={block.paragraphId}
    >
      <PrintSceneVisual block={block} />
      <div className="a4-print-manuscript">
        <PrintGraphTrack sentence={block.sentence} />
      </div>
    </section>
  );
}

function FirstPageHeader({ work }: { work: RecitationWork }) {
  const heroUrl = work.visuals?.heroAsset?.url;
  const [failedUrl, setFailedUrl] = useState<string>();
  const showHero = Boolean(heroUrl && heroUrl !== failedUrl);
  return (
    <>
      <header className="a4-first-page-header">
        <div className="a4-title-lockup">
          <p><span aria-hidden="true" />朗诵情感图谱</p>
          <h3>{work.title}</h3>
          {work.author ? <strong>作者 · {work.author}</strong> : <strong>作品朗诵教学谱</strong>}
        </div>
        <div className={`a4-hero-visual ${showHero ? "has-image" : "uses-fallback"}`}>
          {showHero && heroUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={heroUrl}
              alt={`${work.title}的作品主视觉`}
              loading="eager"
              decoding="async"
              onError={() => setFailedUrl(heroUrl)}
            />
          ) : <span aria-hidden="true" />}
        </div>
      </header>
      <div className="a4-print-legend" aria-label="图谱符号说明">
        <span><b>红字</b> 表达焦点</span>
        <span><b>/</b> 短停</span>
        <span><b>{"///"}</b> 长停</span>
        <span><b>—</b> 拖音</span>
        <span><b>↗ ↘</b> 句尾语调</span>
        <span><i aria-hidden="true" />宏观语势</span>
      </div>
    </>
  );
}

function RunningHeader({ work }: { work: RecitationWork }) {
  return (
    <header className="a4-running-header">
      <span>{work.title}</span>
      <b>朗诵情感图谱</b>
    </header>
  );
}

function PageFooter({ work, page, total }: {
  work: RecitationWork;
  page: number;
  total: number;
}) {
  return (
    <footer className="a4-page-footer">
      <span>{work.author ? `${work.author} · ` : ""}朗诵教学资料</span>
      <b>{page} / {total}</b>
    </footer>
  );
}

function A4Page({
  work,
  plan,
  blocksById,
  total,
}: {
  work: RecitationWork;
  plan: PrintPagePlan;
  blocksById: ReadonlyMap<string, SentencePrintBlock>;
  total: number;
}) {
  const first = plan.index === 0;
  return (
    <article
      className={`a4-page ${first ? "a4-page-first" : "a4-page-continuation"}`}
      data-pdf-page={plan.index + 1}
      aria-label={`第 ${plan.index + 1} 页，共 ${total} 页`}
    >
      {first ? <FirstPageHeader work={work} /> : <RunningHeader work={work} />}
      <div className="a4-page-body">
        {plan.blockIds.map((blockId) => {
          const block = blocksById.get(blockId);
          return block ? <PrintSentenceBlock block={block} key={blockId} /> : null;
        })}
      </div>
      <PageFooter work={work} page={plan.index + 1} total={total} />
    </article>
  );
}

function contentCapacity(element: HTMLElement) {
  const styles = window.getComputedStyle(element);
  const padding = (Number.parseFloat(styles.paddingTop) || 0)
    + (Number.parseFloat(styles.paddingBottom) || 0);
  return Math.max(0, element.clientHeight - padding);
}

async function prepareImages(target: HTMLElement) {
  const images = Array.from(target.querySelectorAll("img"));
  await Promise.all(images.map(async (image) => {
    image.loading = "eager";
    if (!image.complete) {
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
        window.setTimeout(finish, 5_000);
      });
    }
    if (image.complete && image.naturalWidth > 0) {
      await image.decode?.().catch(() => undefined);
    }
  }));
}

export function A4PrintPreview({
  work,
  onOpenLongImageExport,
}: {
  work: RecitationWork;
  onOpenLongImageExport?: () => void;
}) {
  const settings: PrintSettings = { ...DEFAULT_A4_PRINT_SETTINGS, ...work.printSettings };
  const blocks = usePrintBlocks(work);
  const blocksById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const measureRootRef = useRef<HTMLDivElement>(null);
  const pageStackRef = useRef<HTMLDivElement>(null);
  const pageSignatureRef = useRef("");
  const [pages, setPages] = useState<PrintPagePlan[]>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutMessage, setLayoutMessage] = useState("正在测量正文与语势曲线…");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const workspaceStyle = {
    "--a4-margin-top": `${settings.marginTopMm}mm`,
    "--a4-margin-right": `${settings.marginRightMm}mm`,
    "--a4-margin-bottom": `${settings.marginBottomMm}mm`,
    "--a4-margin-left": `${settings.marginLeftMm}mm`,
  } as CSSProperties;

  const calculatePagination = useCallback(() => {
    const root = measureRootRef.current;
    if (!root || !blocks.length) {
      pageSignatureRef.current = "";
      setPages([]);
      return;
    }
    const firstBody = root.querySelector<HTMLElement>("[data-measure-capacity='first']");
    const continuationBody = root.querySelector<HTMLElement>("[data-measure-capacity='continuation']");
    const measuredElements = Array.from(root.querySelectorAll<HTMLElement>("[data-print-measure-id]"));
    if (!firstBody || !continuationBody || measuredElements.length !== blocks.length) return;
    const measured = measuredElements.map((element) => ({
      id: element.dataset.printMeasureId ?? "",
      heightPx: element.getBoundingClientRect().height,
    }));
    if (measured.some((block) => block.heightPx <= 0)) return;
    const styles = window.getComputedStyle(firstBody);
    const blockGapPx = Number.parseFloat(styles.rowGap || styles.gap) || 0;
    const nextPages = paginateMeasuredPrintBlocks(measured, {
      firstPageCapacityPx: contentCapacity(firstBody),
      continuationPageCapacityPx: contentCapacity(continuationBody),
      blockGapPx,
      protectSingleBlockPages: true,
    });
    const nextSignature = nextPages.map((page) => page.blockIds.join(",")).join("|");
    if (pageSignatureRef.current !== nextSignature) {
      pageSignatureRef.current = nextSignature;
      setPages(nextPages);
    }
    const oversized = nextPages.filter((page) => page.hasOversizedBlock).length;
    setLayoutMessage(oversized
      ? `已完成 ${nextPages.length} 页排版；${oversized} 个超长句需要单页容纳`
      : `已完成 ${nextPages.length} 页排版；每句与语势曲线保持同页`);
  }, [blocks]);

  useLayoutEffect(() => {
    const root = measureRootRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(calculatePagination);
      });
    };
    setLayoutMessage("正在测量正文与语势曲线…");
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-print-measure-id], [data-measure-capacity]")
      .forEach((element) => observer.observe(element));
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [blocks, calculatePagination, layoutRevision]);

  const exportPdf = async () => {
    const stack = pageStackRef.current;
    const pageElements = stack
      ? Array.from(stack.querySelectorAll<HTMLElement>("[data-pdf-page]"))
      : [];
    if (!pageElements.length || exportingPdf) return;
    setExportingPdf(true);
    setExportError(undefined);
    setLayoutMessage(`正在生成 ${pageElements.length} 页 PDF…`);
    try {
      await document.fonts?.ready;
      await prepareImages(stack!);
      const [{ toCanvas }, { jsPDF }] = await Promise.all([
        import("html-to-image"),
        import("jspdf"),
      ]);
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      for (let index = 0; index < pageElements.length; index += 1) {
        const page = pageElements[index];
        const canvas = await toCanvas(page, {
          backgroundColor: "#ffffff",
          cacheBust: true,
          pixelRatio: settings.renderDpr,
          width: page.scrollWidth,
          height: page.scrollHeight,
          filter: (node) => !(node instanceof Element)
            || node.getAttribute("data-export-exclude") !== "true",
          style: {
            boxShadow: "none",
            margin: "0",
            transform: "none",
          },
        });
        if (index > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(canvas, "PNG", 0, 0, settings.widthMm, settings.heightMm, undefined, "FAST");
        setLayoutMessage(`正在生成 PDF：${index + 1} / ${pageElements.length} 页`);
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      pdf.save(safePrintFilename(work.title, "pdf"));
      setLayoutMessage(`PDF 已生成：${pageElements.length} 页 A4`);
    } catch (error) {
      console.error("A4 PDF export failed", error);
      const message = error instanceof Error ? error.message : String(error);
      setExportError(`PDF 导出失败：${message}`);
      setLayoutMessage("PDF 导出失败，请重试");
    } finally {
      setExportingPdf(false);
    }
  };

  if (!blocks.length) {
    return (
      <section className="a4-export-workspace a4-export-empty" aria-label="A4 导出预览">
        <p className="eyebrow">导出预览</p>
        <h2>完成图谱后可生成 A4 分页版</h2>
      </section>
    );
  }

  return (
    <section className="a4-export-workspace" aria-label="A4 导出预览" style={workspaceStyle}>
      <div className="a4-export-toolbar" data-export-exclude="true">
        <div>
          <p className="eyebrow">导出预览</p>
          <h2>A4 纵向打印版</h2>
        </div>
        <div className="a4-export-meta" aria-label="打印设置">
          <span>纸张：A4</span>
          <span>方向：纵向</span>
          <span>页数：{pages.length || "计算中"}</span>
          <small aria-live="polite">{layoutMessage}</small>
        </div>
        <div className="a4-export-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLayoutRevision((revision) => revision + 1)}
            disabled={exportingPdf}
          >
            重新排版
          </button>
          {onOpenLongImageExport ? (
            <button type="button" className="secondary-button" onClick={onOpenLongImageExport} disabled={exportingPdf}>
              长图 PNG
            </button>
          ) : null}
          <button
            type="button"
            className="primary-button"
            onClick={() => void exportPdf()}
            disabled={!pages.length || exportingPdf}
          >
            {exportingPdf ? "正在导出…" : "导出 PDF"}
          </button>
        </div>
      </div>

      {exportError ? <p className="a4-export-error" role="alert">{exportError}</p> : null}

      <div className="a4-page-stack" ref={pageStackRef}>
        {pages.map((page) => (
          <A4Page
            work={work}
            plan={page}
            blocksById={blocksById}
            total={pages.length}
            key={`page-${page.index}-${page.blockIds.join("-")}`}
          />
        ))}
      </div>

      <div className="a4-measure-layer" aria-hidden="true" ref={measureRootRef}>
        <article className="a4-page a4-page-first a4-measure-page">
          <FirstPageHeader work={work} />
          <div className="a4-page-body" data-measure-capacity="first" />
          <PageFooter work={work} page={1} total={1} />
        </article>
        <article className="a4-page a4-page-continuation a4-measure-page">
          <RunningHeader work={work} />
          <div className="a4-page-body" data-measure-capacity="continuation" />
          <PageFooter work={work} page={2} total={2} />
        </article>
        <div className="a4-block-measure-list">
          {blocks.map((block) => <PrintSentenceBlock block={block} measure key={`measure-${block.id}`} />)}
        </div>
      </div>
    </section>
  );
}
