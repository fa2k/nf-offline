# nf-core Offline Prep Command Generator

Small static web app for preparing nf-core pipelines for offline or air-gapped execution.

The app is available at: https://fa2k.github.io/nf-offline/


The app runs entirely in the browser. It uses live GitHub data to:

- list nf-core pipelines and releases
- fetch the selected release's `nextflow.config`
- extract `manifest.nextflowVersion`
- extract any `plugins { ... }` block
- resolve pinned plugin minimum Nextflow versions from public GitHub plugin repositories when possible
- generate two copy-paste shell command blocks for offline prep

## Generated command blocks

1. Prepare the offline bundle in one script: download the pipeline and Singularity image files, fetch the standalone Nextflow `-dist` runtime, pre-install pinned plugins, and package the bundle for transfer
2. Run the downloaded pipeline offline with `NXF_OFFLINE=true`

## Running the app

This project has no backend and no build step.

Serve the folder with any static file server, for example:

```bash
cd /Users/paalmbj/git/nf-offline
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

## Data sources

The app talks directly to public GitHub endpoints:

- `https://api.github.com/orgs/nf-core/repos`
- `https://api.github.com/repos/nf-core/<pipeline>/releases`
- `https://raw.githubusercontent.com/nf-core/<pipeline>/<tag>/nextflow.config`
- `https://api.github.com/repos/nextflow-io/nextflow/releases`
- GitHub plugin repository search, tags, tagged trees, and tagged raw metadata files for pinned plugin resolution

There is no server-side proxy, database, or authentication layer.

## Important behavior

- The pipeline list is fetched live from GitHub and filtered client-side.
- Release metadata is fetched live from GitHub releases, with a tags fallback if needed.
- Plugin install commands are only generated from explicitly pinned `plugin@version` entries found in `nextflow.config`.
- Runtime recommendation uses the parsed workflow manifest constraint plus any pinned plugin requirements that can be resolved from tagged public GitHub metadata.
- When requirements are available, the recommended runtime is the minimum stable Nextflow release that satisfies them.
- Nextflow runtime download commands always target the standalone `nextflow-<version>-dist` asset, not the bootstrap launcher.
- A leading `!` in `manifest.nextflowVersion` is treated as Nextflow's strict-enforcement marker, not as a negation operator.
- If no compatible runtime version can be inferred, the app leaves a manual override path instead of silently guessing.

## Verified Sarek behavior

The current implementation is validated against `nf-core/sarek` release `3.8.1`.

Expected plugin block:

- `nf-core-utils@0.4.0`
- `nf-fgbio@1.0.0`
- `nf-prov@1.2.2`
- `nf-schema@2.6.1`

Expected manifest constraint:

- `!>=25.10.2`

Expected runtime selection:

- minimum stable Nextflow release that satisfies `>=25.10.2`

The `!` prefix in `manifest.nextflowVersion = '!>=25.10.2'` means Nextflow should stop if the current runtime does not satisfy `>=25.10.2`; it does not invert the constraint. For this release, the pinned `nf-core-utils@0.4.0`, `nf-fgbio@1.0.0`, `nf-prov@1.2.2`, and `nf-schema@2.6.1` plugin metadata all resolve from tagged public GitHub sources, and the combined requirement remains `>=25.10.2`.

## Limitations

- Browser GitHub API rate limits still apply.
- The pipeline filtering is heuristic. If a repo is not listed, you can still type its name manually.
- The app generates POSIX shell commands only.
- The app does not validate full pipeline runtime arguments; it appends whatever offline run arguments you provide.
