import {
  fetchPipelineCatalog,
  fetchPipelineConfig,
  fetchPluginRequirements,
  fetchPipelineReleases,
  fetchStableNextflowReleases,
  normalizePipelineFullName,
  pipelineRepoName,
} from "./github-api.js?v=20260610-3";
import { parseNextflowConfig } from "./config-parser.js?v=20260609-3";
import { generateCommandPlan, normalizeBundleName } from "./command-generator.js?v=20260610-4";
import { filterPipelineCatalog } from "./pipeline-search.js?v=20260609-3";
import { resolveNextflowVersion } from "./version-resolver.js?v=20260610-2";

const state = {
  pipelines: [],
  releases: [],
  nextflowReleases: [],
  currentPipeline: "",
  currentRelease: "",
  configText: "",
  pluginMetadataWarnings: [],
  pluginRequirements: [],
  parsedConfig: null,
  resolution: null,
  commands: [],
};

const elements = {
  pipelineInput: document.querySelector("#pipeline-input"),
  releaseInput: document.querySelector("#release-input"),
  pipelineOptions: document.querySelector("#pipeline-options"),
  releaseOptions: document.querySelector("#release-options"),
  releaseHint: document.querySelector("#release-hint"),
  runtimeProfile: document.querySelector("#runtime-profile"),
  nextflowVersionOverride: document.querySelector("#nextflow-version-override"),
  bundleName: document.querySelector("#bundle-name"),
  offlineRunArgs: document.querySelector("#offline-run-args"),
  form: document.querySelector("#generator-form"),
  inspectButton: document.querySelector("#inspect-button"),
  refreshButton: document.querySelector("#refresh-button"),
  copyAllButton: document.querySelector("#copy-all-button"),
  statusBanner: document.querySelector("#status-banner"),
  summaryPipeline: document.querySelector("#summary-pipeline"),
  summaryRelease: document.querySelector("#summary-release"),
  summaryConstraint: document.querySelector("#summary-constraint"),
  summaryRuntime: document.querySelector("#summary-runtime"),
  summaryBundle: document.querySelector("#summary-bundle"),
  summaryConfigSource: document.querySelector("#summary-config-source"),
  pluginsCount: document.querySelector("#plugins-count"),
  pluginsList: document.querySelector("#plugins-list"),
  resolutionBadge: document.querySelector("#resolution-badge"),
  resolutionNote: document.querySelector("#resolution-note"),
  warningsList: document.querySelector("#warnings-list"),
  commandGrid: document.querySelector("#command-grid"),
};

function setStatus(text, tone = "info") {
  elements.statusBanner.textContent = text;
  elements.statusBanner.className = `status-banner status-banner--${tone}`;
}

function setBusy(isBusy) {
  elements.inspectButton.disabled = isBusy;
  elements.refreshButton.disabled = isBusy;
}

function buildOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  if (label) {
    option.label = label;
    option.textContent = label;
  }
  return option;
}

function renderPipelineOptions(query = elements.pipelineInput.value) {
  const visiblePipelines = filterPipelineCatalog(state.pipelines, query);
  elements.pipelineOptions.replaceChildren(
    ...visiblePipelines.map((pipeline) =>
      buildOption(pipeline.name, `${pipeline.fullName} - ${pipeline.description}`)
    )
  );
}

function renderReleaseOptions() {
  elements.releaseOptions.replaceChildren(
    ...state.releases.map((release) => {
      const labelParts = [release.tag];
      if (release.publishedAt) {
        labelParts.push(new Date(release.publishedAt).toISOString().slice(0, 10));
      }
      return buildOption(release.tag, labelParts.join(" | "));
    })
  );

  const pipeline = normalizePipelineFullName(elements.pipelineInput.value.trim());
  elements.releaseHint.textContent = state.releases.length
    ? `Found ${state.releases.length} releases or tags for ${pipeline}.`
    : "No releases found yet for this pipeline.";
}

function renderWarnings(warnings = []) {
  if (!warnings.length) {
    elements.warningsList.classList.add("hidden");
    elements.warningsList.replaceChildren();
    return;
  }

  elements.warningsList.classList.remove("hidden");
  elements.warningsList.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    })
  );
}

function formatPluginRequirementSource(requirement) {
  if (!requirement?.repository) {
    return "Requirement metadata could not be resolved from GitHub.";
  }

  if (requirement.sourcePath && requirement.sourceRef) {
    return `${requirement.repository} @ ${requirement.sourceRef} -> ${requirement.sourcePath}`;
  }

  return requirement.repository;
}

function renderPlugins(parsedConfig, pluginRequirements = []) {
  const plugins = parsedConfig?.plugins ?? [];
  const requirementByPluginId = new Map(pluginRequirements.map((requirement) => [requirement.pluginId, requirement]));
  const resolvedCount = pluginRequirements.filter((requirement) => requirement.nextflowConstraint).length;

  elements.pluginsCount.textContent = plugins.length
    ? `${plugins.length} detected / ${resolvedCount} resolved`
    : "0 detected";

  if (!plugins.length) {
    const item = document.createElement("li");
    item.textContent = parsedConfig?.hasPluginsBlock
      ? "A plugins block was present, but no pinned plugin entries were parsed from it."
      : "No plugins block was detected in this release's nextflow.config.";
    elements.pluginsList.className = "plugin-list empty-state";
    elements.pluginsList.replaceChildren(item);
    return;
  }

  elements.pluginsList.className = "plugin-list";
  elements.pluginsList.replaceChildren(
    ...plugins.map((plugin) => {
      const requirement = requirementByPluginId.get(plugin);
      const item = document.createElement("li");
      item.className = "plugin-item";

      const name = document.createElement("span");
      name.className = "plugin-name";
      name.textContent = plugin;

      const metadata = document.createElement("span");
      metadata.className = "plugin-meta";
      metadata.textContent = requirement?.nextflowConstraint
        ? `Requires Nextflow ${requirement.nextflowConstraint}. Source: ${formatPluginRequirementSource(requirement)}`
        : "No tagged Nextflow requirement metadata could be resolved for this plugin.";

      item.append(name, metadata);
      return item;
    })
  );
}

function currentBundleName() {
  const manual = elements.bundleName.value.trim();
  if (manual) {
    return manual;
  }

  if (!state.currentPipeline || !state.currentRelease) {
    return "Waiting for inspection";
  }

  return normalizeBundleName(pipelineRepoName(state.currentPipeline), state.currentRelease);
}

function renderSummary() {
  elements.summaryPipeline.textContent = state.currentPipeline || "Not loaded yet";
  elements.summaryRelease.textContent = state.currentRelease || "Not loaded yet";
  elements.summaryConstraint.textContent = state.parsedConfig?.nextflowVersion || "No manifest.nextflowVersion detected";
  elements.summaryRuntime.textContent = state.resolution?.version
    ? `${state.resolution.version} (${state.resolution.sourceLabel})`
    : "Manual input required";
  elements.summaryBundle.textContent = currentBundleName();
  elements.summaryConfigSource.textContent = state.currentPipeline && state.currentRelease
    ? `raw.githubusercontent.com/${state.currentPipeline}/${state.currentRelease}/nextflow.config`
    : "Waiting for inspection";
  elements.resolutionBadge.textContent = state.resolution?.sourceLabel || "Awaiting data";
  elements.resolutionNote.textContent =
    state.resolution?.reason ||
    "The recommended runtime version will be selected from the parsed manifest constraint and any pinned plugin minimum versions that can be resolved from public GitHub metadata.";

  renderPlugins(state.parsedConfig, state.pluginRequirements);
  renderWarnings(state.resolution?.warnings ?? []);
}

function createCommandCard(commandDefinition) {
  const card = document.createElement("article");
  card.className = "command-card";

  const head = document.createElement("div");
  head.className = "command-card-head";

  const group = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = commandDefinition.title;
  const summary = document.createElement("p");
  summary.textContent = commandDefinition.summary;
  group.append(title, summary);

  const actions = document.createElement("div");
  actions.className = "command-card-actions";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-button";
  copyButton.textContent = "Copy";
  copyButton.dataset.copyPayload = commandDefinition.command;

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "download-button";
  downloadButton.textContent = "Download .sh";
  downloadButton.dataset.downloadPayload = commandDefinition.command;
  downloadButton.dataset.downloadFilename = commandDefinition.fileName || `${commandDefinition.id}.sh`;

  actions.append(copyButton, downloadButton);
  head.append(group, actions);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = commandDefinition.command;
  pre.append(code);

  card.append(head, pre);
  return card;
}

function renderCommands() {
  if (!state.commands.length) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "command-card command-card--empty";
    const title = document.createElement("h3");
    title.textContent = "Waiting for a pipeline release";
    const copy = document.createElement("p");
    copy.textContent = "Choose a pipeline and release, then inspect it to populate the offline-prep commands.";
    emptyCard.append(title, copy);
    elements.commandGrid.replaceChildren(emptyCard);
    elements.copyAllButton.disabled = true;
    return;
  }

  elements.commandGrid.replaceChildren(...state.commands.map(createCommandCard));
  elements.copyAllButton.disabled = false;
}

function recomputeDerivedOutput() {
  if (!state.currentPipeline || !state.currentRelease || !state.parsedConfig) {
    return;
  }

  state.resolution = resolveNextflowVersion({
    availableReleases: state.nextflowReleases,
    manualVersion: elements.nextflowVersionOverride.value.trim(),
    nextflowConstraint: state.parsedConfig.nextflowVersion,
    pluginRequirements: state.pluginRequirements,
    pipelineFullName: state.currentPipeline,
    releaseTag: state.currentRelease,
  });

  if (state.pluginMetadataWarnings.length) {
    state.resolution = {
      ...state.resolution,
      warnings: [...state.pluginMetadataWarnings, ...state.resolution.warnings],
    };
  }

  state.commands = generateCommandPlan({
    bundleName: elements.bundleName.value.trim() || normalizeBundleName(pipelineRepoName(state.currentPipeline), state.currentRelease),
    nextflowVersion: state.resolution.version,
    pipelineFullName: state.currentPipeline,
    plugins: state.parsedConfig.plugins,
    releaseTag: state.currentRelease,
    runtimeProfile: elements.runtimeProfile.value,
    extraRunArgs: elements.offlineRunArgs.value,
  });

  renderSummary();
  renderCommands();
}

async function loadPipelineCatalog(forceRefresh = false) {
  state.pipelines = await fetchPipelineCatalog({ forceRefresh });
  renderPipelineOptions(elements.pipelineInput.value);
}

async function loadNextflowReleases(forceRefresh = false) {
  state.nextflowReleases = await fetchStableNextflowReleases({ forceRefresh });
}

async function loadReleasesForPipeline(forceRefresh = false) {
  const pipelineInput = elements.pipelineInput.value.trim();
  if (!pipelineInput) {
    state.releases = [];
    renderReleaseOptions();
    return;
  }

  const pipelineFullName = normalizePipelineFullName(pipelineInput);
  state.releases = await fetchPipelineReleases(pipelineFullName, { forceRefresh });
  renderReleaseOptions();

  if (!elements.releaseInput.value.trim() && state.releases.length) {
    elements.releaseInput.value = state.releases[0].tag;
  }
}

async function inspectSelection(forceRefresh = false) {
  const pipelineFullName = normalizePipelineFullName(elements.pipelineInput.value.trim());
  const releaseTag = elements.releaseInput.value.trim();

  if (!pipelineFullName || !releaseTag) {
    setStatus("Enter both a pipeline and a release before inspection.", "warning");
    return;
  }

  setBusy(true);
  setStatus(`Inspecting ${pipelineFullName}@${releaseTag}.`, "info");

  try {
    if (!state.nextflowReleases.length || forceRefresh) {
      await loadNextflowReleases(forceRefresh);
    }

    if (!state.releases.length || forceRefresh) {
      await loadReleasesForPipeline(forceRefresh);
    }

    state.configText = await fetchPipelineConfig(pipelineFullName, releaseTag, { forceRefresh });
    state.currentPipeline = pipelineFullName;
    state.currentRelease = releaseTag;
    state.parsedConfig = parseNextflowConfig(state.configText);
    const pluginMetadata = await fetchPluginRequirements(state.parsedConfig.plugins, { forceRefresh });
    state.pluginRequirements = pluginMetadata.requirements;
    state.pluginMetadataWarnings = pluginMetadata.warnings;

    if (!elements.bundleName.value.trim()) {
      elements.bundleName.value = normalizeBundleName(pipelineRepoName(pipelineFullName), releaseTag);
    }

    recomputeDerivedOutput();
    setStatus(`Loaded ${pipelineFullName}@${releaseTag} from GitHub and regenerated all command blocks.`, "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to inspect the selected release.", "error");
  } finally {
    setBusy(false);
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "readonly");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.append(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }

  flashActionButton(button, "Copied");
}

function flashActionButton(button, text) {
  const previousText = button.textContent;
  button.textContent = text;
  button.classList.add("is-confirmed");
  window.setTimeout(() => {
    button.textContent = previousText;
    button.classList.remove("is-confirmed");
  }, 1200);
}

function downloadTextFile(text, fileName, button) {
  const blob = new Blob([`${text}\n`], { type: "text/x-shellscript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  flashActionButton(button, "Downloaded");
}

async function initialize() {
  try {
    setBusy(true);
    await Promise.all([loadPipelineCatalog(), loadNextflowReleases()]);
    setStatus("Ready. Choose a pipeline and release to inspect its offline requirements.", "info");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to load initial GitHub data.", "error");
  } finally {
    setBusy(false);
    renderSummary();
    renderCommands();
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await inspectSelection();
});

elements.refreshButton.addEventListener("click", async () => {
  try {
    setBusy(true);
    setStatus("Refreshing pipeline, release, and Nextflow metadata from GitHub.", "info");
    await Promise.all([loadPipelineCatalog(true), loadNextflowReleases(true)]);
    await loadReleasesForPipeline(true);
    if (elements.pipelineInput.value.trim() && elements.releaseInput.value.trim()) {
      await inspectSelection(true);
      return;
    }
    setStatus("GitHub metadata refreshed. Choose a release to inspect.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Refresh failed.", "error");
  } finally {
    setBusy(false);
  }
});

elements.pipelineInput.addEventListener("change", async () => {
  try {
    setBusy(true);
    setStatus(`Loading releases for ${normalizePipelineFullName(elements.pipelineInput.value.trim())}.`, "info");
    await loadReleasesForPipeline();
    setStatus("Release list updated from GitHub. Inspect a release when ready.", "info");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to load releases for the selected pipeline.", "error");
  } finally {
    setBusy(false);
  }
});

elements.pipelineInput.addEventListener("input", () => {
  renderPipelineOptions(elements.pipelineInput.value);
});

elements.runtimeProfile.addEventListener("change", recomputeDerivedOutput);
elements.nextflowVersionOverride.addEventListener("input", recomputeDerivedOutput);
elements.bundleName.addEventListener("input", recomputeDerivedOutput);
elements.offlineRunArgs.addEventListener("input", recomputeDerivedOutput);

elements.copyAllButton.addEventListener("click", async () => {
  if (!state.commands.length) {
    return;
  }
  const text = state.commands.map((entry) => `# ${entry.title}\n${entry.command}`).join("\n\n");
  await copyText(text, elements.copyAllButton);
});

elements.commandGrid.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const downloadPayload = target.dataset.downloadPayload;
  const downloadFilename = target.dataset.downloadFilename;
  if (downloadPayload && downloadFilename) {
    downloadTextFile(downloadPayload, downloadFilename, target);
    return;
  }

  const payload = target.dataset.copyPayload;
  if (!payload) {
    return;
  }

  await copyText(payload, target);
});

window.nfOfflinePrep = {
  inspectSelection,
  parseNextflowConfig,
  recomputeDerivedOutput,
  state,
};

initialize();
