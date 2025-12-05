# Projects Explorer
## Development Setup
### 1. Install Dependencies
```sh
npm install
```
### 2. Build
One-time build:
```
npm run compile
```
Watch mode while developing:
```
npm run watch
```
### 3. Launch Extension Development Host
1. Open the project in VS Code.
2. Run → "Run Extension" (F5).
3. A new VS Code window opens with the extension loaded.
### 4. Testing Localization
1. Run the Extension Host (F5).
2.  In the new window:
    - Press Ctrl+Shift+P.
    - Select "Configure Display Language".
    - Choose de for German.
3. Reload the window.
    - Ctrl+Shift+P -> "Developer: Reload Window" OR Ctrl+R
4.  All runtime and manifest texts should now display in German. (or whatever language  you translating to)
## Packaging the Extension (VSIX)
```
npm install --save-dev @vscode/vsce
npm run package
```
The output will be a `.vsix` file:
```
projects-explorer-x.y.z.vsix
```
Install manually in VS Code:
- Extensions panel → "Install from VSIX…"
- OR
- Ctrl+Shift+P -> "Extensions: Install from VSIX..."
## License
See `LICENSE` file.
