import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleMinus,
  Eye,
  FolderOpen,
  PanelBottomClose,
  PanelBottomOpen,
  PanelTopClose,
  PanelTopOpen,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { BatchItem, BatchPlan, ProgressUpdate } from "../../shared/contracts.ts";
import type { AppAction, AppError } from "../App.tsx";
import { formatBytes, formatChange } from "../lib/format.ts";
import { useWindowDrop } from "../lib/useWindowDrop.ts";
import { ProgressBar } from "./ProgressBar.tsx";

interface BatchViewProps {
  batch: BatchPlan;
  /** Path of the model on the stage, or null when only the list shows. */
  previewing: string | null;
  onPreview(relativePath: string | null): void;
  /** The comparison stage for `previewing`. */
  stage: ReactNode;
  running: boolean;
  disabled: boolean;
  progress: ProgressUpdate | null;
  error: AppError | null;
  blenderLinked: boolean;
  onDrop(file: File, isFolder: boolean): void;
  onChangeOutput(): void;
  onChooseFolder(): void;
  onClose(): void;
  onReveal(path: string): void;
  onLocateBlender(): void;
  onAction(action: AppAction): void;
}

const NEEDS_BLENDER = "Needs Blender";
const ACTION_LABEL: Record<AppAction, string> = {
  choose: "Choose a file",
  "choose-folder": "Choose another folder",
  blender: "Locate Blender",
  "retry-optimize": "Try again",
  dismiss: "Dismiss",
};

/** While previewing, the stage takes this share of the height the two panels split. */
const DEFAULT_SHARE = 0.64;
/** Smallest useful heights. Dragging well past them hides that panel when the drag ends. */
const MIN_STAGE = 220;
const MIN_LIST = 120;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const folderName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

function StatusIcon({ item }: { item: BatchItem }) {
  const props = { size: 15, "aria-hidden": true, className: "batch-icon" } as const;
  if (item.status === "done") return <CircleCheck {...props} />;
  if (item.status === "processing") return <CircleDot {...props} />;
  if (item.status === "failed") return <CircleAlert {...props} />;
  if (item.status === "cancelled") return <CircleMinus {...props} />;
  if (item.status === "skipped")
    return item.message === NEEDS_BLENDER ? (
      <TriangleAlert {...props} />
    ) : (
      <CircleCheck {...props} />
    );
  return <Circle {...props} />;
}

/** Arrow keys belong to focused inputs and the divider. Elsewhere they step through models. */
function ownsArrows(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) ||
      target.isContentEditable ||
      !!target.closest('[role="slider"]'))
  );
}

function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <>
      {cut > 0 && <span className="batch-dir">{path.slice(0, cut)}</span>}
      <span className="batch-name">{path.slice(cut)}</span>
    </>
  );
}

function Row({
  item,
  progress,
  disabled,
  selected,
  onReveal,
  onPreview,
}: {
  item: BatchItem;
  progress: ProgressUpdate | null;
  disabled: boolean;
  selected: boolean;
  onReveal(path: string): void;
  onPreview(relativePath: string | null): void;
}) {
  const change =
    item.status === "done" && item.outputBytes !== undefined
      ? formatChange(item.sourceBytes, item.outputBytes)
      : null;
  const tone =
    item.status === "skipped" && item.message === NEEDS_BLENDER ? "blender" : item.status;
  return (
    <li
      className="batch-row"
      data-status={tone}
      data-previewable={item.preview ? true : undefined}
      data-selected={selected || undefined}
      onClick={item.preview ? () => onPreview(item.relativePath) : undefined}
    >
      <StatusIcon item={item} />
      <div className="batch-file">
        <p className="batch-path" title={item.relativePath}>
          <FilePath path={item.relativePath} />
        </p>
        {item.status === "processing" && (
          <div className="batch-progress">
            <ProgressBar value={progress ? progress.percent / 100 : null} />
            <span>{progress?.message ?? "Starting"}</span>
          </div>
        )}
        {item.status === "failed" && item.message && (
          <p className="batch-message">{item.message}</p>
        )}
      </div>
      <span className="batch-size">{formatBytes(item.sourceBytes)}</span>
      <span className="batch-result">
        {item.status === "done" && item.outputBytes !== undefined ? (
          <>
            <span className="batch-output">{formatBytes(item.outputBytes)}</span>
            {change && (
              <span className="batch-change" data-tone={change.tone}>
                {change.text}
              </span>
            )}
          </>
        ) : item.status === "processing" ? (
          <span className="batch-state">{progress ? `${progress.percent}%` : ""}</span>
        ) : item.status === "skipped" ? (
          <span className="batch-state">
            {item.message === NEEDS_BLENDER ? NEEDS_BLENDER : "Up to date"}
          </span>
        ) : item.status === "failed" ? (
          <span className="batch-state">Failed</span>
        ) : item.status === "cancelled" ? (
          <span className="batch-state">Stopped</span>
        ) : null}
      </span>
      <span className="batch-reveal">
        {item.preview && (
          <button
            type="button"
            className="icon-button"
            onClick={(event) => {
              event.stopPropagation();
              onPreview(selected ? null : item.relativePath);
            }}
            aria-pressed={selected}
            title={selected ? "Close preview" : "Preview and compare"}
            aria-label={`Preview ${item.relativePath}`}
          >
            <Eye size={14} aria-hidden="true" />
          </button>
        )}
        {item.modelPath && (
          <button
            type="button"
            className="icon-button"
            onClick={(event) => {
              event.stopPropagation();
              onReveal(item.modelPath!);
            }}
            disabled={disabled}
            title="Show in folder"
            aria-label={`Show ${item.relativePath} in folder`}
          >
            <FolderOpen size={14} aria-hidden="true" />
          </button>
        )}
      </span>
    </li>
  );
}

/** The folder workspace: what was found, where results go, and how each model went. */
export function BatchView({
  batch,
  previewing,
  onPreview,
  stage,
  running,
  disabled,
  progress,
  error,
  blenderLinked,
  onDrop,
  onChangeOutput,
  onChooseFolder,
  onClose,
  onReveal,
  onLocateBlender,
  onAction,
}: BatchViewProps) {
  const dragging = useWindowDrop(disabled, onDrop);
  const listRef = useRef<HTMLOListElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Which panel is folded away to give the other the room. Only applies while previewing. */
  const [hidden, setHidden] = useState<"preview" | "list" | null>(null);
  const [share, setShare] = useState(DEFAULT_SHARE);
  /** The panel a drag of the handle would fold when it ends, once squeezed too far. */
  const dragFold = useRef<"preview" | "list" | null>(null);
  const items = batch.items;
  const count = (status: BatchItem["status"], message?: string) =>
    items.filter(
      (item) => item.status === status && (message === undefined || item.message === message),
    ).length;
  const done = items.filter((item) => item.status === "done");
  const upToDate = items.filter(
    (item) => item.status === "skipped" && item.message !== NEEDS_BLENDER,
  ).length;
  const needsBlender = count("skipped", NEEDS_BLENDER);
  const failed = count("failed");
  const folders = new Set(items.map((item) => item.relativePath.split("/").slice(0, -1).join("/")))
    .size;
  const totalBytes = items.reduce((sum, item) => sum + item.sourceBytes, 0);
  const before = done.reduce((sum, item) => sum + item.sourceBytes, 0);
  const after = done.reduce((sum, item) => sum + (item.outputBytes ?? 0), 0);
  const overall = formatChange(before, after);
  const processing = items.findIndex((item) => item.status === "processing");
  const hasOutput = done.length > 0 || upToDate > 0;

  // Neighbours come from list order, so stepping still works while the open model is reprocessed.
  const followed = previewing ? items.findIndex((item) => item.relativePath === previewing) : -1;
  const candidate = followed >= 0 ? items[followed] : null;
  // Without a preview, the open model only holds its place while a run is about to replace it.
  const pending =
    running && (candidate?.status === "waiting" || candidate?.status === "processing");
  const selected = candidate && (candidate.preview || pending) ? candidate : null;
  useEffect(() => {
    if (previewing && !selected) onPreview(null);
  }, [previewing, selected, onPreview]);
  const previewable = items.filter((item) => item.preview);
  const position = selected ? previewable.indexOf(selected) : -1;
  const previous = items.slice(0, Math.max(0, followed)).findLast((item) => item.preview);
  const next = followed >= 0 ? items.slice(followed + 1).find((item) => item.preview) : undefined;
  const step = (by: -1 | 1) => {
    const target = by < 0 ? previous : next;
    if (target) onPreview(target.relativePath);
  };
  // Choosing a model from the list is a request to see it.
  const open = (relativePath: string | null) => {
    onPreview(relativePath);
    if (relativePath && hidden === "preview") setHidden(null);
  };
  // The list always comes back once nothing is being previewed.
  const fold = selected ? hidden : null;

  // The handle between the panels: drag to share the height, double-click or Enter to reset.
  const resize = (clientY: number) => {
    const top = stageRef.current?.getBoundingClientRect().top;
    const bottom = scrollRef.current?.getBoundingClientRect().bottom;
    if (top === undefined || bottom === undefined) return;
    const total = bottom - top;
    if (total < MIN_STAGE + MIN_LIST) return;
    const height = clientY - top;
    dragFold.current =
      height < MIN_STAGE * 0.6 ? "preview" : total - height < MIN_LIST * 0.6 ? "list" : null;
    setShare(clamp(height, MIN_STAGE, total - MIN_LIST) / total);
  };
  const onSashDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFold.current = null;
  };
  const onSashMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientY);
  };
  const onSashUp = () => {
    if (!dragFold.current) return;
    setHidden(dragFold.current);
    setShare(DEFAULT_SHARE);
    dragFold.current = null;
  };
  const onSashKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? 0.1 : 0.03;
    if (event.key === "ArrowUp") setShare((value) => clamp(value - by, 0.3, 0.85));
    else if (event.key === "ArrowDown") setShare((value) => clamp(value + by, 0.3, 0.85));
    else if (event.key === "Enter" || event.key === "Home") setShare(DEFAULT_SHARE);
    else return;
    event.preventDefault();
  };
  // The two panels split the height left under the header. A folded panel keeps only its bar.
  const stageFlex = fold === "preview" ? "none" : fold === "list" ? "1 1 0" : `${share} 1 0`;
  const listFlex = !selected || fold === "preview" ? "1 1 0" : `${1 - share} 1 0`;

  // Keep the model being processed in view, without animating the scroll. While a preview is
  // open, the previewed model stays in view instead.
  const inView = previewing ? followed : processing;
  useEffect(() => {
    if (inView < 0 || fold === "list") return;
    listRef.current?.children[inView]?.scrollIntoView({ block: "nearest" });
  }, [inView, fold]);

  // Left and right step through finished models, Escape closes the preview.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (event.key === "Escape") onPreview(null);
      else if (event.key === "ArrowLeft" && !ownsArrows(event.target)) step(-1);
      else if (event.key === "ArrowRight" && !ownsArrows(event.target)) step(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const summary = [
    done.length && `${done.length} optimized`,
    upToDate && `${upToDate} already up to date`,
    failed && `${failed} failed`,
  ].filter(Boolean);

  return (
    <section className="batch" aria-label="Folder" data-previewing={selected ? true : undefined}>
      <header className="batch-head">
        <div className="record-head">
          <h2 className="record-title" title={batch.sourceDir}>
            {folderName(batch.sourceDir)}
          </h2>
          <p className="record-meta">
            {items.length === 1 ? "1 model" : `${items.length} models`}
            {items.length > 0 && `, ${formatBytes(totalBytes)}`}
            {folders > 1 && ` in ${folders} folders`}
          </p>
          <p className="record-path" title={batch.sourceDir}>
            {batch.sourceDir}
          </p>
        </div>
        <div className="batch-destination">
          <p className="batch-label">Saves to</p>
          <p className="record-path batch-destination-path" title={batch.outputDir}>
            {batch.outputDir}
          </p>
          <div className="batch-destination-actions">
            <button type="button" className="link" onClick={onChangeOutput} disabled={disabled}>
              Change
            </button>
            {hasOutput && (
              <button
                type="button"
                className="link"
                onClick={() => onReveal(batch.outputDir)}
                disabled={running}
              >
                Show folder
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          className="icon-button batch-close"
          onClick={onClose}
          disabled={disabled}
          title="Close folder"
          aria-label="Close folder"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      {(summary.length > 0 || (needsBlender > 0 && !blenderLinked)) && (
        <div className="batch-notes">
          {summary.length > 0 && (
            <p className="batch-summary" role="status">
              {summary.join(", ")}.
              {done.length > 0 && (
                <>
                  {" "}
                  {formatBytes(before)} became {formatBytes(after)}
                  {overall.tone === "smaller" && (
                    <strong className="batch-change" data-tone="smaller">
                      {" "}
                      {overall.text}
                    </strong>
                  )}
                  .
                </>
              )}
            </p>
          )}
          {needsBlender > 0 && !blenderLinked && (
            <p className="risk batch-risk">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                {needsBlender === 1 ? "1 file needs" : `${needsBlender} files need`} Blender to
                open.{" "}
                <button
                  type="button"
                  className="link"
                  onClick={onLocateBlender}
                  disabled={disabled}
                >
                  Locate Blender
                </button>
              </span>
            </p>
          )}
        </div>
      )}

      {selected && (
        <div
          className="batch-stage"
          ref={stageRef}
          data-folded={fold === "preview" || undefined}
          style={{ flex: stageFlex, minHeight: fold ? undefined : MIN_STAGE }}
        >
          {/* Folding keeps the stage mounted, so it reopens instantly on the same view. */}
          <div className="batch-stage-body" hidden={fold === "preview"}>
            {stage ?? (
              // The open model is being processed again. Hold its place so the list does not jump.
              <div className="stage batch-stage-pending" role="status">
                <p className="overlay-text">
                  Processing this model again. Its new web copy opens here when it is ready.
                </p>
              </div>
            )}
          </div>
          <nav className="pager" aria-label="Finished models">
            <button
              type="button"
              className="icon-button"
              onClick={() => step(-1)}
              disabled={!previous}
              title="Previous model (Left arrow)"
              aria-label="Previous model"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <p className="pager-label" title={selected.relativePath}>
              <span className="pager-path">
                <FilePath path={selected.relativePath} />
              </span>
              {position >= 0 && (
                <span className="pager-count">
                  {position + 1} of {previewable.length}
                </span>
              )}
            </p>
            <button
              type="button"
              className="icon-button"
              onClick={() => step(1)}
              disabled={!next}
              title="Next model (Right arrow)"
              aria-label="Next model"
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
            <span className="pager-rule" aria-hidden="true" />
            {fold === "preview" ? (
              <button type="button" className="pager-show" onClick={() => setHidden(null)}>
                <PanelTopOpen size={15} aria-hidden="true" />
                Show preview
              </button>
            ) : (
              <button
                type="button"
                className="icon-button"
                onClick={() => setHidden("preview")}
                title="Hide preview to give the list the room"
                aria-label="Hide preview"
              >
                <PanelTopClose size={15} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => onPreview(null)}
              title="Close preview (Esc)"
              aria-label="Close preview"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </nav>
          {!fold && (
            <div
              className="sash"
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label="Resize preview and list"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              title="Drag to resize. Double-click to reset."
              onPointerDown={onSashDown}
              onPointerMove={onSashMove}
              onPointerUp={onSashUp}
              onDoubleClick={() => setShare(DEFAULT_SHARE)}
              onKeyDown={onSashKey}
            />
          )}
        </div>
      )}

      {items.length ? (
        <>
          {fold === "list" && (
            <button
              type="button"
              className="batch-shelf"
              onClick={() => setHidden(null)}
              title="Show the list of models"
            >
              <span className="batch-shelf-count">
                {items.length === 1 ? "1 model" : `${items.length} models`}
              </span>
              {processing >= 0 ? (
                <span className="batch-shelf-status">
                  Processing <FilePath path={items[processing].relativePath} />
                  {progress && <span className="batch-shelf-percent">{progress.percent}%</span>}
                </span>
              ) : (
                summary.length > 0 && (
                  <span className="batch-shelf-status">{summary.join(", ")}</span>
                )
              )}
              <span className="batch-shelf-action">
                <PanelBottomOpen size={15} aria-hidden="true" />
                Show list
              </span>
            </button>
          )}
          <div
            className="batch-scroll"
            ref={scrollRef}
            hidden={fold === "list"}
            style={{ flex: listFlex, minHeight: selected && !fold ? MIN_LIST : undefined }}
          >
            <div className="batch-columns">
              <span aria-hidden="true" />
              <span aria-hidden="true">File</span>
              <span aria-hidden="true">Source</span>
              <span aria-hidden="true">Web copy</span>
              <span className="batch-columns-action">
                {selected && !fold && (
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setHidden("list")}
                    title="Hide list to give the preview the room"
                    aria-label="Hide list"
                  >
                    <PanelBottomClose size={15} aria-hidden="true" />
                  </button>
                )}
              </span>
            </div>
            <ol className="batch-list" ref={listRef} aria-label="Models in this folder">
              {items.map((item, index) => (
                <Row
                  key={item.relativePath}
                  item={item}
                  progress={index === processing ? progress : null}
                  disabled={running}
                  selected={item === selected}
                  onReveal={onReveal}
                  onPreview={open}
                />
              ))}
            </ol>
          </div>
        </>
      ) : (
        <div className="batch-empty">
          <p className="overlay-title">No 3D models in this folder</p>
          <p className="overlay-text">
            Kiln looked in every folder inside it too. Choose a folder that holds GLB, glTF, USDZ,
            OBJ, FBX, PLY or STL files.
          </p>
          <button type="button" className="button button-quiet" onClick={onChooseFolder}>
            Choose another folder
          </button>
        </div>
      )}

      {error && (
        <div className="banner-wrap">
          <div className="banner" role="alert">
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

      {dragging && (
        <div className="drop-target" aria-hidden="true">
          <span>Drop to open this instead</span>
        </div>
      )}
    </section>
  );
}
