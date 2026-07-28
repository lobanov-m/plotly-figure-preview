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

## Remote sessions and containers

Works unchanged over Remote-SSH, Dev Containers, WSL, and plain `debugpy` attach to a container or
another host. **Nothing is written to disk**, so the editor and the interpreter do not need to share
a filesystem — the figure travels entirely over the Debug Adapter Protocol.

The only requirement is that `plotly` is importable *in the interpreter being debugged*. It does not
need to be installed on the machine running VS Code.

For the attach case, run this inside the container:

```bash
pip install debugpy plotly
python -m debugpy --listen 0.0.0.0:5678 --wait-for-client your_script.py
```

then use the **Python: Attach (remote or container)** configuration in
[sample/.vscode/launch.json](sample/.vscode/launch.json), adjusting `pathMappings` to match.

## How it works

1. The `debug/variables/context` menu hands the command the selected variable, including its
   `evaluateName`.
2. The extension resolves the top stack frame of the stopped thread via the Debug Adapter Protocol
   (`threads` → `stackTrace`).
3. Inside the debuggee, one `evaluate` serializes the figure and stashes it on `builtins`:
   `base64(zlib(plotly.io.to_json(fig)))`.
4. The extension reads that payload back in 32 KB slices, verifies the reassembled length against
   the length the debuggee reported, then inflates and parses it.
5. The JSON is posted to a webview that renders it with `Plotly.react`.

**Why chunked instead of one call:** debugpy truncates `evaluate` results at **65,538 characters**
(65,536 plus the repr's two quotes) — measured directly against debugpy 1.8.21. Returning
`fig.to_json()` in one shot would silently corrupt any figure past that size. `sample_figures.py`
includes a 50,000-point trace, which is 1.37 MB of JSON and 1.12 MB after compression and encoding:
36 round trips, about 0.3 s locally.

The stash key is a fresh UUID per inspection, so concurrent inspections cannot collide, and it is
popped off `builtins` in a `finally`.

## Limitations

- **Top frame only.** The context-menu argument carries no frame id, so expressions are evaluated
  against the top stack frame. Selecting a caller frame in the Call Stack pane and inspecting a
  local from *that* frame will report the name as unresolvable.
- `plotly` must be installed in the interpreter being debugged, not just in the extension host.
- The debuggee must be paused; the transfer needs a live frame to evaluate against.

## Packaging

```bash
npx @vscode/vsce package
```

`.vscodeignore` deliberately re-includes `node_modules/plotly.js-dist-min/plotly.min.js`, which the
webview loads at runtime.
