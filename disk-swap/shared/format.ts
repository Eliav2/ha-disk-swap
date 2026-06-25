export function formatBytes(bytes: number): string {
  const GB = 1024 ** 3;
  const TB = 1024 ** 4;
  if (bytes >= TB) return `${(bytes / TB).toFixed(1)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  const MB = 1024 ** 2;
  return `${Math.round(bytes / MB)} MB`;
}
