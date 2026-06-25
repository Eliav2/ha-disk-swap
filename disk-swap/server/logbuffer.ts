/** Circular buffer that captures the last N log lines from console + spawned processes. */

const MAX_LINES = 100;
const lines: string[] = [];

// ANSI escape code regex for stripping colors
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function push(raw: string) {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines.push(trimmed.replace(ANSI_RE, ""));
    if (lines.length > MAX_LINES) lines.shift();
  }
}

// Intercept console.log/warn/error (Bun may not route these through process.stdout.write)
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

console.log = (...args: any[]) => { push(args.map(String).join(" ")); origLog(...args); };
console.warn = (...args: any[]) => { push(args.map(String).join(" ")); origWarn(...args); };
console.error = (...args: any[]) => { push(args.map(String).join(" ")); origError(...args); };

// Also intercept process.stdout/stderr for spawned process output (piped to inherit)
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = function (chunk: any, ...args: any[]) {
  push(typeof chunk === "string" ? chunk : chunk.toString());
  return (origStdoutWrite as any)(chunk, ...args);
};

process.stderr.write = function (chunk: any, ...args: any[]) {
  push(typeof chunk === "string" ? chunk : chunk.toString());
  return (origStderrWrite as any)(chunk, ...args);
};

/** Get the last N log lines. */
export function getLastLines(n: number): string[] {
  return lines.slice(-n);
}
