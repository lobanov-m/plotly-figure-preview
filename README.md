# Plotly Figure Preview

Right-click a Plotly figure in the Python debugger's **Variables** pane and render it as a **fully
interactive** chart in an editor tab — zoom, pan, hover, rotate, toggle legend entries.

`plotly.js` is bundled with the extension, so rendering works offline and no `kaleido` /
`write_image` static-export path is involved.

## Usage

While paused at a breakpoint in a Python (`debugpy`) session, right-click a figure variable:

| Menu entry | Behaviour |
| --- | --- |
| **Open Plotly Figure** | Reuses a single shared **Plotly Preview** tab |
| **Open Plotly Figure in New Tab** | Opens an independent tab, for comparing figures side by side |

Works with `plotly.graph_objects.Figure`, `FigureWidget`, `plotly.express` results, and plain
figure dicts.

## Setup

```bash
brew install node        # if you don't already have it
npm install
npm run compile

uv venv && uv sync       # Python sandbox with plotly, for the sample script
```

Press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host.

The dev host opens the **`sample/` folder**, not the repo root — VS Code refuses to open the same
folder in two windows, and the root is already open in the window you press <kbd>F5</kbd> from. The
debug config and interpreter setting the dev host needs therefore live in
[sample/.vscode/](sample/.vscode/) and point back at the root `.venv` via `../`.

## Trying it out

In the Extension Development Host window (whose workspace is `sample/`):

1. Open `sample_figures.py` — it stops at a `breakpoint()` call near the bottom.
2. Run **Python: sample_figures.py** from the debug dropdown. The root `.venv` is already selected
   via `python.defaultInterpreterPath`, so there is no interpreter prompt.
3. At the breakpoint, right-click `fig_px`, `fig_go`, `fig_big`, or `fig_sub` in **Variables**.

The script also defines `not_a_figure` and `some_string` so you can confirm non-figures are
rejected with a readable message.

## How it works

1. The `debug/variables/context` menu hands the command the selected variable, including its
   `evaluateName`.
2. The extension resolves the top stack frame of the stopped thread via the Debug Adapter Protocol
   (`threads` → `stackTrace`).
3. It evaluates `plotly.io.write_json(<var>, '<tmpfile>')` **inside the debuggee**, then reads the
   file back.
4. The JSON is posted to a webview that renders it with `Plotly.react`.

Step 3 goes through a temp file rather than returning the JSON as an expression result because
debugpy truncates long `repr` values — a figure of any realistic size would come back silently
corrupted. `sample_figures.py` includes a 50,000-point trace to exercise this.

## Limitations

- **Top frame only.** The context-menu argument carries no frame id, so expressions are evaluated
  against the top stack frame. Selecting a caller frame in the Call Stack pane and inspecting a
  local from *that* frame will report the name as unresolvable.
- **Local debugging only.** The temp file is written on the debuggee's filesystem. Remote, WSL, or
  container interpreters that don't share a filesystem with the editor are not supported.
- `plotly` must be installed in the interpreter being debugged, not just in the extension host.

## Packaging

```bash
npx @vscode/vsce package
```

`.vscodeignore` deliberately re-includes `node_modules/plotly.js-dist-min/plotly.min.js`, which the
webview loads at runtime.
