import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetInfo,
  BatchPlan,
  EnvironmentInfo,
  ExportReceipt,
  KilnAPI,
  OptimizationOptions,
  OptimizationResult,
  ProgressUpdate,
} from "../shared/contracts.ts";
import { PRESETS } from "../shared/presets.ts";
import { BatchView } from "./components/BatchView.tsx";
import { Header } from "./components/Header.tsx";
import { CatalogRecord } from "./components/CatalogRecord.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { Stage } from "./components/Stage.tsx";
import { errorMessage } from "./lib/format.ts";

export type Busy =
  | { kind: "import"; fileName: string | null }
  | { kind: "optimize" }
  | { kind: "export" }
  | { kind: "scan" }
  | { kind: "batch" };

export type AppAction = "choose" | "choose-folder" | "blender" | "retry-optimize" | "dismiss";
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
  /** A folder being processed. While set, it replaces the single-model stage. */
  const [batch, setBatch] = useState<BatchPlan | null>(null);
  /** Settings of the last folder run, to tell when a re-run would change the results. */
  const [batchOptions, setBatchOptions] = useState<OptimizationOptions | null>(null);
  /** The folder model shown on the stage, by its path in the folder. */
  const [previewing, setPreviewing] = useState<string | null>(null);
  const cancelling = useRef(false);

  useEffect(() => api.onProgress(setProgress), [api]);
  useEffect(
    () =>
      api.onBatch((update) => {
        // Each model starts its own progress from zero.
        if (update.item.status === "processing") setProgress(null);
        setBatch((current) =>
          current?.id === update.batchId
            ? {
                ...current,
                items: current.items.map((item, index) =>
                  index === update.index ? update.item : item,
                ),
              }
            : current,
        );
      }),
    [api],
  );
  useEffect(() => {
    api.environment().then(setEnvironment, () => setEnvironment(null));
  }, [api]);

  const stale = useMemo(
    () => !!result && JSON.stringify(result.options) !== JSON.stringify(options),
    [result, options],
  );
  const batchStale = useMemo(
    () => !!batchOptions && JSON.stringify(batchOptions) !== JSON.stringify(options),
    [batchOptions, options],
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
      setBatch(null);
      setPreviewing(null);
    },
    [run, environment],
  );

  const choose = useCallback(() => openAsset(() => api.chooseAsset(), null), [api, openAsset]);

  const openFolder = useCallback(
    async (load: () => Promise<BatchPlan | null>) => {
      const next = await run({ kind: "scan" }, load, (message) => ({
        title: "This folder could not be read",
        message,
        actions: ["choose-folder"],
      }));
      if (!next) return;
      setBatch(next);
      setBatchOptions(null);
      setPreviewing(null);
      setAsset(null);
      setResult(null);
      setReceipt(null);
    },
    [run],
  );

  const chooseFolder = useCallback(
    () => openFolder(() => api.chooseBatchFolder()),
    [api, openFolder],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o" && !busy) {
        event.preventDefault();
        void (event.shiftKey ? chooseFolder() : choose());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, choose, chooseFolder]);

  const drop = useCallback(
    (file: File, isFolder: boolean) => {
      if (isFolder) {
        const path = api.filePath(file);
        if (path) void openFolder(() => api.planBatch(path));
        else
          setError({
            title: "Kiln couldn't find this folder on disk",
            message: "Drop a folder from a local drive, or choose it from the file browser.",
            actions: ["choose-folder"],
          });
        return;
      }
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
    [api, environment, openAsset, openFolder],
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

  const processFolder = useCallback(async () => {
    if (!batch) return;
    const used = options;
    // Every model is checked again on each run, so start the list fresh. Earlier previews stay
    // viewable until their model is processed again.
    setBatch({
      ...batch,
      items: batch.items.map(({ relativePath, sourceBytes, preview }) => ({
        relativePath,
        sourceBytes,
        status: "waiting",
        preview,
      })),
    });
    const final = await run(
      { kind: "batch" },
      () => api.runBatch(batch.id, used),
      (message) => ({ title: "Processing stopped", message, actions: ["dismiss"] }),
    );
    if (!final) return;
    setBatch(final);
    setBatchOptions(used);
    if (cancelling.current)
      setNotice("Stopped. Process again to continue. Finished models are kept and skipped.");
  }, [api, batch, options, run]);

  const changeOutput = useCallback(async () => {
    if (!batch) return;
    try {
      const next = await api.chooseBatchOutput(batch.id);
      if (next) setBatch(next);
    } catch (caught) {
      setError({
        title: "This output folder can't be used",
        message: errorMessage(caught),
        actions: ["dismiss"],
      });
    }
  }, [api, batch]);

  const closeFolder = useCallback(() => {
    setBatch(null);
    setBatchOptions(null);
    setPreviewing(null);
    setError(null);
    setNotice(null);
  }, []);

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
      else if (action === "choose-folder") void chooseFolder();
      else if (action === "blender") void locateBlender();
      else if (action === "retry-optimize") void optimize();
      else setError(null);
    },
    [choose, chooseFolder, locateBlender, optimize],
  );

  const preview = batch?.items.find((item) => item.relativePath === previewing)?.preview ?? null;

  return (
    <div className="app">
      <Header
        asset={asset}
        folder={batch?.sourceDir ?? null}
        environment={environment}
        busy={!!busy}
        mock={mock}
        onChoose={choose}
        onChooseFolder={chooseFolder}
        onLocateBlender={locateBlender}
      />
      <main className="workspace">
        {batch ? (
          <BatchView
            batch={batch}
            previewing={previewing}
            onPreview={setPreviewing}
            stage={
              preview && (
                <Stage
                  folder
                  asset={preview.asset}
                  result={preview.result}
                  busy={busy}
                  progress={null}
                  error={null}
                  environment={environment}
                  onDrop={drop}
                  onChoose={choose}
                  onChooseFolder={chooseFolder}
                  onCancel={cancel}
                  onAction={act}
                />
              )
            }
            running={busy?.kind === "batch"}
            disabled={!!busy}
            progress={progress}
            error={error}
            blenderLinked={!!environment?.blenderPath}
            onDrop={drop}
            onChangeOutput={changeOutput}
            onChooseFolder={chooseFolder}
            onClose={closeFolder}
            onReveal={reveal}
            onLocateBlender={locateBlender}
            onAction={act}
          />
        ) : (
          <section className="workspace-main" aria-label="Preview and record">
            <Stage
              asset={asset}
              result={result}
              busy={busy}
              progress={progress}
              error={error}
              environment={environment}
              onDrop={drop}
              onChoose={choose}
              onChooseFolder={chooseFolder}
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
        )}
        <SettingsPanel
          asset={asset}
          batch={batch}
          batchStale={batchStale}
          options={options}
          result={result}
          stale={stale}
          busy={busy}
          progress={progress}
          notice={notice}
          onChange={setOptions}
          onOptimize={batch ? processFolder : optimize}
          onCancel={cancel}
        />
      </main>
    </div>
  );
}
