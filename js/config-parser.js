function stripInlineComment(line) {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const current = line[index];
    const previous = index > 0 ? line[index - 1] : "";

    if (current === "'" && previous !== "\\" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (current === '"' && previous !== "\\" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && current === "/" && line[index + 1] === "/") {
      return line.slice(0, index).trimEnd();
    }
  }

  return line;
}

function skipQuoted(text, startIndex) {
  const quote = text[startIndex];
  let index = startIndex + 1;

  while (index < text.length) {
    if (text[index] === quote && text[index - 1] !== "\\") {
      return index;
    }

    index += 1;
  }

  return text.length - 1;
}

function skipLineComment(text, startIndex) {
  const nextBreak = text.indexOf("\n", startIndex + 2);

  return nextBreak === -1 ? text.length : nextBreak;
}

function skipBlockComment(text, startIndex) {
  const closeIndex = text.indexOf("*/", startIndex + 2);

  return closeIndex === -1 ? text.length - 1 : closeIndex + 1;
}

function findBlockStart(text, blockName) {
  const matcher = new RegExp(`(?:^|[^A-Za-z0-9_])${blockName}\\s*\\{`, "g");
  const match = matcher.exec(text);

  return match ? match.index + match[0].lastIndexOf("{") : -1;
}

function extractBlock(text, blockName) {
  const blockStart = findBlockStart(text, blockName);

  if (blockStart === -1) {
    return null;
  }

  let depth = 0;
  let blockContentStart = -1;

  for (let index = blockStart; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (current === "'" || current === '"') {
      index = skipQuoted(text, index);
      continue;
    }

    if (current === "/" && next === "/") {
      index = skipLineComment(text, index);
      continue;
    }

    if (current === "/" && next === "*") {
      index = skipBlockComment(text, index);
      continue;
    }

    if (current === "{") {
      depth += 1;
      if (depth === 1) {
        blockContentStart = index + 1;
      }
      continue;
    }

    if (current === "}") {
      depth -= 1;
      if (depth === 0 && blockContentStart !== -1) {
        return text.slice(blockContentStart, index);
      }
    }
  }

  return null;
}

function parsePluginsBlock(blockText) {
  if (!blockText) {
    return [];
  }

  const plugins = [];
  const lines = blockText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();

    if (!line) {
      continue;
    }

    const match = line.match(/^id\s+['"]([^'"]+)['"]$/);
    if (match) {
      plugins.push(match[1]);
    }
  }

  return plugins;
}

function parseManifestNextflowVersion(blockText) {
  if (!blockText) {
    return null;
  }

  const lines = blockText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();

    if (!line) {
      continue;
    }

    const directAssignment = line.match(/^nextflowVersion\s*=\s*['"]([^'"]+)['"]$/);
    if (directAssignment) {
      return directAssignment[1];
    }
  }

  return null;
}

export function parseNextflowConfig(configText) {
  const pluginsBlock = extractBlock(configText, "plugins");
  const manifestBlock = extractBlock(configText, "manifest");
  const plugins = parsePluginsBlock(pluginsBlock);
  const nextflowVersion = parseManifestNextflowVersion(manifestBlock);

  return {
    nextflowVersion,
    plugins,
    hasPluginsBlock: pluginsBlock !== null,
    hasManifestBlock: manifestBlock !== null,
  };
}

export const __internal = {
  extractBlock,
  parseManifestNextflowVersion,
  parsePluginsBlock,
  stripInlineComment,
};