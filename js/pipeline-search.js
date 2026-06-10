function normalizeSearchText(value = "") {
  return value.trim().toLowerCase();
}

function getPipelineMatchScore(pipeline, normalizedQuery) {
  if (!normalizedQuery) {
    return 0;
  }

  const shortName = normalizeSearchText(pipeline.name);
  const fullName = normalizeSearchText(pipeline.fullName || pipeline.name);

  if (shortName === normalizedQuery || fullName === normalizedQuery) {
    return 0;
  }
  if (shortName.startsWith(normalizedQuery)) {
    return 1;
  }
  if (fullName.startsWith(normalizedQuery)) {
    return 2;
  }
  if (shortName.includes(normalizedQuery)) {
    return 3;
  }
  if (fullName.includes(normalizedQuery)) {
    return 4;
  }

  return Number.POSITIVE_INFINITY;
}

export function filterPipelineCatalog(
  pipelines,
  query,
  { defaultLimit = 100, matchLimit = 50 } = {}
) {
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return pipelines.slice(0, defaultLimit);
  }

  return pipelines
    .map((pipeline) => ({
      pipeline,
      score: getPipelineMatchScore(pipeline, normalizedQuery),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort(
      (left, right) =>
        left.score - right.score || left.pipeline.name.localeCompare(right.pipeline.name)
    )
    .slice(0, matchLimit)
    .map((entry) => entry.pipeline);
}

export const __internal = {
  getPipelineMatchScore,
  normalizeSearchText,
};