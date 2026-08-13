"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateWorkVisualAssets,
  generateWorkVisualPlan,
  getWorkVisuals,
  regenerateVisualAsset,
  updateVisualAsset,
  updateWorkVisuals,
  uploadWorkVisualAsset,
  type HeroVisualSpec,
  type SceneVisualSpec,
  type TextValidationStatus,
  type VisualAsset,
  type VisualAssetKind,
  type WorkVisualBundle,
} from "@/lib/visual-assets";
import styles from "./WorkVisualPanel.module.css";

export interface WorkVisualPanelProps {
  workId: string;
  title: string;
  author?: string;
  disabled?: boolean;
  onNotify?: (message: string) => void;
  compact?: boolean;
  initialKind?: VisualAssetKind;
  initialSceneId?: string;
  onClose?: () => void;
  onVisualsChange?: (visuals: WorkVisualBundle) => void;
}

interface CropDraft {
  file: File;
  previewUrl: string;
  kind: VisualAssetKind;
  sceneId?: string;
  zoom: number;
  positionX: number;
  positionY: number;
}

const emptyVisuals: WorkVisualBundle = { sceneSpecs: [], assets: [] };

function statusLabel(asset?: VisualAsset) {
  if (!asset) return "尚未生成";
  if (asset.status === "failed") return "生成失败";
  if (asset.status === "queued" || asset.status === "generating") return "正在生成";
  if (asset.status === "draft" || asset.status === "pending_generation") return "等待生成";
  if (asset.status === "needs_review") return "待人工确认";
  if (!asset.isVisible) return "已隐藏";
  return "使用中";
}

function textValidationCopy(status?: TextValidationStatus) {
  if (!status || status === "not_required") return null;
  if (status === "matched") return { label: "标题文字校验通过", tone: "ready" as const };
  if (status === "pending") return { label: "正在校验标题文字", tone: "plain" as const };
  return { label: "标题文字待人工确认", tone: "warn" as const };
}

function assetFor(assets: VisualAsset[], kind: VisualAssetKind, sceneId?: string) {
  return assets
    .filter((asset) => asset.kind === kind && (kind === "hero" || asset.sceneId === sceneId))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.version - a.version)[0];
}

function versionsFor(assets: VisualAsset[], kind: VisualAssetKind, sceneId?: string) {
  return assets
    .filter((asset) => asset.kind === kind && (kind === "hero" || asset.sceneId === sceneId))
    .sort((a, b) => b.version - a.version);
}

async function loadImage(file: File) {
  const source = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取这张图片，请更换文件后重试。"));
      image.src = source;
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

async function cropImage(draft: CropDraft) {
  const image = await loadImage(draft.file);
  const [width, height] = draft.kind === "hero" ? [1500, 420] : [768, 576];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法裁切图片。请直接上传符合比例的图片。 ");

  const baseScale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const scale = baseScale * draft.zoom;
  const scaledWidth = image.naturalWidth * scale;
  const scaledHeight = image.naturalHeight * scale;
  const x = (width - scaledWidth) * (draft.positionX / 100);
  const y = (height - scaledHeight) * (draft.positionY / 100);
  context.drawImage(image, x, y, scaledWidth, scaledHeight);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("裁切图片失败，请重试。 ");
  const stem = draft.file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${stem}-${draft.kind}.jpg`, { type: "image/jpeg" });
}

function PromptEditor({
  workId,
  kind,
  sceneId,
  spec,
  disabled,
  onUpdated,
  onError,
}: {
  workId: string;
  kind: VisualAssetKind;
  sceneId?: string;
  spec: Pick<HeroVisualSpec | SceneVisualSpec, "imagePrompt" | "negativePrompt">;
  disabled: boolean;
  onUpdated: (bundle: WorkVisualBundle) => void;
  onError: (error: unknown) => void;
}) {
  const [imagePrompt, setImagePrompt] = useState(spec.imagePrompt);
  const [negativePrompt, setNegativePrompt] = useState(spec.negativePrompt);
  const [saving, setSaving] = useState(false);

  return (
    <details className={styles.promptDetails}>
      <summary>查看或编辑图片 Prompt</summary>
      <div className={styles.promptFields}>
        <label>
          图片提示词
          <textarea value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} />
        </label>
        <label>
          负面提示词
          <textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} />
        </label>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.button}
            disabled={disabled || saving || (!imagePrompt.trim())}
            onClick={async () => {
              setSaving(true);
              try {
                onUpdated(await updateWorkVisuals(workId, {
                  action: "update_spec",
                  kind,
                  sceneId,
                  imagePrompt: imagePrompt.trim(),
                  negativePrompt: negativePrompt.trim(),
                }));
              } catch (error) {
                onError(error);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <span className={styles.busy} /> : null}
            保存为新版本
          </button>
        </div>
      </div>
    </details>
  );
}

function VersionPicker({
  versions,
  disabled,
  onActivate,
}: {
  versions: VisualAsset[];
  disabled: boolean;
  onActivate: (asset: VisualAsset) => void;
}) {
  if (versions.length < 2) return null;
  return (
    <div className={styles.versions} aria-label="图片历史版本">
      {versions.map((asset) => (
        <button
          type="button"
          key={asset.id}
          disabled={disabled || asset.isActive || !asset.url}
          className={`${styles.versionThumb} ${asset.isActive ? styles.versionThumbActive : ""}`}
          onClick={() => onActivate(asset)}
          aria-label={`设为使用版本 v${asset.version}`}
        >
          {asset.url ? <img src={asset.url} alt="" /> : <span aria-hidden="true">—</span>}
          <span>v{asset.version}</span>
        </button>
      ))}
    </div>
  );
}

function CropDialog({
  draft,
  busy,
  onChange,
  onCancel,
  onConfirm,
}: {
  draft: CropDraft;
  busy: boolean;
  onChange: (draft: CropDraft) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className={styles.cropBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onCancel();
    }}>
      <section className={styles.cropDialog} role="dialog" aria-modal="true" aria-labelledby="visual-crop-title">
        <p className={styles.eyebrow}>上传替换 · 自动保留历史版本</p>
        <h3 id="visual-crop-title">调整图片画面</h3>
        <div className={`${styles.cropFrame} ${draft.kind === "hero" ? styles.cropFrameHero : styles.cropFrameScene}`}>
          <img
            src={draft.previewUrl}
            alt="待上传图片裁切预览"
            style={{
              objectPosition: `${draft.positionX}% ${draft.positionY}%`,
              transform: `scale(${draft.zoom})`,
              transformOrigin: `${draft.positionX}% ${draft.positionY}%`,
            }}
          />
        </div>
        <div className={styles.cropControls}>
          <label className={styles.cropControl}>画面缩放
            <input type="range" min="1" max="2.2" step="0.05" value={draft.zoom} onChange={(event) => onChange({ ...draft, zoom: Number(event.target.value) })} />
          </label>
          <label className={styles.cropControl}>水平焦点
            <input type="range" min="0" max="100" value={draft.positionX} onChange={(event) => onChange({ ...draft, positionX: Number(event.target.value) })} />
          </label>
          <label className={styles.cropControl}>垂直焦点
            <input type="range" min="0" max="100" value={draft.positionY} onChange={(event) => onChange({ ...draft, positionY: Number(event.target.value) })} />
          </label>
        </div>
        <div className={styles.cropActions}>
          <button type="button" className={styles.button} onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className={styles.buttonPrimary} onClick={onConfirm} disabled={busy}>
            {busy ? <span className={styles.busy} /> : null}
            裁切并上传
          </button>
        </div>
      </section>
    </div>
  );
}

export function WorkVisualPanel({
  workId,
  title,
  author,
  disabled = false,
  onNotify,
  compact = false,
  initialKind,
  initialSceneId,
  onClose,
  onVisualsChange,
}: WorkVisualPanelProps) {
  const [loadedVisuals, setVisuals] = useState<WorkVisualBundle>(emptyVisuals);
  const [loadedWorkId, setLoadedWorkId] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [error, setError] = useState<string>();
  const [cropDraft, setCropDraft] = useState<CropDraft>();
  const cropPreviewUrlRef = useRef<string | undefined>(undefined);
  const savedWork = Boolean(workId && !workId.startsWith("draft-"));
  const loading = savedWork && loadedWorkId !== workId;
  const visuals = savedWork && loadedWorkId === workId ? loadedVisuals : emptyVisuals;

  useEffect(() => {
    if (!savedWork) return;
    let cancelled = false;
    void getWorkVisuals(workId).then((bundle) => {
      if (cancelled) return;
      setVisuals(bundle);
      setError(undefined);
      setLoadedWorkId(workId);
    }).catch((requestError: unknown) => {
      if (cancelled) return;
      setVisuals(emptyVisuals);
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      setLoadedWorkId(workId);
    });
    return () => { cancelled = true; };
  }, [savedWork, workId]);

  useEffect(() => () => {
    if (cropPreviewUrlRef.current) URL.revokeObjectURL(cropPreviewUrlRef.current);
  }, []);

  const fail = useCallback((requestError: unknown) => {
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    setError(message);
    onNotify?.(message);
  }, [onNotify]);

  const run = useCallback(async (
    key: string,
    action: () => Promise<WorkVisualBundle>,
    successMessage: string,
  ) => {
    setBusyKey(key);
    setError(undefined);
    try {
      const nextVisuals = await action();
      setVisuals(nextVisuals);
      onVisualsChange?.(nextVisuals);
      onNotify?.(successMessage);
    } catch (requestError) {
      fail(requestError);
    } finally {
      setBusyKey(undefined);
    }
  }, [fail, onNotify, onVisualsChange]);

  const generationUnavailable = visuals.provider?.configured === false;
  const hero = assetFor(visuals.assets, "hero");
  const heroVersions = versionsFor(visuals.assets, "hero");
  const profile = visuals.profile;
  const globalDisabled = disabled || Boolean(busyKey) || !savedWork;

  const beginUpload = (file: File, kind: VisualAssetKind, sceneId?: string) => {
    if (!file.type.startsWith("image/")) {
      fail(new Error("请选择 JPG、PNG 或 WebP 图片。"));
      return;
    }
    if (cropPreviewUrlRef.current) URL.revokeObjectURL(cropPreviewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    cropPreviewUrlRef.current = previewUrl;
    setCropDraft({
      file,
      kind,
      sceneId,
      previewUrl,
      zoom: 1,
      positionX: 50,
      positionY: 50,
    });
  };

  const closeCrop = () => {
    if (cropPreviewUrlRef.current) URL.revokeObjectURL(cropPreviewUrlRef.current);
    cropPreviewUrlRef.current = undefined;
    setCropDraft(undefined);
  };

  const uploadLabel = (kind: VisualAssetKind, sceneId?: string) => (
    <label className={styles.uploadButton}>
      上传替换 / 裁切
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={globalDisabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) beginUpload(file, kind, sceneId);
        }}
      />
    </label>
  );

  if (loading) {
    return compact ? (
      <div className={styles.compactBackdrop} role="presentation">
        <section className={styles.compactSheet} role="dialog" aria-modal="true" aria-label="正在读取图片">
          <div className={styles.empty}>正在读取作品视觉…</div>
        </section>
      </div>
    ) : <section className={styles.panel}><div className={styles.empty}>正在读取作品视觉…</div></section>;
  }

  if (compact) {
    const compactKind = initialKind ?? (initialSceneId ? "scene" : "hero");
    const compactScene = compactKind === "scene"
      ? visuals.sceneSpecs.find((scene) => scene.sceneId === initialSceneId
        || scene.sourceSentenceIds.includes(initialSceneId ?? ""))
      : undefined;
    const compactAsset = compactKind === "hero"
      ? hero
      : compactScene
        ? assetFor(visuals.assets, "scene", compactScene.sceneId)
        : undefined;
    const compactVersions = compactKind === "hero"
      ? heroVersions
      : versionsFor(visuals.assets, "scene", compactScene?.sceneId);
    const compactKey = compactKind === "hero" ? "hero" : `scene-${compactScene?.sceneId ?? "missing"}`;
    const compactSpec = compactKind === "hero" ? visuals.heroSpec : compactScene;

    return (
      <div className={styles.compactBackdrop} role="presentation" onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose?.();
      }}>
        <section className={styles.compactSheet} role="dialog" aria-modal="true" aria-labelledby="compact-visual-title">
          <div className={styles.compactHeading}>
            <div>
              <p className={styles.eyebrow}>图片编辑</p>
              <h2 id="compact-visual-title">{compactKind === "hero" ? "作品主视觉" : "本句意境图"}</h2>
            </div>
            <button type="button" className={styles.compactClose} onClick={onClose} aria-label="关闭图片编辑">×</button>
          </div>

          {!savedWork ? <div className={styles.notice}>请先保存作品，再上传视觉资产。</div> : null}
          {generationUnavailable ? <div className={styles.notice}>图片生成服务尚未配置，仍可上传替换图片。</div> : null}
          {error ? <div className={styles.error} role="alert">{error}</div> : null}
          <div className={`${styles.compactPreview} ${compactKind === "hero" ? styles.compactPreviewHero : ""}`}>
            {compactAsset?.url ? (
              <img src={compactAsset.url} alt={compactKind === "hero" ? `${title || "作品"}主视觉` : "本句意境图"} />
            ) : (
              <div className={styles.placeholder}>
                <strong>{compactKind === "hero" ? title || "作品主视觉" : "本句意境图"}</strong>
                <small>{compactKind === "hero" ? `${author || "作者"} · 1500 × 420` : "4:3"}</small>
              </div>
            )}
          </div>

          {compactScene ? <p className={styles.sourceText}>{compactScene.sourceText}</p> : null}
          <div className={styles.compactStatusRow}>
            <span className={compactAsset?.status === "ready" && compactAsset.isVisible ? styles.statusReady : styles.status}>{statusLabel(compactAsset)}</span>
            {compactAsset ? <span className={styles.status}>v{compactAsset.version}</span> : null}
          </div>

          {!compactSpec ? (
            <div className={styles.compactSetup}>
              <strong>{compactKind === "hero" ? "先生成作品视觉方案" : "先为全文建立 Scene Unit"}</strong>
              <p>
                {compactKind === "hero"
                  ? "AI 生图需要先阅读全文，确定全篇统一风格与 Hero 构图。你也可以跳过 AI 生图，直接上传自己的主视觉。"
                  : "系统需要先阅读全文并找到这句话所属的场景。方案完成后，才可生成或上传本句意境图。"}
              </p>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={globalDisabled}
                  onClick={() => void run("plan", () => generateWorkVisualPlan(workId), "作品视觉方案已生成，可以继续制作图片")}
                >
                  {busyKey === "plan" ? <span className={styles.busy} /> : null}
                  先生成视觉方案
                </button>
                {compactKind === "hero" ? uploadLabel("hero") : null}
                {compactAsset ? (
                  <button
                    type="button"
                    className={styles.buttonQuiet}
                    disabled={globalDisabled}
                    onClick={() => void run(
                      `${compactKey}-visible`,
                      () => updateVisualAsset(compactAsset.id, compactAsset.isVisible ? "hide" : "show"),
                      compactAsset.isVisible ? "图片已隐藏" : "图片已恢复显示",
                    )}
                  >{compactAsset.isVisible ? "隐藏" : "恢复显示"}</button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className={styles.actionRow}>
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={globalDisabled || generationUnavailable}
                onClick={() => void run(
                  compactKey,
                  () => compactAsset
                    ? regenerateVisualAsset(compactAsset.id)
                    : generateWorkVisualAssets(workId, compactKind === "hero"
                      ? { type: "hero" }
                      : { type: "scene", sceneId: compactScene!.sceneId }),
                  compactAsset ? "图片已进入重新生成队列" : "图片已进入生成队列",
                )}
              >
                {busyKey === compactKey ? <span className={styles.busy} /> : null}
                {compactAsset ? "重新生成" : "生成图片"}
              </button>
              {uploadLabel(compactKind, compactScene?.sceneId)}
              {compactAsset ? (
                <button
                  type="button"
                  className={styles.buttonQuiet}
                  disabled={globalDisabled}
                  onClick={() => void run(
                    `${compactKey}-visible`,
                    () => updateVisualAsset(compactAsset.id, compactAsset.isVisible ? "hide" : "show"),
                    compactAsset.isVisible ? "图片已隐藏" : "图片已恢复显示",
                  )}
                >{compactAsset.isVisible ? "隐藏" : "恢复显示"}</button>
              ) : null}
            </div>
          )}

          {compactSpec ? (
            <>
              <VersionPicker
                versions={compactVersions}
                disabled={globalDisabled}
                onActivate={(asset) => void run(
                  `activate-${asset.id}`,
                  () => updateVisualAsset(asset.id, "activate"),
                  `已启用图片 v${asset.version}`,
                )}
              />
            </>
          ) : null}

          {cropDraft ? (
            <CropDialog
              draft={cropDraft}
              busy={busyKey === "upload"}
              onChange={setCropDraft}
              onCancel={closeCrop}
              onConfirm={() => void run("upload", async () => {
                const uploaded = await uploadWorkVisualAsset(workId, await cropImage(cropDraft), cropDraft.kind, cropDraft.sceneId);
                closeCrop();
                return uploaded;
              }, "替换图片已上传并设为使用版本")}
            />
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="work-visual-title">
      <div className={styles.heading}>
        <div className={styles.headingCopy}>
          <p className={styles.eyebrow}>作品视觉</p>
          <h2 id="work-visual-title">把全文变成统一的视觉叙事</h2>
          <p>视觉方案、Hero 与逐句意境图独立于朗诵分析；生成失败不会影响图谱编辑、音频或发布。</p>
        </div>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.button}
            disabled={globalDisabled}
            onClick={() => void run("plan", () => generateWorkVisualPlan(workId), "作品视觉方案已更新")}
          >
            {busyKey === "plan" ? <span className={styles.busy} /> : null}
            {profile ? "重新生成视觉方案" : "生成作品视觉方案"}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={globalDisabled || generationUnavailable || !visuals.heroSpec || visuals.sceneSpecs.length === 0}
            onClick={() => void run("all", () => generateWorkVisualAssets(workId, { type: "all" }), "全部视觉资产已进入生成队列")}
          >
            {busyKey === "all" ? <span className={styles.busy} /> : null}
            生成全部视觉资产
          </button>
          {profile ? (
            <button
              type="button"
              className={styles.buttonQuiet}
              disabled={globalDisabled}
              onClick={() => void run(
                "lock",
                () => updateWorkVisuals(workId, { action: profile.isLocked ? "unlock_style" : "lock_style" }),
                profile.isLocked ? "作品风格已解锁" : "作品风格已锁定",
              )}
            >{profile.isLocked ? "解锁作品风格" : "锁定作品风格"}</button>
          ) : null}
        </div>
      </div>

      {!savedWork ? <div className={styles.notice}>请先保存作品，再生成或上传视觉资产。</div> : null}
      {generationUnavailable ? (
        <div className={styles.notice}>
          图片生成服务尚未配置。你仍可生成和编辑视觉方案，并通过“上传替换 / 裁切”完成 Hero 与逐句图片。
        </div>
      ) : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}

      {profile ? (
        <article className={`${styles.card} ${styles.profile}`}>
          <div className={styles.profileHeader}>
            <div>
              <p className={styles.eyebrow}>全篇统一标准</p>
              <h3>作品视觉档案</h3>
            </div>
            {profile.isLocked ? <span className={styles.locked}>已锁定</span> : <span className={styles.status}>可继续调整</span>}
          </div>
          <div className={styles.profileGrid}>
            {[
              ["视觉风格", profile.visualStyle],
              ["色彩", profile.palette.join(" · ")],
              ["材质", profile.texture],
              ["光线", profile.lighting],
              ["氛围", profile.atmosphere],
              ["构图", profile.compositionRule],
              ["人物处理", profile.humanPresence],
              ["象征元素", profile.symbolicElements.join(" · ")],
            ].map(([label, value]) => (
              <div className={styles.profileItem} key={label}><span>{label}</span><strong>{value || "—"}</strong></div>
            ))}
          </div>
        </article>
      ) : (
        <div className={styles.empty}>
          <strong>还没有作品视觉方案</strong>
          LLM 会阅读全文，再统一 Hero 与每句图片的风格、色彩、材质和构图。
        </div>
      )}

      <article className={`${styles.card} ${styles.assetCard}`}>
        <div className={styles.preview}>
          {hero?.url ? <img src={hero.url} alt={`${title || "作品"} Hero 预览`} /> : (
            <div className={styles.placeholder}>
              <strong>{title || "作品主视觉"}</strong>
              <small>{author || "作者"} · 1500 × 420 Hero</small>
            </div>
          )}
          {hero && textValidationCopy(hero.textValidationStatus)?.tone === "warn" ? (
            <span className={styles.reviewOverlay}>{hero.textValidationMessage || "标题或作者文字与作品信息不一致，暂不进入用户端。"}</span>
          ) : null}
        </div>
        <div className={styles.assetBody}>
          <div className={styles.assetHeader}>
            <div>
              <p className={styles.eyebrow}>Hero · 1500 × 420</p>
              <h3>作品标题主视觉</h3>
              <p className={styles.assetMeta}>{visuals.heroSpec?.visualSubject || "等待视觉方案"}</p>
            </div>
            <span className={hero?.status === "ready" && hero.isVisible ? styles.statusReady : styles.status}>{statusLabel(hero)}</span>
          </div>
          <div className={styles.statusRow}>
            {textValidationCopy(hero?.textValidationStatus) ? (
              <span className={textValidationCopy(hero?.textValidationStatus)?.tone === "ready" ? styles.statusReady : textValidationCopy(hero?.textValidationStatus)?.tone === "warn" ? styles.statusWarn : styles.status}>
                {textValidationCopy(hero?.textValidationStatus)?.label}
              </span>
            ) : null}
            {hero ? <span className={styles.status}>v{hero.version} · {hero.provider || "upload"}</span> : null}
          </div>
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={globalDisabled || generationUnavailable || !visuals.heroSpec}
              onClick={() => void run(
                "hero",
                () => hero ? regenerateVisualAsset(hero.id) : generateWorkVisualAssets(workId, { type: "hero" }),
                hero ? "Hero 已进入重新生成队列" : "Hero 已进入生成队列",
              )}
            >{busyKey === "hero" ? <span className={styles.busy} /> : null}{hero ? "重新生成" : "生成 Hero"}</button>
            {uploadLabel("hero")}
            {hero ? (
              <button type="button" className={styles.buttonQuiet} disabled={globalDisabled} onClick={() => void run(
                "hero-visible",
                () => updateVisualAsset(hero.id, hero.isVisible ? "hide" : "show"),
                hero.isVisible ? "Hero 已从用户端隐藏" : "Hero 已恢复显示",
              )}>{hero.isVisible ? "隐藏 Hero" : "恢复显示"}</button>
            ) : null}
          </div>
          <VersionPicker versions={heroVersions} disabled={globalDisabled} onActivate={(asset) => void run(`activate-${asset.id}`, () => updateVisualAsset(asset.id, "activate"), `已启用 Hero v${asset.version}`)} />
          {visuals.heroSpec ? (
            <PromptEditor
              key={`hero-${visuals.heroSpec.version ?? 0}`}
              workId={workId}
              kind="hero"
              spec={visuals.heroSpec}
              disabled={globalDisabled || Boolean(profile?.isLocked)}
              onUpdated={(bundle) => {
                setVisuals(bundle);
                onVisualsChange?.(bundle);
                onNotify?.("Hero Prompt 已保存为新版本");
              }}
              onError={fail}
            />
          ) : null}
        </div>
      </article>

      <div className={styles.scenes}>
        {visuals.sceneSpecs.length ? visuals.sceneSpecs.map((scene, index) => {
          const asset = assetFor(visuals.assets, "scene", scene.sceneId);
          const versions = versionsFor(visuals.assets, "scene", scene.sceneId);
          const key = `scene-${scene.sceneId}`;
          return (
            <article className={styles.sceneCard} key={scene.sceneId}>
              <div className={styles.scenePreview}>
                {asset?.url ? <img src={asset.url} alt={`第 ${index + 1} 幕意境图`} /> : (
                  <div className={styles.placeholder}><strong>第 {String(index + 1).padStart(2, "0")} 幕</strong><small>4:3 意境图</small></div>
                )}
              </div>
              <div className={styles.sceneBody}>
                <div className={styles.sceneHeader}>
                  <span className={styles.sceneIndex}>SCENE {String(index + 1).padStart(2, "0")} · {scene.visualType}</span>
                  <span className={asset?.status === "ready" && asset.isVisible ? styles.statusReady : styles.status}>{statusLabel(asset)}</span>
                </div>
                <p className={styles.sourceText}>{scene.sourceText}</p>
                <p className={styles.sceneSummary}>{scene.sceneSummary || scene.mainSubject}</p>
                <div className={styles.actionRow}>
                  <button
                    type="button"
                    className={styles.buttonPrimary}
                    disabled={globalDisabled || generationUnavailable}
                    onClick={() => void run(key, () => asset
                      ? regenerateVisualAsset(asset.id)
                      : generateWorkVisualAssets(workId, { type: "scene", sceneId: scene.sceneId }), asset ? "意境图已进入重新生成队列" : "意境图已进入生成队列")}
                  >{busyKey === key ? <span className={styles.busy} /> : null}{asset ? "重新生成" : "生成意境图"}</button>
                  {uploadLabel("scene", scene.sceneId)}
                  {asset ? (
                    <button type="button" className={styles.buttonQuiet} disabled={globalDisabled} onClick={() => void run(
                      `${key}-visible`,
                      () => updateVisualAsset(asset.id, asset.isVisible ? "hide" : "show"),
                      asset.isVisible ? "该意境图已隐藏" : "该意境图已恢复显示",
                    )}>{asset.isVisible ? "隐藏" : "恢复显示"}</button>
                  ) : null}
                </div>
                <VersionPicker versions={versions} disabled={globalDisabled} onActivate={(version) => void run(`activate-${version.id}`, () => updateVisualAsset(version.id, "activate"), `已启用意境图 v${version.version}`)} />
                <PromptEditor
                  key={`${scene.sceneId}-${scene.version ?? 0}`}
                  workId={workId}
                  kind="scene"
                  sceneId={scene.sceneId}
                  spec={scene}
                  disabled={globalDisabled || Boolean(profile?.isLocked)}
                  onUpdated={(bundle) => {
                    setVisuals(bundle);
                    onVisualsChange?.(bundle);
                    onNotify?.("Scene Prompt 已保存为新版本");
                  }}
                  onError={fail}
                />
              </div>
            </article>
          );
        }) : (
          <div className={styles.empty}>
            <strong>Scene Unit 将按 。！？ 自动划分</strong>
            生成视觉方案后，每个完整场景会在这里获得独立意境图和版本记录。
          </div>
        )}
      </div>

      {cropDraft ? (
        <CropDialog
          draft={cropDraft}
          busy={busyKey === "upload"}
          onChange={setCropDraft}
          onCancel={closeCrop}
          onConfirm={() => void run("upload", async () => {
            const uploaded = await uploadWorkVisualAsset(
              workId,
              await cropImage(cropDraft),
              cropDraft.kind,
              cropDraft.sceneId,
            );
            closeCrop();
            return uploaded;
          }, "替换图片已上传并设为使用版本")}
        />
      ) : null}
    </section>
  );
}
