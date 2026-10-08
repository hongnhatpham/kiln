import {
  AlertTriangle,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleMinus,
  FolderOpen,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { BatchItem, BatchPlan, ProgressUpdate } from "../../shared/contracts.ts";
import type { AppAction, AppError } from "../App.tsx";
import { formatBytes, formatChange } from "../lib/format.ts";
import { useWindowDrop } from "../lib/useWindowDrop.ts";
import { ProgressBar } from "./ProgressBar.tsx";

interface BatchViewProps {
  batch: BatchPlan;
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

function Row({
  item,
  progress,
  disabled,
  onReveal,
}: {
  item: BatchItem;
  progress: ProgressUpdate | null;
  disabled: boolean;
  onReveal(path: string): void;
}) {
  const cut = item.relativePath.lastIndexOf("/") + 1;
  const change =
    item.status === "done" && item.outputBytes !== undefined
      ? formatChange(item.sourceBytes, item.outputBytes)
      : null;
  const tone =
    item.status === "skipped" && item.message === NEEDS_BLENDER ? "blender" : item.status;
  return (
    <li className="batch-row" data-status={tone}>
      <StatusIcon item={item} />
      <div className="batch-file">
        <p className="batch-path" title={item.relativePath}>
          {cut > 0 && <span className="batch-dir">{item.relativePath.slice(0, cut)}</span>}
          <span className="batch-name">{item.relativePath.slice(cut)}</span>
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
        {item.modelPath && (
          <button
            type="button"
            className="icon-button"
            onClick={() => onReveal(item.modelPath!)}
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

  // Keep the model being processed in view, without animating the scroll.
  useEffect(() => {
    if (processing < 0) return;
    listRef.current?.children[processing]?.scrollIntoView({ block: "nearest" });
  }, [processing]);

  const summary = [
    done.length && `${done.length} optimized`,
    upToDate && `${upToDate} already up to date`,
    failed && `${failed} failed`,
  ].filter(Boolean);

  return (
    <section className="batch" aria-label="Folder">
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

      {items.length ? (
        <div className="batch-scroll">
          <div className="batch-columns" aria-hidden="true">
            <span />
            <span>File</span>
            <span>Source</span>
            <span>Web copy</span>
          </div>
          <ol className="batch-list" ref={listRef} aria-label="Models in this folder">
            {items.map((item, index) => (
              <Row
                key={item.relativePath}
                item={item}
                progress={index === processing ? progress : null}
                disabled={running}
                onReveal={onReveal}
              />
            ))}
          </ol>
        </div>
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
