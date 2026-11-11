# Release Overlap Inspector

`sf-release-conflict-checker` — a VS Code extension that identifies common Salesforce metadata between releases or user stories and shows the Git diffs.

**Guide:** [docs/Release-Overlap-Inspector-Guide.html](docs/Release-Overlap-Inspector-Guide.html) explains why bundling from UAT needs this check, how to set it up and how to read the results. Download it and open it in a browser.

## Install

The packaged extension is committed in this repo: **`sf-release-conflict-checker-1.1.0.vsix`**.

**From the VS Code UI**
1. Download `sf-release-conflict-checker-1.1.0.vsix` from this repo.
2. Open Extensions (`Ctrl+Shift+X`) → `…` menu → **Install from VSIX…** → pick the file.
3. Run **Developer: Reload Window**.

**From a terminal**
```
code --install-extension sf-release-conflict-checker-1.1.0.vsix --force
```

To update, install the new file over the old one (`--force`).

## Build from source

```
npm install
npm run compile
npx vsce package
```

Requires Node 18+. Produces `sf-release-conflict-checker-1.1.0.vsix`.
