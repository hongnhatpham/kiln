import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetInfo,
  EnvironmentInfo,
  ExportReceipt,
  KilnAPI,
  OptimizationOptions,
  OptimizationResult,
  ProgressUpdate,
} from "../shared/contracts.ts";
import { PRESETS } from "../shared/presets.ts";
import { Header } from "./components/Header.tsx";
import { CatalogRecord } from "./components/CatalogRecord.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { Stage } from "./components/Stage.tsx";
import { errorMessage } from "./lib/format.ts";

export type Busy =
  | { kind: "import"; fileName: string | null }
  | { kind: "optimize" }
  | { kind: "export" };

export type AppAction = "choose" | "blender" | "retry-optimize" | "dismiss";
export interface AppError {
  title: string;
  message: string;
  actions: AppAction[];
}

const BLENDER_HINT = /blender/i;
/** 3D formats Kiln may read once Blender is linked. Anything else is not a model at all. */
const MODEL_EXTENSIONS = ["glb", "gltf", "usdz", "usd", "usdc", "usda", "obj", "fbx", "ply", "stl"];

export function App({ api, mock }: { api: KilnAPI; mock: boolean }) {
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [asset, setAsset] = useState<AssetInfo | null>(null);
  const [options, setOptions] = useState<OptimizationOptions>(PRESETS.detailed);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [receipt, setReceipt] = useState<ExportReceipt | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelling = useRef(false);

  useEffect(() => api.onProgress(setProgress), [api]);
  useEffect(() => {
    api.environment().then(setEnvironment, () => setEnvironment(null));
  }, [api]);

  const stale = useMemo(
    () => !!result && JSON.stringify(result.options) !== JSON.stringify(options),
    [result, options],
  );

  const run = useCallback(
    async <T,>(
      next: Busy,
      task: () => Promise<T>,
      fail: (message: string) => AppError,
    ): Promise<T | undefined> => {
      cancelling.current = false;
      setBusy(next);
      setProgress(null);
      setError(null);
      setNotice(null);
      try {
        return await task();
      } catch (caught) {
        if (cancelling.current)
          setNotice(
            next.kind === "import"
              ? "Import cancelled."
              : "Optimization cancelled. Your settings are kept.",
          );
        else setError(fail(errorMessage(caught)));
        return undefined;
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    [],
  );

  const openAsset = useCallback(
    async (load: () => Promise<AssetInfo | null>, fileName: string | null) => {
      const next = await run({ kind: "import", fileName }, load, (message) => ({
        title: "This file could not be opened",
        message,
        actions:
          BLENDER_HINT.test(message) && !environment?.blenderPath
            ? ["blender", "choose"]
            : ["choose"],
      }));
      if (!next) return;
      setAsset(next);
      setResult(null);
      setReceipt(null);
    },
    [run, environment],
  );

  const choose = useCallback(() => openAsset(() => api.chooseAsset(), null), [api, openAsset]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o" && !busy) {
        event.preventDefault();
        void choose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, choose]);

  const dropFile = useCallback(
    (file: File) => {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const supported = (environment?.supportedFormats ?? []).map((format) =>
        format.replace(/^\./, "").toLowerCase(),
      );
      if (supported.length && !supported.includes(extension)) {
        const needsBlender = !environment?.blenderPath && MODEL_EXTENSIONS.includes(extension);
        setError({
          title: `Kiln can't open .${extension} files yet`,
          message: needsBlender
            ? `Some formats are read through Blender. Locate Blender to add them, or open one of: ${supported.join(", ").toUpperCase()}.`
            : `Open one of: ${supported.join(", ").toUpperCase()}.`,
          actions: needsBlender ? ["blender", "choose"] : ["choose"],
        });
        return;
      }
      const path = api.filePath(file);
      if (!path) {
        setError({
          title: "Kiln couldn't find this file on disk",
          message: "Drop a file from a local folder, or choose it from the file browser.",
          actions: ["choose"],
        });
        return;
      }
      void openAsset(() => api.importAsset(path), file.name);
    },
    [api, environment, openAsset],
  );

  const optimize = useCallback(async () => {
    if (!asset) return;
    const next = await run(
      { kind: "optimize" },
      () => api.optimize(asset.id, options),
      (message) => ({
        title: "Optimization stopped",
        message,
        actions: ["retry-optimize", "dismiss"],
      }),
    );
    if (!next) return;
    setResult(next);
    setReceipt(null);
  }, [api, asset, options, run]);

  const exportResult = useCallback(async () => {
    if (!result) return;
    const saved = await run(
      { kind: "export" },
      () => api.exportResult(result.id),
      (message) => ({
        title: "Export failed",
        message,
        actions: ["dismiss"],
      }),
    );
    if (saved) setReceipt(saved);
  }, [api, result, run]);

  const cancel = useCallback(() => {
    cancelling.current = true;
    void api.cancel();
  }, [api]);

  const locateBlender = useCallback(async () => {
    try {
      const next = await api.setBlenderPath();
      setEnvironment(next);
      if (next.blenderPath) setError(null);
    } catch (caught) {
      setError({
        title: "Blender was not linked",
        message: errorMessage(caught),
        actions: ["blender", "dismiss"],
      });
    }
  }, [api]);

  const reveal = useCallback(
    (path: string) => {
      api.reveal(path).catch((caught: unknown) => setNotice(errorMessage(caught)));
    },
    [api],
  );

  const act = useCallback(
    (action: AppAction) => {
      if (action === "choose") void choose();
      else if (action === "blender") void locateBlender();
      else if (action === "retry-optimize") void optimize();
      else setError(null);
    },
    [choose, locateBlender, optimize],
  );

  return (
    <div className="app">
      <Header
        asset={asset}
        environment={environment}
        busy={!!busy}
        mock={mock}
        onChoose={choose}
        onLocateBlender={locateBlender}
      />
      <main className="workspace">
        <section className="workspace-main" aria-label="Preview and record">
          <Stage
            asset={asset}
            result={result}
            busy={busy}
            progress={progress}
            error={error}
            environment={environment}
            onDropFile={dropFile}
            onChoose={choose}
            onCancel={cancel}
            onAction={act}
          />
          {asset && (
            <CatalogRecord
              asset={asset}
              result={result}
              stale={stale}
              receipt={receipt}
              exporting={busy?.kind === "export"}
              disabled={!!busy}
              onExport={exportResult}
              onReveal={reveal}
            />
          )}
        </section>
        <SettingsPanel
          asset={asset}
          options={options}
          result={result}
          stale={stale}
          busy={busy}
          progress={progress}
          notice={notice}
          onChange={setOptions}
          onOptimize={optimize}
          onCancel={cancel}
        />
      </main>
    </div>
  );
}
