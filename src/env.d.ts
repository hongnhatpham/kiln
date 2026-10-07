/// <reference types="vite-plus/client" />
import type { KilnAPI } from "../shared/contracts.ts";

declare global {
  interface Window {
    /** Provided by the Electron preload. Absent when the renderer runs in a plain browser. */
    kiln?: KilnAPI;
  }
}
