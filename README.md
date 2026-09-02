# Plotly & Image Preview for Python Debugging

Look at what your Python debugger is actually holding: **Plotly figures** as fully interactive
charts, and **numpy arrays**, **torch tensors** and **PIL images** as images — in an editor tab,
without a `plt.show()`, a temp file or a notebook.

`plotly.js` is bundled with the extension, so charts render offline and no `kaleido` /
`write_image` static-export path is involved. Images are encoded to PNG inside the debuggee, so
nothing is written to disk on either side.

## What it previews

| Value | Shown as |
| --- | --- |
| `plotly.graph_objects.Figure`, `FigureWidget`, `plotly.express` results, figure dicts | An interactive chart — zoom, pan, hover, rotate, toggle legend entries |
| `numpy.ndarray` | An image, with the dtype, shape and value range in the status bar |
| `torch.Tensor` (including CUDA, `requires_grad`, sparse and quantized tensors) | The same, read channel-first by convention |
| `PIL.Image.Image` | The same, palette and CMYK images converted for display |

## Usage

Pause at a breakpoint in a Python (`debugpy`) session, then either **right-click a variable** in the
**Variables** pane:

| Menu entry | Behaviour |
| --- | --- |
| **Open Plotly Figure** | Reuses a single shared **Plotly Preview** tab |
| **Open Plotly Figure in New Tab** | Opens an independent tab, for comparing figures side by side |
| **Open Image** | Reuses a single shared **Image Preview** tab |
| **Open Image in New Tab** | Opens an independent tab |

…or **select an expression in the editor and press a key**:

| Shortcut | Behaviour |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> on macOS) | Preview the selection in the shared tab |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | Preview the selection in a new tab |

With nothing selected, the identifier under the cursor is used. The shortcut works out for itself
whether it is looking at a figure or an image, and it evaluates an *expression* rather than a named
variable — so it reaches things the Variables pane cannot name on its own:

```python
batch[3]                 # one image out of a batch
depth[100:200, 100:200]  # a crop
logits.softmax(0)[1]     # a computed channel
frame[..., ::-1]         # BGR to RGB
```

Both shortcuts are also on the editor's right-click menu while the debugger is paused, and can be
rebound from **Keyboard Shortcuts** (search for "Python Preview").

## How array values become pixels

An image can only show 0–255 per channel, so anything else has to be mapped onto that range.

* `uint8` and `bool` data is shown as-is.
* **Floats, signed integers and 16-bit data are rescaled by the array's own min and max** — a depth
  map in metres, logits straddling zero and a `float32` in `[0, 1]` all become visible, and the
  status bar reports the range that was used so you can read the picture back.
* NaN and ±Inf are left out of that range: NaN and −Inf render black, +Inf white.
* Complex arrays are shown as their magnitude.

Set `plotlyPreview.image.normalize` to `always` to rescale `uint8` data too, or to `never` to clip
to 0–255 instead.

Shapes are read as `(H, W)`, `(H, W, C)` or `(C, H, W)` with `C` in 1, 2, 3 or 4 — greyscale,
grey+alpha, RGB or RGBA. Leading singleton axes are peeled off, and a batch shows its first element
(use the hotkey on `batch[3]` for the rest). When both ends of a 3-D shape could be the channel
axis, torch tensors are read channel-first and numpy arrays channel-last, and the status bar says
which was assumed.

### In the image tab

Scroll to zoom around the pointer, drag to pan, double-click to fit. **Fit** / **1:1** and the
zoom buttons are on the toolbar, along with **Alpha** (checkerboard behind transparent pixels),
**Smooth** (interpolate instead of showing hard pixel edges) and **Save PNG…**. With focus in the
image, <kbd>+</kbd> / <kbd>-</kbd> zoom, <kbd>0</kbd> fits and <kbd>1</kbd> is actual size.

Hovering reports the pixel under the cursor as `[row, column]` with its value. For normalized
single-channel data it also shows the approximate original value, back-computed from the range in
the status bar.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `plotlyPreview.image.normalize` | `auto` | `auto` rescales everything except `uint8`; `always` rescales `uint8` too; `never` clips to 0–255 |
| `plotlyPreview.image.maxPixels` | `16000000` | Larger images are downsampled by taking every n-th pixel, so a huge array cannot stall the debug session. `0` disables the limit |

## Setup

```bash
brew install node        # if you don't already have it
npm install
npm run compile

uv venv && uv sync       # Python sandbox with plotly, numpy and pillow, for the sample scripts
uv sync --group torch    # optional, for the tensor fixtures
```

Press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host.

The dev host opens the **`sample/` folder**, not the repo root — VS Code refuses to open the same
folder in two windows, and the root is already open in the window you press <kbd>F5</kbd> from. The
debug config and interpreter setting the dev host needs therefore live in
`sample/.vscode/` and point back at the root `.venv` via `../`.

## Trying it out

In the Extension Development Host window (whose workspace is `sample/`):

1. Open `sample_figures.py` or `sample_images.py`; both stop at a `breakpoint()` near the bottom.
2. Run the matching configuration from the debug dropdown. The root `.venv` is already selected via
   `python.defaultInterpreterPath`, so there is no interpreter prompt.
3. At the breakpoint, right-click a variable in **Variables** — or select an expression in the
   editor and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>.

`sample_images.py` covers uint8 RGB, a float depth map, logits straddling zero, an array with NaN
holes, RGBA with a real alpha channel, a bool mask, 16-bit data, channel-first layout, a batch, an
over-budget 12-megapixel array, four flavours of PIL image and (when torch is installed) tensors.
Both scripts also define values that are *not* previewable, so you can confirm they are rejected
with a readable message rather than an empty tab.

## Remote sessions and containers

Works unchanged over Remote-SSH, Dev Containers, WSL, and plain `debugpy` attach to a container or
another host. **Nothing is written to disk**, so the editor and the interpreter do not need to share
a filesystem — figures and images travel entirely over the Debug Adapter Protocol.

The only requirement is that the relevant library is importable *in the interpreter being debugged*:
`plotly` for figures, `numpy` for arrays and tensors. Neither needs to be installed on the machine
running VS Code. `pillow` is used for PNG encoding when it is available, and a pure-Python PNG
writer takes over when it is not.

For the attach case, run this inside the container:

```bash
pip install debugpy plotly
python -m debugpy --listen 0.0.0.0:5678 --wait-for-client your_script.py
```

then use the **Python: Attach (remote or container)** configuration in
`sample/.vscode/launch.json`, adjusting `pathMappings` to match.

## How it works

1. The `debug/variables/context` menu hands the command the selected variable, including its
   `evaluateName`; the keyboard shortcut supplies the editor selection instead.
2. The extension resolves the top stack frame of the stopped thread via the Debug Adapter Protocol
   (`threads` → `stackTrace`).
3. One `evaluate` ships `src/python/preview.py` into the debuggee (zlib'd and base64'd, exec'd into
   a throwaway namespace), runs it against the expression, and stashes the result on `builtins`:
   `base64(zlib(json))`, where the JSON is either the figure or a PNG plus its metadata.
4. The extension reads that payload back in 32 KB slices, verifies the reassembled length against
   the length the debuggee reported, then inflates and parses it.
5. The result is posted to a webview — `Plotly.react` for figures, a canvas for images.
6. A `finally` pops both the payload and the helper, leaving the debuggee exactly as it was found.

**Why chunked instead of one call:** debugpy truncates `evaluate` results at **65,538 characters**
(65,536 plus the repr's two quotes) — measured directly against debugpy 1.8.21. Returning
`fig.to_json()` in one shot would silently corrupt any figure past that size. `sample_figures.py`
includes a 50,000-point trace, which is 1.37 MB of JSON and 1.12 MB after compression and encoding:
36 round trips, about 0.3 s locally.

The stash key is a fresh UUID per inspection, so concurrent inspections cannot collide.

## Limitations

- **Top frame only.** The context-menu argument carries no frame id, so expressions are evaluated
  against the top stack frame. Selecting a caller frame in the Call Stack pane and inspecting a
  local from *that* frame will report the name as unresolvable.
- The keyboard shortcut cannot read the selection in the **Variables** pane — VS Code does not
  expose it to extensions — so it uses the editor selection. Use the right-click menu in the
  Variables pane, or select the name in the editor.
- `plotly` (for figures) and `numpy` (for arrays and tensors) must be installed in the interpreter
  being debugged, not just in the extension host.
- The debuggee must be paused; the transfer needs a live frame to evaluate against.
- Evaluating an expression runs it in the debuggee. That is unavoidable for this to work at all,
  but it means a property with side effects will have them.

## Packaging

```bash
npm run package      # -> plotly-figure-preview-<version>.vsix
```

`.vscodeignore` deliberately re-includes `node_modules/plotly.js-dist-min/plotly.min.js`, which the
webview loads at runtime.

## Releases (GitLab CI)

`.gitlab-ci.yml` builds and typechecks the extension on every push, and packages a `.vsix` as a job
artifact. Pushing a version tag also publishes it:

```bash
# bump "version" in package.json, commit, then:
git tag v0.2.0
git push origin v0.2.0
```

The pipeline refuses to build if the tag and `package.json` disagree. On a matching tag it uploads
the `.vsix` to the project's **Package Registry** (a permanent URL, unlike job artifacts, which
expire) and creates a **GitLab Release** for the tag with that package linked as an asset, together
with its SHA-256.
