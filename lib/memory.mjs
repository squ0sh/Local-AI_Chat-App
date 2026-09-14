// Pure helpers for deciding whether resident models should be evicted to make
// room for a newly requested model. No side effects (kept import-free so they
// are trivially unit-testable).

function normalizedName(value) {
  return String(value || '').toLowerCase().trim().replace(/:latest$/i, '').replace(/:.*$/, '');
}

export function shouldFreeMemory(loaded, requestedName, { totalmem, freemem } = {}) {
  const total = Number(totalmem) || 0;
  const free = Number(freemem) || 0;
  if (!total || !Array.isArray(loaded) || !loaded.length) return false;
  if (loaded.some((m) => normalizedName(m.name) === normalizedName(requestedName))) return false;
  const loadedTotal = loaded.reduce((sum, m) => sum + Number(m.size || 0), 0);
  const projectedUsed = total - free + loadedTotal;
  return projectedUsed > total - 0.75 * 2 ** 30;
}

export function otherModelNames(loaded, requestedName) {
  const requested = normalizedName(requestedName);
  return (Array.isArray(loaded) ? loaded : [])
    .filter((m) => normalizedName(m.name) !== requested)
    .map((m) => m.name);
}