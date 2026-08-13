/** Small display formatters shared by the panels. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeAgo(mtimeSeconds: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - mtimeSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** 1.234 -> "1.23 m", 0.061 -> "6.1 cm" */
export function formatMetres(metres: number): string {
  const abs = Math.abs(metres);
  if (abs >= 1) return `${metres.toFixed(2)} m`;
  return `${(metres * 100).toFixed(1)} cm`;
}

export function formatVec(vec: [number, number, number] | null): string {
  if (!vec) return "—";
  return vec.map(formatMetres).join(" × ");
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count);
}
