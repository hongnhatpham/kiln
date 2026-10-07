import { validateBytes, version } from "gltf-validator";

export interface ValidationSummary {
  validator: string;
  errors: number;
  warnings: number;
  infos: number;
  /** First few errors and warnings, for the recipe and diagnosis. */
  issues: { code: string; message: string; severity: "error" | "warning"; pointer?: string }[];
}

/** Runs the Khronos glTF Validator on a self-contained GLB. */
export async function validateGlb(bytes: Uint8Array): Promise<ValidationSummary> {
  const report = await validateBytes(bytes, {
    format: "glb",
    maxIssues: 200,
    writeTimestamp: false,
  });
  const issues = report.issues.messages
    .filter((m) => m.severity <= 1)
    .slice(0, 20)
    .map((m) => ({
      code: m.code,
      message: m.message,
      severity: m.severity === 0 ? ("error" as const) : ("warning" as const),
      pointer: m.pointer,
    }));
  return {
    validator: `Khronos glTF Validator ${version()}`,
    errors: report.issues.numErrors,
    warnings: report.issues.numWarnings,
    infos: report.issues.numInfos,
    issues,
  };
}
