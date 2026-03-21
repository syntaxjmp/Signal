/** Basename with forward slashes only (for matching extensions). */
export function basenameOnly(pathOrName: string): string {
  const s = pathOrName.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Public `/…png` under `frontend/public` for known languages / Docker only.
 * Unknown extensions return `null` (no generic icon — `file.png` in this repo is a PDF-style asset).
 */
export function fileIconSrcForPathOrName(pathOrName: string): string | null {
  const raw = pathOrName?.trim();
  if (!raw) return null;
  const base = basenameOnly(raw).toLowerCase();
  if (base === "dockerfile" || /^dockerfile(\.[^/]+)?$/.test(base)) return "/docker.png";
  const m = base.match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1];
  switch (ext) {
    case "py":
      return "/python.png";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "/js.png";
    case "ts":
    case "tsx":
      return "/typescript.png";
    case "rs":
      return "/rust.png";
    default:
      return null;
  }
}

/**
 * Like {@link fileIconSrcForPathOrName}, but only when the string is plausibly a path or
 * single filename (not a sentence that happens to mention `file.py` at the end).
 */
export function fileIconSrcForDisplay(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const src = fileIconSrcForPathOrName(t);
  if (!src) return null;
  if (t.includes("/") || t.includes("\\")) return src;
  if (!/\s/.test(t)) return src;
  return null;
}
