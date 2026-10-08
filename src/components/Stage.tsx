import {
  AlertTriangle,
  Box,
  ChevronsLeftRight,
  FileUp,
  Image,
  Network,
  RotateCcw,
  ScanSearch,
  Sun,
  Sunrise,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  AssetInfo,
  EnvironmentInfo,
  OptimizationResult,
  ProgressUpdate,
  TextureInfo,
} from "../../shared/contracts.ts";
import type { AppAction, AppError, Busy } from "../App.tsx";
import { formatBytes, formatPixels } from "../lib/format.ts";
import { roleTexture } from "../lib/options.ts";
import {
  ComparisonViewer,
  type Lighting,
  type Slot,
  type SlotStatus,
  type Surface,
  type ViewMode,
} from "../viewer/ComparisonViewer.ts";
import { useWindowDrop } from "../lib/useWindowDrop.ts";
import { ProgressBar } from "./ProgressBar.tsx";

/** Above this combined estimate, compare one model at a time instead of holding both in memory. */
const BOTH_MODELS_BUDGET = 1.5 * 1024 ** 3;
const FALLBACK_FORMATS = ["usdz", "glb", "gltf", "obj", "fbx", "ply", "stl"];

interface StageProps {
  /**
   * One model out of a processed folder. The folder view handles drops, there is no export step to
   * coach towards, and the chosen view carries over as the user steps from model to model.
   */
  folder?: boolean;
  asset: AssetInfo | null;
  result: OptimizationResult | null;
  busy: Busy | null;
  progress: ProgressUpdate | null;
  error: AppError | null;
  environment: EnvironmentInfo | null;
  onDrop(file: File, isFolder: boolean): void;
  onChoose(): void;
  onChooseFolder(): void;
  onCancel(): void;
  onAction(action: AppAction): void;
}

const ACTION_LABEL: Record<AppAction, string> = {
  choose: "Choose another file",
  "choose-folder": "Choose another folder",
  blender: "Locate Blender",
  "retry-optimize": "Try again",
  dismiss: "Dismiss",
};

function textureSpec(texture: TextureInfo | undefined): string {
  if (!texture) return "";
  const format = texture.mimeType.replace("image/", "").toUpperCase().replace("JPEG", "JPG");
  return `${formatPixels(Math.max(texture.width, texture.height))} ${format}`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const SURFACES: Surface[] = ["texture", "clay", "wire"];

/** Text entry swallows shortcuts. Radios and switches do not, so M and L work right after a click. */
function isTyping(target: EventTarget | null) {
  if (target instanceof HTMLInputElement)
    return !["radio", "checkbox", "range", "button"].includes(target.type);
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["SELECT", "TEXTAREA"].includes(target.tagName))
  );
}

export function Stage({
  folder = false,
  asset,
  result,
  busy,
  progress,
  error,
  environment,
  onDrop,
  onChoose,
  onChooseFolder,
  onCancel,
  onAction,
}: StageProps) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ComparisonViewer | null>(null);
  const [viewerKey, setViewerKey] = useState(0);
  const [slots, setSlots] = useState<Record<Slot, SlotStatus>>({
    source: { state: "empty" },
    optimized: { state: "empty" },
  });
  const [mode, setMode] = useState<ViewMode>("source");
  const [split, setSplit] = useState(0.5);
  const [lighting, setLighting] = useState<Lighting>("studio");
  const [surface, setSurface] = useState<Surface>("texture");
  const [scale, setScale] = useState<number | null>(null);
  const [contextLost, setContextLost] = useState(false);
  /** The renderer could not start, usually because WebGL is unavailable. The rest of the app still works. */
  const [noGraphics, setNoGraphics] = useState(false);
  const [lowMemory, setLowMemory] = useState(false);
  const [coach, setCoach] = useState(false);
  const comparedBefore = useRef(false);

  const fitsBoth =
    !lowMemory && (!asset || !result || asset.gpuBytes + result.gpuBytes <= BOTH_MODELS_BUDGET);
  const view: ViewMode = result ? (mode === "split" && !fitsBoth ? "optimized" : mode) : "source";
  const wantSource = !!asset && (view !== "optimized" || (fitsBoth && !!result));
  const wantOptimized = !!result && (view !== "source" || fitsBoth);

  // Viewer lifecycle. A new key rebuilds it, which is how a lost graphics context recovers.
  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;
    setSlots({ source: { state: "empty" }, optimized: { state: "empty" } });
    let viewer: ComparisonViewer;
    try {
      viewer = new ComparisonViewer(host, {
        onSlot: (slot, status) => setSlots((current) => ({ ...current, [slot]: status })),
        onScale: (value) => setScale(value === null ? null : Number(value.toPrecision(2))),
        onContextLost: () => {
          setContextLost(true);
          setLowMemory(true);
        },
      });
    } catch (cause) {
      console.error("Kiln could not start the 3D preview.", cause);
      host.replaceChildren();
      setNoGraphics(true);
      return;
    }
    setNoGraphics(false);
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [viewerKey]);

  // A new source asset resets framing and the texel reference.
  const colorWidth = roleTexture(asset, "color")?.width ?? 0;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setModel("optimized", null);
    viewer.setModel("source", null);
    viewer.resetAsset(colorWidth);
  }, [viewerKey, asset?.id, colorWidth]);
  useEffect(() => setLowMemory(false), [asset?.id]);

  // Load what the current view needs. Unload first so two large textures sets never overlap needlessly.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const source = wantSource && asset ? asset.previewUrl : null;
    const optimized = wantOptimized && result ? result.previewUrl : null;
    if (!source) viewer.setModel("source", null);
    if (!optimized) viewer.setModel("optimized", null);
    if (source) viewer.setModel("source", source);
    if (optimized) viewer.setModel("optimized", optimized);
  }, [viewerKey, asset, result, wantSource, wantOptimized]);

  // A fresh result opens the comparison.
  useEffect(() => {
    if (!result) return setMode("source");
    if (folder && comparedBefore.current) return;
    comparedBefore.current = true;
    setMode(fitsBoth ? "split" : "optimized");
    setSplit(0.5);
    setCoach(!folder);
    // Chosen once per result: later memory changes should not flip the user's view.
  }, [result?.id]);

  useEffect(() => viewerRef.current?.setMode(view), [view, viewerKey]);
  useEffect(() => viewerRef.current?.setSplit(split), [split, viewerKey]);
  useEffect(() => viewerRef.current?.setLighting(lighting), [lighting, viewerKey]);
  useEffect(() => viewerRef.current?.setSurface(surface), [surface, viewerKey]);

  const ready = slots.source.state === "ready" || slots.optimized.state === "ready";

  // Keyboard shortcuts for the viewport.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "1" && asset) setMode("source");
      else if (key === "2" && result && fitsBoth) setMode("split");
      else if (key === "3" && result) setMode("optimized");
      else if (key === "r") viewerRef.current?.resetView();
      else if (key === "t") viewerRef.current?.showTexels();
      else if (key === "l") setLighting((value) => (value === "studio" ? "raking" : "studio"));
      else if (key === "m")
        setSurface((value) => SURFACES[(SURFACES.indexOf(value) + 1) % SURFACES.length]);
      else return;
      setCoach(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asset, result, fitsBoth]);

  const dragging = useWindowDrop(!!busy, folder ? null : onDrop);

  const moveDivider = useCallback((clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSplit(Math.min(0.98, Math.max(0.02, (clientX - rect.left) / rect.width)));
  }, []);

  const onDividerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCoach(false);
  };
  const onDividerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) moveDivider(event.clientX);
  };
  const onDividerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const next = { ArrowLeft: split - step, ArrowRight: split + step, Home: 0.02, End: 0.98 }[
      event.key
    ];
    if (next === undefined) return;
    event.preventDefault();
    setSplit(Math.min(0.98, Math.max(0.02, next)));
  };

  // Without textures the useful comparison is geometry, so the labels switch to triangle counts.
  const meshSpec = (triangles: number | undefined) =>
    triangles ? `${compact.format(triangles)} triangles` : "";
  const sourceSpec =
    surface === "texture" ? textureSpec(roleTexture(asset, "color")) : meshSpec(asset?.triangles);
  const optimizedSpec =
    surface === "texture"
      ? textureSpec(result?.textures.find((texture) => texture.role === "color"))
      : meshSpec(result?.triangles);
  const loadingSlot = (["source", "optimized"] as Slot[]).find(
    (slot) => slots[slot].state === "loading" && (slot === "source" ? wantSource : wantOptimized),
  );
  const loading = loadingSlot
    ? (slots[loadingSlot] as Extract<SlotStatus, { state: "loading" }>)
    : null;
  const failedSlot = (["source", "optimized"] as Slot[]).find(
    (slot) => slots[slot].state === "error",
  );
  const importing = busy?.kind === "import" || busy?.kind === "scan";
  const formats = (
    environment?.supportedFormats.length ? environment.supportedFormats : FALLBACK_FORMATS
  ).map((f) => f.replace(/^\./, "").toUpperCase());
  const splitTitle = fitsBoth
    ? "Split view (2)"
    : `Showing both would need about ${formatBytes((asset?.gpuBytes ?? 0) + (result?.gpuBytes ?? 0))} of graphics memory. Switch between them instead.`;

  return (
    <div
      ref={stageRef}
      className="stage"
      data-folder={folder || undefined}
      data-empty={!asset || undefined}
      data-dragging={dragging || undefined}
      onPointerDown={() => setCoach(false)}
    >
      <div ref={canvasHost} className="stage-canvas" key={viewerKey} />

      {asset && view === "split" && !noGraphics && (
        <>
          <div className="split-label split-label-left">
            Source <span>{sourceSpec}</span>
          </div>
          <div className="split-label split-label-right">
            Optimized <span>{optimizedSpec}</span>
          </div>
          <div
            className="divider"
            style={{ left: `${split * 100}%` }}
            role="slider"
            tabIndex={0}
            aria-label="Comparison divider. Source on the left, optimized on the right."
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split * 100)}
            aria-valuetext={`${Math.round(split * 100)}% source`}
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onKeyDown={onDividerKey}
          >
            <span className="divider-handle">
              <ChevronsLeftRight size={14} aria-hidden="true" />
            </span>
          </div>
        </>
      )}

      {asset && view !== "split" && ready && (
        <div className="split-label split-label-left">
          {view === "source" ? "Source" : "Optimized"}{" "}
          <span>{view === "source" ? sourceSpec : optimizedSpec}</span>
        </div>
      )}

      {asset && !noGraphics && (
        <div className="stage-toolbar stage-toolbar-top" role="toolbar" aria-label="Comparison">
          <fieldset className="segmented segmented-floating">
            <legend className="sr-only">Show</legend>
            {(
              [
                ["source", "Source", "1", true, "Source (1)"],
                [
                  "split",
                  "Split",
                  "2",
                  !!result && fitsBoth,
                  result ? splitTitle : "Optimize to compare",
                ],
                [
                  "optimized",
                  "Optimized",
                  "3",
                  !!result,
                  result ? "Optimized (3)" : "Optimize to compare",
                ],
              ] as const
            ).map(([value, label, key, enabled, title]) => (
              <label key={value} title={title} data-disabled={!enabled || undefined}>
                <input
                  type="radio"
                  name="view"
                  value={value}
                  checked={view === value}
                  disabled={!enabled}
                  onChange={() => setMode(value)}
                />
                <span>
                  {label}
                  <kbd>{key}</kbd>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="segmented segmented-floating segmented-display">
            <legend className="sr-only">Surface</legend>
            {(
              [
                ["texture", "Texture", Image, "Textures as published (M to switch)"],
                [
                  "clay",
                  "Clay",
                  Box,
                  "Plain geometry without textures, so decimation cannot hide behind the normal map (M to switch)",
                ],
                [
                  "wire",
                  "Wire",
                  Network,
                  "Clay with every triangle edge drawn on top (M to switch)",
                ],
              ] as const
            ).map(([value, label, Icon, title]) => (
              <label key={value} title={title}>
                <input
                  type="radio"
                  name="surface"
                  value={value}
                  checked={surface === value}
                  onChange={() => setSurface(value)}
                />
                <span>
                  <Icon size={14} aria-hidden="true" />
                  <span className="segment-label">{label}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="segmented segmented-floating segmented-display">
            <legend className="sr-only">Lighting</legend>
            {(
              [
                ["studio", "Studio", Sun, "Even studio light (L to switch)"],
                [
                  "raking",
                  "Raking",
                  Sunrise,
                  "Low raking light reveals relief and normal map detail (L to switch)",
                ],
              ] as const
            ).map(([value, label, Icon, title]) => (
              <label key={value} title={title}>
                <input
                  type="radio"
                  name="lighting"
                  value={value}
                  checked={lighting === value}
                  onChange={() => setLighting(value)}
                />
                <span>
                  <Icon size={14} aria-hidden="true" />
                  <span className="segment-label">{label}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {asset && ready && (
        <>
          <div className="stage-hint" aria-hidden="true">
            <span className="stage-hint-gesture">
              Drag to orbit, scroll to zoom, double-click to focus
            </span>
            {scale !== null && (
              <span className="stage-scale">
                1 source texel ≈{" "}
                {scale < 0.1 ? "under 0.1" : scale < 10 ? scale.toFixed(1) : Math.round(scale)} px
              </span>
            )}
          </div>
          <div className="stage-toolbar stage-toolbar-bottom">
            <button
              type="button"
              className="tool"
              onClick={() => viewerRef.current?.showTexels()}
              disabled={scale === null}
              title="Zoom until one source texture pixel fills about one screen pixel (T)"
            >
              <ScanSearch size={15} aria-hidden="true" />
              1:1 detail
            </button>
            <button
              type="button"
              className="tool"
              onClick={() => viewerRef.current?.resetView()}
              title="Reset view (R)"
            >
              <RotateCcw size={15} aria-hidden="true" />
              Reset
            </button>
          </div>
        </>
      )}

      {coach && view === "split" && ready && (
        <p className="coach" role="status">
          Drag the divider to compare. Try <strong>1:1 detail</strong> and raking light before you
          export.
        </p>
      )}

      {loading && !importing && (
        <div className="stage-status" role="status">
          <span>Loading {loadingSlot === "source" ? "source" : "optimized"} preview</span>
          <ProgressBar value={loading.progress} />
        </div>
      )}

      {!asset && !importing && !error && (
        <div className="drop">
          <div className="drop-card">
            <FileUp size={22} strokeWidth={1.5} aria-hidden="true" className="drop-icon" />
            <h1 className="drop-title">Open a 3D scan</h1>
            <p className="drop-text">
              Drop a file or a whole folder anywhere in this window, or choose one. Kiln works on
              copies and never changes your originals.
            </p>
            <div className="drop-actions">
              <button type="button" className="button button-primary" onClick={onChoose}>
                Choose file
              </button>
              <button type="button" className="button button-quiet" onClick={onChooseFolder}>
                Process a folder
              </button>
            </div>
            <p className="drop-formats" aria-label="Supported formats">
              {formats.join("  ")}
            </p>
          </div>
        </div>
      )}

      {importing && (
        <div className="overlay">
          <div className="overlay-card" role="status" aria-live="polite">
            {busy.kind === "scan" ? (
              <>
                <p className="overlay-title">Looking for 3D models</p>
                <p className="overlay-text">Checking the folder and every folder inside it.</p>
                <ProgressBar value={null} />
              </>
            ) : (
              <>
                <p className="overlay-title">Opening {busy.fileName ?? "asset"}</p>
                <p className="overlay-text">{progress?.message ?? "Reading the source file"}</p>
                <ProgressBar value={progress ? progress.percent / 100 : null} />
                <button type="button" className="button button-quiet" onClick={onCancel}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className={asset ? "banner-wrap" : "overlay"}>
          <div className={asset ? "banner" : "overlay-card"} role="alert">
            <AlertTriangle size={18} aria-hidden="true" className="alert-icon" />
            <div className="alert-body">
              <p className="overlay-title">{error.title}</p>
              <p className="overlay-text">{error.message}</p>
              <div className="alert-actions">
                {error.actions.map((action, index) => (
                  <button
                    key={action}
                    type="button"
                    className={
                      index === 0 && action !== "dismiss"
                        ? "button button-primary"
                        : "button button-quiet"
                    }
                    onClick={() => onAction(action)}
                  >
                    {ACTION_LABEL[action]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {(contextLost || failedSlot || (noGraphics && asset)) && !error && (
        <div className="overlay">
          <div className="overlay-card" role="alert">
            <AlertTriangle size={18} aria-hidden="true" className="alert-icon" />
            <div className="alert-body">
              <p className="overlay-title">
                {contextLost
                  ? "The graphics card ran out of memory"
                  : "The preview could not be shown"}
              </p>
              <p className="overlay-text">
                {contextLost
                  ? "Kiln will now show one model at a time. Closing other 3D apps also helps."
                  : noGraphics
                    ? "Graphics are unavailable on this computer, so the 3D preview is off. You can still optimize and export."
                    : `${failedSlot === "source" ? "Source" : "Optimized"} preview: ${(slots[failedSlot!] as Extract<SlotStatus, { state: "error" }>).message}`}
              </p>
              <div className="alert-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => {
                    setContextLost(false);
                    setViewerKey((key) => key + 1);
                  }}
                >
                  Reload preview
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="drop-target" aria-hidden="true">
          <span>{asset ? "Drop to open this instead" : "Drop to open"}</span>
        </div>
      )}
    </div>
  );
}
