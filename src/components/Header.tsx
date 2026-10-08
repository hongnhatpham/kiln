import { FolderOpen, FolderTree, Link2 } from "lucide-react";
import type { AssetInfo, EnvironmentInfo } from "../../shared/contracts.ts";
import { KilnMark } from "./KilnMark.tsx";

interface HeaderProps {
  asset: AssetInfo | null;
  /** The folder being processed, when one is open. */
  folder: string | null;
  environment: EnvironmentInfo | null;
  busy: boolean;
  mock: boolean;
  onChoose(): void;
  onChooseFolder(): void;
  onLocateBlender(): void;
}

export function Header({
  asset,
  folder,
  environment,
  busy,
  mock,
  onChoose,
  onChooseFolder,
  onLocateBlender,
}: HeaderProps) {
  const blender = environment?.blenderPath;
  const open = folder
    ? { name: folder.split(/[/\\]/).filter(Boolean).pop() ?? folder, path: folder }
    : asset
      ? { name: asset.name, path: asset.sourcePath }
      : null;
  return (
    <header className="header">
      <div className="brand">
        <KilnMark />
        <span className="brand-name">Kiln</span>
      </div>
      {open && (
        <div className="header-asset" title={open.path}>
          <span className="header-divider" aria-hidden="true" />
          <span className="header-asset-name">{open.name}</span>
        </div>
      )}
      <div className="header-actions">
        {mock && (
          <span
            className="chip chip-dev"
            title="Running in a browser with sample data. Optimization results are not real."
          >
            Development mock
          </span>
        )}
        {environment && (
          <button
            type="button"
            className="chip"
            data-state={blender ? "linked" : "missing"}
            onClick={onLocateBlender}
            disabled={busy}
            title={
              blender
                ? `Blender: ${blender}. Click to choose a different copy.`
                : "USD and FBX files are read through Blender. Click to locate it."
            }
          >
            <Link2 size={13} aria-hidden="true" />
            {blender ? "Blender linked" : "Locate Blender"}
          </button>
        )}
        <button
          type="button"
          className="button button-quiet"
          onClick={onChooseFolder}
          disabled={busy}
          title="Process every model in a folder and its subfolders (Ctrl+Shift+O)"
        >
          <FolderTree size={15} aria-hidden="true" />
          Open folder
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={onChoose}
          disabled={busy}
          title="Open asset (Ctrl+O)"
        >
          <FolderOpen size={15} aria-hidden="true" />
          Open asset
        </button>
      </div>
    </header>
  );
}
