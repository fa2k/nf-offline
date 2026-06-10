function sanitizeSegment(segment) {
  return segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "bundle";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildSharedVariables({ bundleName, nextflowVersion, pipelineFullName, releaseTag }) {
  const lines = [
    `BUNDLE_DIR=${shellQuote(bundleName)}`,
    `PIPELINE=${shellQuote(pipelineFullName)}`,
    `PIPELINE_RELEASE=${shellQuote(releaseTag)}`,
  ];

  if (nextflowVersion) {
    lines.push(`NEXTFLOW_VERSION=${shellQuote(nextflowVersion)}`);
  }

  return lines.join("\n");
}

function formatRunArguments(extraRunArgs = "") {
  const normalized = extraRunArgs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!normalized.length) {
    return ["  # add pipeline-specific parameters here"];
  }

  return normalized.map((line) => `  ${line}`);
}

function collectVersionedPlugins(plugins = []) {
  return plugins.filter((plugin) => plugin.includes("@"));
}

function normalizeReleaseDirectoryName(releaseTag) {
  return sanitizeSegment(releaseTag).replace(/\./g, "_");
}

function buildRunCommand({ bundleName, releaseTag, runtimeProfile, extraRunArgs }) {
  const runArguments = formatRunArguments(extraRunArgs);
  const releaseDirectory = normalizeReleaseDirectoryName(releaseTag);
  const lines = [
    `BUNDLE_DIR=${shellQuote(bundleName)}`,
    'NEXTFLOW_BIN="$BUNDLE_DIR/runtime/nextflow"',
    'NXF_HOME="$BUNDLE_DIR/nextflow-home"',
    'NXF_PLUGINS_DIR="$NXF_HOME/plugins"',
    'NXF_OFFLINE=true',
    'PIPELINE_ROOT="$BUNDLE_DIR/pipeline"',
    `PIPELINE_DIR="$PIPELINE_ROOT/${releaseDirectory}"`,
    'NXF_SINGULARITY_LIBRARYDIR="$PIPELINE_ROOT/singularity-images"',
    'NXF_APPTAINER_LIBRARYDIR="$PIPELINE_ROOT/singularity-images"',
    'unset NXF_SINGULARITY_CACHEDIR NXF_APPTAINER_CACHEDIR',
    'export NXF_HOME NXF_PLUGINS_DIR NXF_SINGULARITY_LIBRARYDIR NXF_APPTAINER_LIBRARYDIR NXF_OFFLINE',
    '"$NEXTFLOW_BIN" run "$PIPELINE_DIR" \\',
    `  -profile ${runtimeProfile}${runArguments.length ? " \\" : ""}`,
  ];

  runArguments.forEach((line, index) => {
    const suffix = index < runArguments.length - 1 ? " \\" : "";
    lines.push(`${line}${suffix}`);
  });

  return lines.join("\n");
}

function buildPrepCommand({
  bundleName,
  nextflowVersion,
  pipelineFullName,
  plugins,
  releaseTag,
  runtimeDownloadUrl,
}) {
  const versionedPlugins = collectVersionedPlugins(plugins);
  const lines = [
    "(",
    "set -eu",
    buildSharedVariables({
      bundleName,
      nextflowVersion: nextflowVersion || "SET_A_NEXTFLOW_VERSION",
      pipelineFullName,
      releaseTag,
    }),
    'NEXTFLOW_BIN="$PWD/$BUNDLE_DIR/runtime/nextflow"',
    'NXF_HOME="$PWD/$BUNDLE_DIR/nextflow-home"',
    'NXF_PLUGINS_DIR="$NXF_HOME/plugins"',
    'mkdir -p "$BUNDLE_DIR" "$BUNDLE_DIR/runtime" "$NXF_HOME" "$NXF_PLUGINS_DIR"',
    "",
    "# Download the selected pipeline release and Singularity image files",
    'docker run --rm \\',
    '  --volume "$PWD/$BUNDLE_DIR":/data \\',
    '  --workdir /data \\',
    '  nfcore/gitpod \\',
    '  nf-core pipelines download \\',
    '    --container-system singularity \\',
    '    --compress none \\',
    '    --outdir /data/pipeline \\',
    '    "$PIPELINE" -r "$PIPELINE_RELEASE"',
    "",
    "# Download the standalone Nextflow runtime",
    `curl -fsSL ${shellQuote(runtimeDownloadUrl)} -o "$NEXTFLOW_BIN"`,
    'chmod +x "$NEXTFLOW_BIN"',
    "",
  ];

  if (!versionedPlugins.length) {
    lines.push("# No explicit plugin versions were detected in nextflow.config for this release.");
    lines.push("# Skip plugin pre-installation unless you know the pipeline needs external plugins.");
  } else {
    lines.push("# Pre-install pinned Nextflow plugins");
    lines.push('export NXF_HOME NXF_PLUGINS_DIR');

    versionedPlugins.forEach((plugin) => {
      lines.push(`"$NEXTFLOW_BIN" plugin install ${shellQuote(plugin)}`);
    });
  }

  lines.push("");
  lines.push("# Package the bundle for transfer");
  lines.push('tar -cf "${BUNDLE_DIR}.tar" "$BUNDLE_DIR"');
  lines.push(")");

  return lines.join("\n");
}

export function normalizeBundleName(pipelineName, releaseTag) {
  return `nf-core-offline-${sanitizeSegment(pipelineName)}-${sanitizeSegment(releaseTag)}`;
}

export function generateCommandPlan({
  bundleName,
  nextflowVersion,
  pipelineFullName,
  plugins,
  releaseTag,
  runtimeProfile,
  extraRunArgs,
}) {
  const safeBundleName =
    bundleName || normalizeBundleName(pipelineFullName.split("/")[1] || "pipeline", releaseTag);
  const runtimeVersion = nextflowVersion || "SET_A_NEXTFLOW_VERSION";
  const runtimeDownloadUrl = `https://github.com/nextflow-io/nextflow/releases/download/v${runtimeVersion}/nextflow-${runtimeVersion}-dist`;

  return [
    {
      id: "prepare-bundle",
      fileName: "script-1-download.sh",
      title: "1. Prepare and package the offline bundle",
      summary:
        "Downloads the selected pipeline release and container files, fetches the standalone Nextflow runtime, pre-installs pinned plugins, and packages the transfer tar archive in one script.",
      command: buildPrepCommand({
        bundleName: safeBundleName,
        nextflowVersion: runtimeVersion,
        pipelineFullName,
        plugins,
        releaseTag,
        runtimeDownloadUrl,
      }),
    },
    {
      id: "offline-run",
      fileName: "script-2-run.sh",
      title: "2. Run the pipeline on the offline system",
      summary:
        `Runs the local pipeline bundle with the ${runtimeProfile} profile and points container lookup at the transferred Singularity images.`,
      command: buildRunCommand({
        bundleName: safeBundleName,
        extraRunArgs,
        releaseTag,
        runtimeProfile,
      }),
    },
  ];
}
