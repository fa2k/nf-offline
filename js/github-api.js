const API_ROOT = "https://api.github.com";
const RAW_ROOT = "https://raw.githubusercontent.com";
const NFCORE_OWNER = "nf-core";
const NEXTFLOW_OWNER = "nextflow-io";
const NEXTFLOW_REPO = "nextflow";
const CACHE_VERSION = "v1";
const PLUGIN_METADATA_CACHE_VERSION = "v1";
const PLUGIN_BUILD_FILES = ["build.gradle", "build.gradle.kts"];
const PLUGIN_METADATA_FILE_PATTERN = /(^|\/)(build\.gradle|build\.gradle\.kts|gradle\.properties|MANIFEST\.(MF|NF))$/i;
const DEFAULT_HEADERS = {
  Accept: "application/vnd.github+json",
};
const NON_PIPELINE_REPOS = new Set([
  "configs",
  "website",
  "tools",
  "modules",
  "proposals",
  "test-datasets",
  "r-nf-core-utils",
  "cookiecutter",
  "bytesize",
  "training",
  "hackathon-projects",
  "launch",
]);

function canUseStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function readCache(cacheKey, maxAgeMs) {
  if (!canUseStorage()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp > maxAgeMs) {
      return null;
    }

    return parsed.value;
  } catch {
    return null;
  }
}

function writeCache(cacheKey, value) {
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(
      cacheKey,
      JSON.stringify({
        timestamp: Date.now(),
        value,
      })
    );
  } catch {
    // Ignore cache failures in restricted browsing modes.
  }
}

async function buildGitHubError(response, url) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");

  if (response.status === 403 && remaining === "0") {
    const resetText = reset ? ` GitHub says the limit resets at ${new Date(Number(reset) * 1000).toLocaleString()}.` : "";
    return new Error(`GitHub API rate limit exceeded while requesting ${url}.${resetText}`);
  }

  let details = "";
  try {
    const payload = await response.json();
    details = payload.message ? ` ${payload.message}` : "";
  } catch {
    details = "";
  }

  return new Error(`GitHub request failed for ${url} (${response.status}).${details}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw await buildGitHubError(response, url);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status}).`);
  }
  return response.text();
}

function dedupeValues(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRawUrl(owner, repo, ref, path = "") {
  const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `${RAW_ROOT}/${owner}/${repo}/${encodeURIComponent(ref)}${encodedPath}`;
}

function parsePluginIdentifier(pluginId) {
  const match = pluginId.match(/^([^@]+)@(.+)$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1].trim(),
    version: match[2].trim().replace(/^~/, ""),
  };
}

function extractMinimumNextflowVersion(constraint) {
  const match = typeof constraint === "string" ? constraint.trim().match(/v?(\d+\.\d+\.\d+)/) : null;
  return match ? match[1] : null;
}

function parsePluginNextflowMetadata(text) {
  if (typeof text !== "string") {
    return null;
  }

  const nextflowVersionMatch = text.match(/(?:^|\b)nextflowVersion\s*=\s*['"]?([^'"\s\r\n)]+)['"]?/m);
  if (nextflowVersionMatch) {
    const minimumNextflowVersion = extractMinimumNextflowVersion(nextflowVersionMatch[1]);
    if (minimumNextflowVersion) {
      return {
        minimumNextflowVersion,
        nextflowConstraint: `>=${minimumNextflowVersion}`,
      };
    }
  }

  const pluginRequiresMatch = text.match(/^Plugin-Requires:\s*([^\r\n]+)$/im);
  if (pluginRequiresMatch) {
    const nextflowConstraint = pluginRequiresMatch[1].trim();
    return {
      minimumNextflowVersion: extractMinimumNextflowVersion(nextflowConstraint),
      nextflowConstraint,
    };
  }

  return null;
}

async function fetchPaginated(fetchPage, maxPages = 4) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = await fetchPage(page);
    if (!pageItems.length) {
      break;
    }
    items.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return items;
}

export function normalizePipelineFullName(pipelineValue) {
  const trimmed = pipelineValue.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.includes("/") ? trimmed : `${NFCORE_OWNER}/${trimmed}`;
}

export function pipelineRepoName(pipelineValue) {
  return normalizePipelineFullName(pipelineValue).split("/")[1] || "pipeline";
}

function looksLikePipeline(repo) {
  if (repo.archived || repo.disabled) {
    return false;
  }

  if (repo.owner?.login !== NFCORE_OWNER) {
    return false;
  }

  if (NON_PIPELINE_REPOS.has(repo.name)) {
    return false;
  }

  const topics = repo.topics || [];
  const description = (repo.description || "").toLowerCase();
  const hasPipelineTopic = topics.includes("pipeline") || topics.includes("nf-core");
  return repo.language === "Nextflow" || hasPipelineTopic || description.includes("pipeline");
}

export async function fetchPipelineCatalog({ forceRefresh = false } = {}) {
  const cacheKey = `pipeline-catalog-${CACHE_VERSION}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60 * 6) : null;
  if (cached) {
    return cached;
  }

  const repos = await fetchPaginated(
    (page) => fetchJson(`${API_ROOT}/orgs/${NFCORE_OWNER}/repos?per_page=100&page=${page}`),
    4
  );

  const pipelines = repos
    .filter(looksLikePipeline)
    .map((repo) => ({
      description: repo.description || "No description from GitHub.",
      fullName: repo.full_name,
      homepage: repo.homepage,
      name: repo.name,
      updatedAt: repo.updated_at,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  writeCache(cacheKey, pipelines);
  return pipelines;
}

export async function fetchPipelineReleases(pipelineFullName, { forceRefresh = false } = {}) {
  const fullName = normalizePipelineFullName(pipelineFullName);
  const cacheKey = `pipeline-releases-${CACHE_VERSION}-${fullName}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60) : null;
  if (cached) {
    return cached;
  }

  const releases = await fetchPaginated(
    (page) => fetchJson(`${API_ROOT}/repos/${fullName}/releases?per_page=100&page=${page}`),
    3
  );

  const normalizedReleases = releases
    .filter((release) => !release.draft)
    .map((release) => ({
      tag: release.tag_name,
      name: release.name || release.tag_name,
      prerelease: release.prerelease,
      publishedAt: release.published_at,
      source: "releases",
    }));

  if (normalizedReleases.length) {
    writeCache(cacheKey, normalizedReleases);
    return normalizedReleases;
  }

  const tags = await fetchPaginated(
    (page) => fetchJson(`${API_ROOT}/repos/${fullName}/tags?per_page=100&page=${page}`),
    3
  );

  const normalizedTags = tags.map((tag) => ({
    tag: tag.name,
    name: tag.name,
    prerelease: /edge/i.test(tag.name),
    publishedAt: null,
    source: "tags",
  }));

  writeCache(cacheKey, normalizedTags);
  return normalizedTags;
}

export async function fetchPipelineConfig(pipelineFullName, releaseTag, { forceRefresh = false } = {}) {
  const fullName = normalizePipelineFullName(pipelineFullName);
  const [owner, repo] = fullName.split("/");
  const cacheKey = `pipeline-config-${CACHE_VERSION}-${fullName}@${releaseTag}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 20) : null;
  if (cached) {
    return cached;
  }

  const configText = await fetchText(`${RAW_ROOT}/${owner}/${repo}/${encodeURIComponent(releaseTag)}/nextflow.config`);
  writeCache(cacheKey, configText);
  return configText;
}

async function fetchPluginRepository(pluginName, { forceRefresh = false } = {}) {
  const normalizedName = pluginName.toLowerCase();
  const cacheKey = `plugin-repo-${PLUGIN_METADATA_CACHE_VERSION}-${normalizedName}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60 * 6) : null;
  if (cached) {
    return cached;
  }

  const response = await fetchJson(
    `${API_ROOT}/search/repositories?q=${encodeURIComponent(`${pluginName} in:name`)}&per_page=10`
  );
  const exactMatch = (response.items || []).find((item) => item.name.toLowerCase() === normalizedName);

  if (!exactMatch) {
    return null;
  }

  const repository = {
    fullName: exactMatch.full_name,
  };
  writeCache(cacheKey, repository);
  return repository;
}

async function fetchPluginTagNames(repoFullName, { forceRefresh = false } = {}) {
  const cacheKey = `plugin-tags-${PLUGIN_METADATA_CACHE_VERSION}-${repoFullName}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60 * 6) : null;
  if (cached) {
    return cached;
  }

  const tags = await fetchPaginated(
    (page) => fetchJson(`${API_ROOT}/repos/${repoFullName}/tags?per_page=100&page=${page}`),
    3
  );
  const tagNames = tags.map((tag) => tag.name);
  writeCache(cacheKey, tagNames);
  return tagNames;
}

function tagMatchesPluginVersion(tagName, pluginVersion) {
  const normalizedVersion = pluginVersion.replace(/^v/, "");
  const directMatches = new Set([pluginVersion, normalizedVersion, `v${normalizedVersion}`]);
  if (directMatches.has(tagName)) {
    return true;
  }

  const suffixPattern = new RegExp(`(^|[-_/])v?${escapeRegExp(normalizedVersion)}$`, "i");
  return suffixPattern.test(tagName);
}

async function fetchPluginCandidateRefs(repoFullName, pluginVersion, { forceRefresh = false } = {}) {
  const defaultRefs = dedupeValues([
    pluginVersion,
    pluginVersion.startsWith("v") ? pluginVersion.slice(1) : `v${pluginVersion}`,
  ]);

  try {
    const tagNames = await fetchPluginTagNames(repoFullName, { forceRefresh });
    return dedupeValues([...defaultRefs, ...tagNames.filter((tagName) => tagMatchesPluginVersion(tagName, pluginVersion))]);
  } catch {
    return defaultRefs;
  }
}

async function fetchPluginTreePaths(repoFullName, ref, { forceRefresh = false } = {}) {
  const cacheKey = `plugin-tree-${PLUGIN_METADATA_CACHE_VERSION}-${repoFullName}@${ref}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60 * 6) : null;
  if (cached) {
    return cached;
  }

  const payload = await fetchJson(`${API_ROOT}/repos/${repoFullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const paths = (payload.tree || []).filter((item) => item.type === "blob").map((item) => item.path);
  writeCache(cacheKey, paths);
  return paths;
}

function selectPluginMetadataPaths(paths, pluginName) {
  const metadataPaths = (paths || []).filter((path) => PLUGIN_METADATA_FILE_PATTERN.test(path));
  const lowerPluginName = pluginName.toLowerCase();
  const preferredPaths = [
    `plugins/${pluginName}/src/resources/META-INF/MANIFEST.MF`,
    `plugins/${pluginName}/src/resources/META-INF/MANIFEST.NF`,
    `plugins/${pluginName}/build.gradle`,
    `plugins/${pluginName}/build.gradle.kts`,
    `plugins/${pluginName}/gradle.properties`,
    "src/resources/META-INF/MANIFEST.MF",
    "src/resources/META-INF/MANIFEST.NF",
    "build.gradle",
    "build.gradle.kts",
    "gradle.properties",
  ].filter((path) => metadataPaths.includes(path));

  const pluginScopedPaths = metadataPaths.filter(
    (path) => path.toLowerCase().includes(`/${lowerPluginName}/`) || path.toLowerCase().startsWith(`${lowerPluginName}/`)
  );
  const manifestPaths = metadataPaths.filter((path) => /MANIFEST\.(MF|NF)$/i.test(path));
  const gradlePaths = metadataPaths.filter((path) => /(^|\/)(build\.gradle|build\.gradle\.kts|gradle\.properties)$/i.test(path));

  return dedupeValues([...preferredPaths, ...pluginScopedPaths, ...manifestPaths, ...gradlePaths]);
}

async function fetchPluginMetadata(repoFullName, pluginName, pluginVersion, { forceRefresh = false } = {}) {
  const [owner, repo] = repoFullName.split("/");
  const candidateRefs = await fetchPluginCandidateRefs(repoFullName, pluginVersion, { forceRefresh });

  let lastError = null;

  for (const ref of candidateRefs) {
    for (const buildFile of PLUGIN_BUILD_FILES) {
      try {
        const metadataText = await fetchText(buildRawUrl(owner, repo, ref, buildFile));
        const parsed = parsePluginNextflowMetadata(metadataText);
        if (parsed) {
          return {
            ...parsed,
            sourcePath: buildFile,
            sourceRef: ref,
          };
        }
      } catch (error) {
        lastError = error;
      }
    }

    try {
      const treePaths = await fetchPluginTreePaths(repoFullName, ref, { forceRefresh });
      const metadataPaths = selectPluginMetadataPaths(treePaths, pluginName);

      for (const metadataPath of metadataPaths) {
        try {
          const metadataText = await fetchText(buildRawUrl(owner, repo, ref, metadataPath));
          const parsed = parsePluginNextflowMetadata(metadataText);
          if (parsed) {
            return {
              ...parsed,
              sourcePath: metadataPath,
              sourceRef: ref,
            };
          }
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
  }

  const reason = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(
    `Could not resolve Nextflow plugin metadata for ${repoFullName}@${pluginVersion} using refs ${candidateRefs.join(" or ")}.${reason}`
  );
}

async function fetchPluginRequirement(pluginId, { forceRefresh = false } = {}) {
  const cacheKey = `plugin-requirement-${PLUGIN_METADATA_CACHE_VERSION}-${pluginId}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60 * 6) : null;
  if (cached) {
    return cached;
  }

  const identifier = parsePluginIdentifier(pluginId);
  if (!identifier) {
    return {
      minimumNextflowVersion: null,
      pluginId,
      repository: null,
    };
  }

  const repository = await fetchPluginRepository(identifier.name, { forceRefresh });
  if (!repository) {
    throw new Error(`Could not find a public GitHub repository for plugin ${pluginId}.`);
  }

  const metadata = await fetchPluginMetadata(repository.fullName, identifier.name, identifier.version, { forceRefresh });
  if (!metadata?.nextflowConstraint && !metadata?.minimumNextflowVersion) {
    throw new Error(`Could not parse a minimum Nextflow version from ${repository.fullName}@${identifier.version}.`);
  }

  const requirement = {
    minimumNextflowVersion: metadata.minimumNextflowVersion,
    nextflowConstraint: metadata.nextflowConstraint,
    pluginId,
    repository: repository.fullName,
    sourcePath: metadata.sourcePath || null,
    sourceRef: metadata.sourceRef || null,
  };
  writeCache(cacheKey, requirement);
  return requirement;
}

export async function fetchPluginRequirements(plugins, { forceRefresh = false } = {}) {
  const versionedPlugins = dedupeValues((plugins || []).filter((plugin) => plugin.includes("@")));
  const results = await Promise.all(
    versionedPlugins.map(async (pluginId) => {
      try {
        return {
          requirement: await fetchPluginRequirement(pluginId, { forceRefresh }),
          warning: null,
        };
      } catch (error) {
        return {
          requirement: {
            minimumNextflowVersion: null,
            nextflowConstraint: null,
            pluginId,
            repository: null,
            sourcePath: null,
            sourceRef: null,
          },
          warning:
            error instanceof Error ? error.message : `Failed to inspect pinned plugin requirements for ${pluginId}.`,
        };
      }
    })
  );

  return {
    requirements: results.map((result) => result.requirement),
    warnings: results.map((result) => result.warning).filter(Boolean),
  };
}

export async function fetchStableNextflowReleases({ forceRefresh = false } = {}) {
  const cacheKey = `nextflow-releases-${CACHE_VERSION}`;
  const cached = !forceRefresh ? readCache(cacheKey, 1000 * 60 * 60 * 6) : null;
  if (cached) {
    return cached;
  }

  const releases = await fetchPaginated(
    (page) => fetchJson(`${API_ROOT}/repos/${NEXTFLOW_OWNER}/${NEXTFLOW_REPO}/releases?per_page=100&page=${page}`),
    4
  );

  const stableReleases = releases
    .filter((release) => !release.draft && !release.prerelease && !release.tag_name.includes("edge"))
    .map((release) => ({
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/, ""),
      publishedAt: release.published_at,
      distUrl:
        release.assets.find((asset) => asset.name === `nextflow-${release.tag_name.replace(/^v/, "")}-dist`)?.browser_download_url ||
        `https://github.com/${NEXTFLOW_OWNER}/${NEXTFLOW_REPO}/releases/download/${release.tag_name}/nextflow-${release.tag_name.replace(/^v/, "")}-dist`,
    }));

  writeCache(cacheKey, stableReleases);
  return stableReleases;
}