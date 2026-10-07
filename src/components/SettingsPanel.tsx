import { ChevronDown, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type {
  AssetInfo,
  OptimizationOptions,
  OptimizationResult,
  ProgressUpdate,
  TextureFormat,
} from "../../shared/contracts.ts";
import { PRESETS } from "../../shared/presets.ts";
import type { Busy } from "../App.tsx";
import { formatBytes, formatCount, formatPixels } from "../lib/format.ts";
import {
  estimateGpuBytes,
  expectedExtensions,
  FORMAT_COPY,
  normalRisk,
  PRESET_COPY,
  PRESET_ORDER,
  presetFor,
  presetSpec,
  qualityApplies,
  roleTexture,
  viewerNeeds,
  type FixedPreset,
  type MapRole,
} from "../lib/options.ts";
import { RangeField, Segmented, SizeSelect, Switch } from "./Controls.tsx";
import { ProgressBar } from "./ProgressBar.tsx";

interface PanelProps {
  asset: AssetInfo | null;
  options: OptimizationOptions;
  result: OptimizationResult | null;
  stale: boolean;
  busy: Busy | null;
  progress: ProgressUpdate | null;
  notice: string | null;
  onChange(options: OptimizationOptions): void;
  onOptimize(): void;
  onCancel(): void;
}

// Shape tolerance uses a log scale: 0.01% to 5% of the object's size.
const TOLERANCE_MIN = Math.log10(0.0001);
const TOLERANCE_MAX = Math.log10(0.05);

const MAP_COPY: Record<
  MapRole,
  {
    name: string;
    size: "colorSize" | "normalSize" | "aoSize";
    quality: "colorQuality" | "normalQuality" | "aoQuality";
  }
> = {
  color: { name: "Color", size: "colorSize", quality: "colorQuality" },
  normal: { name: "Normal", size: "normalSize", quality: "normalQuality" },
  ao: { name: "Ambient occlusion", size: "aoSize", quality: "aoQuality" },
};

function formatLength(meters: number): string {
  if (meters < 0.001) return `${(meters * 1000).toFixed(2)} mm`;
  if (meters < 0.01) return `${(meters * 1000).toFixed(1)} mm`;
  if (meters < 1) return `${(meters * 100).toFixed(1)} cm`;
  return `${meters.toFixed(2)} m`;
}

export function SettingsPanel({
  asset,
  options,
  result,
  stale,
  busy,
  progress,
  notice,
  onChange,
  onOptimize,
  onCancel,
}: PanelProps) {
  const preset = presetFor(options);
  const [lastPreset, setLastPreset] = useState<FixedPreset>("detailed");
  const [advanced, setAdvanced] = useState(false);
  const advancedId = useId();
  const set = <K extends keyof OptimizationOptions>(key: K, value: OptimizationOptions[K]) =>
    onChange({ ...options, [key]: value });
  const choosePreset = (id: FixedPreset) => {
    setLastPreset(id);
    onChange({ ...PRESETS[id] });
  };

  const optimizing = busy?.kind === "optimize";
  const extent = asset ? Math.max(...asset.dimensions) : 0;
  const estimate = asset ? estimateGpuBytes(asset, options) : 0;
  const needs = viewerNeeds(
    result && !stale ? result.requiredExtensions : expectedExtensions(asset, options),
  );
  const toleranceSlider =
    ((Math.log10(options.simplifyError) - TOLERANCE_MIN) / (TOLERANCE_MAX - TOLERANCE_MIN)) * 100;
  const risk = normalRisk(options);
  // A map is resized when its limit is below the source size (or the source is not known yet).
  const resized = (role: MapRole) => {
    const limit = options[MAP_COPY[role].size];
    const source = roleTexture(asset, role);
    return limit !== 0 && (!source || Math.max(source.width, source.height) > limit);
  };
  const anyResized = (["color", "normal", "ao"] as MapRole[]).some(resized);

  const qualityDisplay = (role: MapRole) => {
    if (options.losslessTextures || (role === "normal" && options.normalLossless))
      return "Lossless";
    if (options.textureFormat === "png") return "PNG, lossless";
    return String(options[MAP_COPY[role].quality]);
  };

  const sourceNote = (role: MapRole) => {
    const texture = roleTexture(asset, role);
    if (!texture) return asset ? "Not in source" : null;
    const format = texture.mimeType.replace("image/", "").toUpperCase();
    return `Source ${formatPixels(Math.max(texture.width, texture.height))} ${format}, ${formatBytes(texture.bytes)}`;
  };

  return (
    <aside className="panel" aria-label="Optimization settings">
      <fieldset className="panel-scroll" disabled={optimizing}>
        <section className="panel-section">
          <h2 className="section-title">Preset</h2>
          <fieldset className="presets">
            <legend className="sr-only">Preset</legend>
            {PRESET_ORDER.map((id) => (
              <label key={id} className="preset" data-selected={preset === id || undefined}>
                <input
                  type="radio"
                  name="preset"
                  value={id}
                  checked={preset === id}
                  onChange={() => choosePreset(id)}
                />
                <span className="preset-name">{PRESET_COPY[id].name}</span>
                <span className="preset-purpose">{PRESET_COPY[id].purpose}</span>
                <span className="preset-spec">{presetSpec(PRESETS[id])}</span>
              </label>
            ))}
          </fieldset>
          {preset === "custom" && (
            <p className="custom-note">
              Custom settings
              <button type="button" className="link" onClick={() => choosePreset(lastPreset)}>
                Back to {PRESET_COPY[lastPreset].name}
              </button>
            </p>
          )}
        </section>

        <section className="panel-section">
          <button
            type="button"
            className="disclosure"
            aria-expanded={advanced}
            aria-controls={advancedId}
            onClick={() => setAdvanced((open) => !open)}
          >
            Advanced settings
            <ChevronDown size={16} aria-hidden="true" />
          </button>

          <div id={advancedId} className="advanced" hidden={!advanced}>
            <div className="group">
              <h3 className="group-title">Textures</h3>
              <Segmented<TextureFormat>
                label="Texture format"
                value={options.textureFormat}
                onChange={(value) => set("textureFormat", value)}
                options={(Object.keys(FORMAT_COPY) as TextureFormat[]).map((value) => {
                  const blocked = value === "jpeg" && options.losslessTextures;
                  return {
                    value,
                    label: FORMAT_COPY[value].label,
                    title: blocked ? "JPEG has no lossless mode" : FORMAT_COPY[value].hint,
                    disabled: blocked,
                  };
                })}
              />
              <p className="field-hint">{FORMAT_COPY[options.textureFormat].hint}</p>
              <Switch
                label="All textures lossless"
                checked={options.losslessTextures}
                onChange={(value) =>
                  onChange({
                    ...options,
                    losslessTextures: value,
                    textureFormat:
                      value && options.textureFormat === "jpeg" ? "webp" : options.textureFormat,
                  })
                }
                hint={
                  !options.losslessTextures
                    ? "Color and AO use the quality settings below."
                    : anyResized
                      ? "Encoding adds no further loss. Maps set below their original size still lose detail from resizing."
                      : "Encoding adds no loss. Every map keeps its original pixels."
                }
              />
            </div>

            {(["color", "normal", "ao"] as MapRole[]).map((role) => (
              <div className="group" key={role}>
                <div className="group-head">
                  <h3 className="group-title">{MAP_COPY[role].name}</h3>
                  <span className="group-note">{sourceNote(role)}</span>
                </div>
                <SizeSelect
                  label="Size"
                  value={options[MAP_COPY[role].size]}
                  sourceSize={roleTexture(asset, role)?.width ?? null}
                  onChange={(value) => set(MAP_COPY[role].size, value)}
                />
                {role === "normal" && (
                  <Switch
                    label="Lossless normal map"
                    checked={options.normalLossless || options.losslessTextures}
                    disabled={options.losslessTextures}
                    onChange={(value) => set("normalLossless", value)}
                    hint={
                      !options.normalLossless && !options.losslessTextures
                        ? "Uses the quality setting below. Lossless is safer for close-up study."
                        : options.textureFormat === "jpeg"
                          ? "JPEG has no lossless mode, so the normal map is kept in a lossless format."
                          : resized("normal")
                            ? "No extra compression loss after resizing. Recommended for close-up study."
                            : "Keeps the original surface relief exactly. Recommended for close-up study."
                    }
                  />
                )}
                <RangeField
                  label="Quality"
                  value={options[MAP_COPY[role].quality]}
                  display={qualityDisplay(role)}
                  min={50}
                  max={100}
                  step={1}
                  disabled={!qualityApplies(options, role)}
                  onChange={(value) => set(MAP_COPY[role].quality, value)}
                />
                {role === "normal" && risk && (
                  <p className="risk">
                    <TriangleAlert size={14} aria-hidden="true" />
                    {risk}
                  </p>
                )}
              </div>
            ))}

            <div className="group">
              <h3 className="group-title">Geometry</h3>
              <Segmented<OptimizationOptions["meshCompression"]>
                label="Mesh compression"
                value={options.meshCompression}
                onChange={(value) => set("meshCompression", value)}
                options={[
                  { value: "none", label: "None" },
                  { value: "meshopt", label: "Meshopt" },
                ]}
              />
              <p className="field-hint">
                {options.meshCompression === "meshopt"
                  ? "Smaller download with exact geometry. Viewers need the meshopt decoder."
                  : "Plain geometry. Opens in any glTF viewer."}
              </p>
              <RangeField
                label="Keep triangles"
                value={Math.round(options.simplifyRatio * 100)}
                display={
                  asset
                    ? `${Math.round(options.simplifyRatio * 100)}%, ${formatCount(asset.triangles * options.simplifyRatio)}`
                    : `${Math.round(options.simplifyRatio * 100)}%`
                }
                min={5}
                max={100}
                step={1}
                onChange={(value) => set("simplifyRatio", value / 100)}
                hint={
                  options.simplifyRatio < 1
                    ? "Fewer triangles can soften silhouettes and edges. Detail in the normal map stays."
                    : "All triangles kept. Scans are usually limited by texture size, not geometry."
                }
              />
              <RangeField
                label="Shape tolerance"
                value={toleranceSlider}
                display={`${(options.simplifyError * 100).toFixed(options.simplifyError < 0.001 ? 2 : 1)}%${extent ? `, about ${formatLength(options.simplifyError * extent)}` : ""}`}
                min={0}
                max={100}
                step={1}
                disabled={options.simplifyRatio >= 1}
                onChange={(value) =>
                  set(
                    "simplifyError",
                    Number(
                      (
                        10 **
                        (TOLERANCE_MIN + (value / 100) * (TOLERANCE_MAX - TOLERANCE_MIN))
                      ).toPrecision(2),
                    ),
                  )
                }
                hint="How far the surface may move while removing triangles, as a share of the object's size."
              />
              <Switch
                label="Quantize geometry"
                checked={options.quantize}
                onChange={(value) => set("quantize", value)}
                hint="Stores positions and UVs with fewer bits. Smaller file, tiny rounding. Viewers need quantized geometry support."
              />
            </div>

            <div className="group">
              <h3 className="group-title">File</h3>
              <Switch
                label="Preserve metadata"
                checked={options.preserveMetadata}
                onChange={(value) => set("preserveMetadata", value)}
                hint="Keeps object names, custom properties, and rights notes from the source."
              />
            </div>
          </div>
        </section>
      </fieldset>

      <footer className="panel-footer">
        {asset && (
          <dl className="estimate">
            <div>
              <dt>Graphics memory</dt>
              <dd>
                <span className="estimate-from">{formatBytes(asset.gpuBytes)}</span>
                <span aria-label="to">→</span>
                <strong>{formatBytes(result && !stale ? result.gpuBytes : estimate)}</strong>
                {!(result && !stale) && <span className="estimate-tag">estimate</span>}
              </dd>
            </div>
            <div>
              <dt>Viewer needs</dt>
              <dd>{needs.length ? needs.join(", ") : "Any glTF viewer"}</dd>
            </div>
          </dl>
        )}

        {optimizing ? (
          <div className="working" role="status" aria-live="polite">
            <div className="working-row">
              <span>{progress?.message ?? "Starting"}</span>
              {progress && <span className="working-percent">{progress.percent}%</span>}
            </div>
            <ProgressBar value={progress ? progress.percent / 100 : null} />
            <button type="button" className="button button-quiet button-block" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={
                result && !stale
                  ? "button button-quiet button-block"
                  : "button button-primary button-block"
              }
              onClick={onOptimize}
              disabled={!asset || !!busy || (!!result && !stale)}
            >
              {result ? "Optimize again" : "Optimize"}
            </button>
            <p className="footer-note" role="status">
              {notice ??
                (!asset
                  ? "Open an asset to begin."
                  : result && !stale
                    ? "Compare in the viewer, then export the result. Change a setting to try again."
                    : result
                      ? "Settings changed since the last result."
                      : "Runs on this computer. The original file is not changed.")}
            </p>
          </>
        )}
      </footer>
    </aside>
  );
}
