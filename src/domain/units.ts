/**
 * Formatting shared by the human renderer and the finding text itself. Numbers
 * in a performance report are read by eye, not parsed: `1,240,000` lands where
 * `1240000` does not, and `89MB` lands where `93323264` does not. The raw values
 * stay available in `--json` for anything that needs to compute on them.
 */

/** `1240000` -> `1,240,000`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Binary units, because that is what MongoDB's own limits are quoted in: the
 * 100MB sort limit is `104857600` bytes.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}${units[unit]}`;
}

/** Sub-second stays in milliseconds; past that, seconds with one decimal. */
export function formatDuration(millis: number): string {
  if (millis < 1000) return `${Math.round(millis)}ms`;
  return `${(millis / 1000).toFixed(1)}s`;
}

/** `400.0` -> `400:1`. Ratios below 10 keep a decimal; above it they do not. */
export function formatRatio(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}:1` : `${ratio.toFixed(1)}:1`;
}

/** Pluralises without a dependency. `1 finding` / `2 findings`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Values printed the way MongoDB users write them — `{ status: 1, createdAt: -1 }`,
 * unquoted keys — so a key pattern in a finding can be pasted into a shell or
 * matched by eye against the index list. Falls back to strict JSON for anything
 * that would not survive the loss of quotes.
 */
export function formatShellValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[ ${value.map(formatShellValue).join(', ')} ]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const body = entries
      .map(([key, inner]) => `${isBareKey(key) ? key : JSON.stringify(key)}: ${formatShellValue(inner)}`)
      .join(', ');
    return `{ ${body} }`;
  }
  return JSON.stringify(value) ?? String(value);
}

function isBareKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}
