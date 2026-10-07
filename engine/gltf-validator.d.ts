declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    severity: number;
    pointer?: string;
    offset?: number;
  }
  export interface ValidationReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidationMessage[];
      truncated: boolean;
    };
    info?: { extensionsUsed?: string[]; extensionsRequired?: string[] };
  }
  export interface ValidationOptions {
    uri?: string;
    format?: "glb" | "gltf";
    maxIssues?: number;
    ignoredIssues?: string[];
    severityOverrides?: Record<string, number>;
    externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
    writeTimestamp?: boolean;
  }
  export function validateBytes(
    data: Uint8Array,
    options?: ValidationOptions,
  ): Promise<ValidationReport>;
  export function version(): string;
}
