import type { KilnAPI } from "../shared/contracts.ts";

/**
 * The desktop bridge. In a plain browser during development, a mock backed by real GLB files
 * stands in so the interface can be exercised before the engine is attached.
 */
export async function loadApi(): Promise<{ api: KilnAPI; mock: boolean } | null> {
  if (window.kiln) return { api: window.kiln, mock: false };
  if (import.meta.env.DEV) {
    const { createMockKiln } = await import("./dev/mockKiln.ts");
    return { api: createMockKiln(new URLSearchParams(window.location.search)), mock: true };
  }
  return null;
}
