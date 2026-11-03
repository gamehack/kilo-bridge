export function createLogger(level = "info") {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const threshold = levels[level] ?? 1;
  return Object.fromEntries(Object.keys(levels).map((kind) => [kind, (event, fields = {}) => {
    if (levels[kind] < threshold) return;
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), level: kind, event, ...fields }) + "\n");
  }]));
}
