import { Check, Download, FolderOpen, Info, TriangleAlert } from "lucide-react";
import type {
  AssetInfo,
  ExportReceipt,
  OptimizationResult,
  TextureInfo,
} from "../../shared/contracts.ts";
import {
  formatBytes,
  formatChange,
  formatCount,
  formatDimensions,
  formatDuration,
  formatPixels,
} from "../lib/format.ts";
import { viewerNeeds } from "../lib/options.ts";

interface RecordProps {
  asset: AssetInfo;
  result: OptimizationResult | null;
  stale: boolean;
  receipt: ExportReceipt | null;
  exporting: boolean;
  disabled: boolean;
  onExport(): void;
  onReveal(path: string): void;
}

/** Result messages that inform rather than warn. Viewer needs already lists meshopt. */
const RESULT_NOTE = /^(Needs a viewer with meshopt support|Simplified to )/;

const ROLE_ORDER: TextureInfo["role"][] = ["color", "normal", "ao", "other"];

/** "8K, 8K, 4K WebP": map sizes in color, normal, AO order plus the formats used. */
function textureSummary(textures: TextureInfo[]): string {
  if (!textures.length) return "None";
  const sorted = [...textures].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  const sizes = sorted.map((t) => formatPixels(Math.max(t.width, t.height))).join(", ");
  const formats = [
    ...new Set(
      sorted.map((t) => t.mimeType.replace("image/", "").toUpperCase().replace("JPEG", "JPG")),
    ),
  ].join(" + ");
  return `${sizes} ${formats}`;
}

/** Let long scan IDs like ARCH_0042_OBJ_12 wrap at their separators instead of mid-word. */
function breakable(text: string) {
  return text
    .split(/(?<=[_\-.])/)
    .flatMap((part, index) => (index ? [<wbr key={index} />, part] : [part]));
}

const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;

function Change({ before, after }: { before: number; after: number }) {
  const change = formatChange(before, after);
  return (
    <td className="ledger-change" data-tone={change.tone}>
      {change.text}
    </td>
  );
}

export function CatalogRecord({
  asset,
  result,
  stale,
  receipt,
  exporting,
  disabled,
  onExport,
  onReveal,
}: RecordProps) {
  const title = asset.name.replace(/\.[^.]+$/, "");
  const extension = asset.name.split(".").pop()?.toUpperCase() ?? "";
  // Source warnings stay visible for context, but once a result exists they describe the master, not the export.
  const warnings: { scope: "Source" | "Optimized"; text: string; tone: "warn" | "note" }[] = [
    ...asset.warnings.map((text) => ({
      scope: "Source" as const,
      text,
      tone: result ? ("note" as const) : ("warn" as const),
    })),
    ...(result?.warnings ?? []).map((text) => ({
      scope: "Optimized" as const,
      text,
      tone: RESULT_NOTE.test(text) ? ("note" as const) : ("warn" as const),
    })),
  ];

  return (
    <section className="record" aria-label="Asset record">
      <div className="record-head">
        <h2 className="record-title" title={asset.name}>
          {breakable(title)}
        </h2>
        <p className="record-meta">
          {extension} source, {formatDimensions(asset.dimensions)}
        </p>
        <p className="record-path" title={asset.sourcePath}>
          {asset.sourcePath}
        </p>
      </div>

      {result ? (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Measure</span>
              </th>
              <th scope="col">Source</th>
              <th scope="col">Optimized</th>
              <th scope="col">
                <span className="sr-only">Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">File size</th>
              <td>{formatBytes(asset.sourceBytes)}</td>
              <td className="ledger-strong">{formatBytes(result.bytes)}</td>
              <Change before={asset.sourceBytes} after={result.bytes} />
            </tr>
            <tr>
              <th
                scope="row"
                title="Decoded textures with mipmaps plus geometry. What a viewer must hold in graphics memory."
              >
                Graphics memory
              </th>
              <td>{formatBytes(asset.gpuBytes)}</td>
              <td className="ledger-strong">{formatBytes(result.gpuBytes)}</td>
              <Change before={asset.gpuBytes} after={result.gpuBytes} />
            </tr>
            <tr>
              <th scope="row">Triangles</th>
              <td>{formatCount(asset.triangles)}</td>
              <td className="ledger-strong">{formatCount(result.triangles)}</td>
              <Change before={asset.triangles} after={result.triangles} />
            </tr>
            <tr>
              <th scope="row" title="Map sizes in color, normal, ambient occlusion order">
                Textures
              </th>
              <td>{textureSummary(asset.textures)}</td>
              <td className="ledger-strong">{textureSummary(result.textures)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      ) : (
        <dl className="facts">
          <div>
            <dt>File size</dt>
            <dd>{formatBytes(asset.sourceBytes)}</dd>
          </div>
          <div>
            <dt>Triangles</dt>
            <dd>{formatCount(asset.triangles)}</dd>
          </div>
          <div>
            <dt>Vertices</dt>
            <dd>{formatCount(asset.vertices)}</dd>
          </div>
          <div>
            <dt>Textures</dt>
            <dd>{textureSummary(asset.textures)}</dd>
          </div>
          <div>
            <dt>Graphics memory</dt>
            <dd>{formatBytes(asset.gpuBytes)}</dd>
          </div>
          <div>
            <dt>Structure</dt>
            <dd>
              {asset.meshCount} {asset.meshCount === 1 ? "mesh" : "meshes"}, {asset.materials}{" "}
              {asset.materials === 1 ? "material" : "materials"}
            </dd>
          </div>
        </dl>
      )}

      {result && (
        <div className="export">
          <dl className="export-facts">
            <div>
              <dt>Processed in</dt>
              <dd>{formatDuration(result.elapsedMs)}</dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd data-tone={result.validationErrors ? "warn" : "ok"}>
                {result.validationErrors
                  ? `${result.validationErrors} glTF errors`
                  : "Passes glTF validator"}
              </dd>
            </div>
            <div>
              <dt>Viewer needs</dt>
              <dd>{viewerNeeds(result.requiredExtensions).join(", ") || "Any glTF viewer"}</dd>
            </div>
          </dl>
          {receipt ? (
            <div className="receipt" role="status">
              <p className="receipt-line">
                <Check size={15} aria-hidden="true" />
                Saved {fileName(receipt.modelPath)}
              </p>
              <p className="receipt-sub">
                Recipe saved beside it as {fileName(receipt.recipePath)}
              </p>
              <div className="receipt-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => onReveal(receipt.modelPath)}
                >
                  <FolderOpen size={15} aria-hidden="true" />
                  Show in folder
                </button>
                <button type="button" className="link" onClick={onExport} disabled={disabled}>
                  Export again
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="button button-primary button-block"
                onClick={onExport}
                disabled={disabled}
              >
                <Download size={15} aria-hidden="true" />
                {exporting ? "Exporting" : "Export GLB"}
              </button>
              <p className="export-note">
                {stale
                  ? "Exports the result shown in the viewer, not the changed settings."
                  : "Saves the model and its recipe. The source stays untouched."}
              </p>
            </>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((warning) => (
            <li key={`${warning.scope}:${warning.text}`} data-tone={warning.tone}>
              {warning.tone === "warn" ? (
                <TriangleAlert size={13} aria-hidden="true" />
              ) : (
                <Info size={13} aria-hidden="true" />
              )}
              <span>
                <strong>{warning.scope}:</strong> {warning.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
