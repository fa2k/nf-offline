function parseVersion(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function compareVersions(left, right) {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function normalizeConstraint(constraint) {
  if (!constraint) {
    return "";
  }

  return constraint.trim().replace(/^!\s*/, "");
}

function tokenizeConstraint(constraint) {
  if (!constraint) {
    return [];
  }

  const normalizedConstraint = normalizeConstraint(constraint);
  const tokens = normalizedConstraint.match(/(?:[<>]=?|!?={1,2})\s*v?\d+\.\d+\.\d+|v?\d+\.\d+\.\d+/g);
  return tokens || [];
}

function buildPredicate(token) {
  const normalizedToken = token.replace(/\s+/g, "");
  const operatorMatch = normalizedToken.match(/^(?:!?[<>]=?|!?={1,2})/);
  const operator = operatorMatch ? operatorMatch[0] : "=";
  const versionText = normalizedToken.slice(operatorMatch ? operator.length : 0);
  const parsedTargetVersion = parseVersion(versionText);

  if (!parsedTargetVersion) {
    return null;
  }

  return (candidateText) => {
    const candidate = parseVersion(candidateText);
    if (!candidate) {
      return false;
    }

    const comparison = compareVersions(candidate, parsedTargetVersion);
    switch (operator) {
      case ">":
        return comparison > 0;
      case ">=":
        return comparison >= 0;
      case "<":
        return comparison < 0;
      case "<=":
        return comparison <= 0;
      case "=":
      case "==":
        return comparison === 0;
      case "!=":
      case "!==":
        return comparison !== 0;
      case "!>":
        return comparison <= 0;
      case "!>=":
        return comparison < 0;
      case "!<":
        return comparison >= 0;
      case "!<=":
        return comparison > 0;
      default:
        return comparison === 0;
    }
  };
}

function matchesConstraint(version, constraint) {
  const tokens = tokenizeConstraint(constraint);
  if (!tokens.length) {
    return true;
  }

  const predicates = tokens.map(buildPredicate).filter(Boolean);
  if (!predicates.length) {
    return false;
  }

  return predicates.every((predicate) => predicate(version));
}

function buildPluginConstraints(pluginRequirements = []) {
  return pluginRequirements
    .map((requirement) => {
      const constraint = requirement.nextflowConstraint ||
        (parseVersion(requirement.minimumNextflowVersion) ? `>=${requirement.minimumNextflowVersion}` : null);

      if (!constraint || !tokenizeConstraint(constraint).length) {
        return null;
      }

      return {
        constraint,
        description: `${requirement.pluginId} requires ${constraint}`,
      };
    })
    .filter(Boolean);
}

function buildActiveConstraints(nextflowConstraint, pluginRequirements) {
  const constraints = [];

  if (nextflowConstraint) {
    constraints.push({
      constraint: nextflowConstraint,
      description: `workflow manifest ${nextflowConstraint}`,
    });
  }

  return constraints.concat(buildPluginConstraints(pluginRequirements));
}

function matchesAllConstraints(version, constraints) {
  return constraints.every(({ constraint }) => matchesConstraint(version, constraint));
}

function sortReleases(releases, direction = "desc") {
  return [...releases].sort((left, right) => {
    const leftVersion = parseVersion(left.version);
    const rightVersion = parseVersion(right.version);
    if (!leftVersion || !rightVersion) {
      return 0;
    }

    const comparison = compareVersions(leftVersion, rightVersion);
    return direction === "asc" ? comparison : -comparison;
  });
}

export function resolveNextflowVersion({
  availableReleases,
  manualVersion,
  nextflowConstraint,
  pluginRequirements = [],
  pipelineFullName,
  releaseTag,
}) {
  const warnings = [];

  if (manualVersion) {
    if (parseVersion(manualVersion)) {
      return {
        reason: `Manual override active. The generated commands now use Nextflow ${manualVersion}.`,
        source: "manual",
        sourceLabel: "Manual override",
        version: manualVersion,
        warnings,
      };
    }
    warnings.push(`Ignored invalid manual Nextflow version override: ${manualVersion}. Expected a semantic version like 25.10.1.`);
  }

  const stableReleases = sortReleases(availableReleases || [], "desc");
  if (!stableReleases.length) {
    warnings.push("No stable Nextflow release metadata was available from GitHub.");
    return {
      reason: "No stable Nextflow releases were available from GitHub, so this tool could not compute a recommendation.",
      source: "missing-data",
      sourceLabel: "Missing release data",
      version: null,
      warnings,
    };
  }

  const activeConstraints = buildActiveConstraints(nextflowConstraint, pluginRequirements);
  if (!activeConstraints.length) {
    return {
      reason: `No manifest.nextflowVersion was parsed, so the newest stable release from the fetched catalog was used: ${stableReleases[0].version}.`,
      source: "latest-stable",
      sourceLabel: "Latest stable",
      version: stableReleases[0].version,
      warnings,
    };
  }

  const minimumCompatibleRelease = sortReleases(stableReleases, "asc").find((release) =>
    matchesAllConstraints(release.version, activeConstraints)
  );
  if (minimumCompatibleRelease) {
    const pluginConstraintCount = activeConstraints.length - (nextflowConstraint ? 1 : 0);

    if (!nextflowConstraint && pluginConstraintCount) {
      return {
        reason: `Selected the minimum stable Nextflow release that satisfies ${pluginConstraintCount} pinned plugin requirement${pluginConstraintCount === 1 ? "" : "s"}: ${minimumCompatibleRelease.version}.`,
        source: "plugin-match",
        sourceLabel: "Minimum plugin match",
        version: minimumCompatibleRelease.version,
        warnings,
      };
    }

    if (pluginConstraintCount) {
      return {
        reason: `Selected the minimum stable Nextflow release that matches the parsed manifest constraint ${nextflowConstraint} and ${pluginConstraintCount} pinned plugin requirement${pluginConstraintCount === 1 ? "" : "s"}: ${minimumCompatibleRelease.version}.`,
        source: "combined-match",
        sourceLabel: "Minimum workflow + plugin match",
        version: minimumCompatibleRelease.version,
        warnings,
      };
    }

    return {
      reason: `Selected the minimum stable Nextflow release that matches the parsed manifest constraint ${nextflowConstraint}: ${minimumCompatibleRelease.version}.`,
      source: "constraint-match",
      sourceLabel: "Minimum manifest match",
      version: minimumCompatibleRelease.version,
      warnings,
    };
  }

  const unmetDescription = activeConstraints.map(({ description }) => description).join("; ");
  warnings.push(`No stable Nextflow release matched these resolved requirements: ${unmetDescription}.`);
  return {
    reason: `No stable Nextflow release matched these resolved requirements: ${unmetDescription}. Set a manual override to continue.`,
    source: "no-match",
    sourceLabel: "Manual input required",
    version: null,
    warnings,
  };
}

export const __internal = {
  buildActiveConstraints,
  buildPluginConstraints,
  buildPredicate,
  matchesAllConstraints,
  matchesConstraint,
  normalizeConstraint,
  parseVersion,
  tokenizeConstraint,
};