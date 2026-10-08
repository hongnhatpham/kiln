import { useEffect, useState } from "react";

/**
 * Files and folders can be dropped anywhere in the window. Returns whether something is being
 * dragged over it. Always prevents the default drop, which would navigate the window to the file.
 * Pass null when an enclosing view already handles drops.
 */
export function useWindowDrop(
  busy: boolean,
  onDrop: ((file: File, isFolder: boolean) => void) | null,
): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!onDrop) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (!busy) setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? "none" : "copy";
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      const isFolder = !!event.dataTransfer?.items[0]?.webkitGetAsEntry()?.isDirectory;
      if (file && !busy) onDrop(file, isFolder);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [busy, onDrop]);
  return dragging;
}
