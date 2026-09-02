"""Manual test bed for the image side of the extension.

Run this under the VS Code Python debugger, stop at the `breakpoint()` near the bottom, then
either right-click a variable in the Variables pane:

    Open Image                 -> reuses the shared "Image Preview" tab
    Open Image in New Tab      -> opens an independent tab

or select an expression in this file and press the shortcut (Ctrl+Alt+V / Cmd+Alt+V). The shortcut
evaluates whatever is selected, so it reaches things the Variables pane cannot name on its own —
try selecting `batch[2]`, `depth[100:200, 100:200]` or `rgb[..., 0]`.

`torch` is optional; the tensor fixtures are skipped when it is not installed.
"""

import numpy as np
from PIL import Image

rng = np.random.default_rng(0)


def photo_like(height: int = 240, width: int = 320) -> np.ndarray:
    """uint8 RGB — the ordinary case, shown as-is with no rescaling."""
    y, x = np.mgrid[0:height, 0:width]
    red = (x / width * 255).astype(np.uint8)
    green = (y / height * 255).astype(np.uint8)
    blue = ((np.sin(x / 18) * np.cos(y / 18) + 1) * 127).astype(np.uint8)
    return np.dstack([red, green, blue])


def depth_map(height: int = 240, width: int = 320) -> np.ndarray:
    """float32 in metres — meaningless as raw pixels, so it gets min/max normalized."""
    y, x = np.mgrid[0:height, 0:width]
    distance = np.hypot(x - width / 2, y - height / 2)
    return (0.8 + distance / 40).astype(np.float32)


def logits(height: int = 64, width: int = 64) -> np.ndarray:
    """float64 straddling zero — normalization has to handle the negative half."""
    y, x = np.mgrid[0:height, 0:width]
    return np.sin(x / 6.0) * 4.0 - np.cos(y / 9.0) * 3.0


def with_holes(height: int = 120, width: int = 120) -> np.ndarray:
    """NaNs where a sensor returned nothing — they must not swallow the whole range."""
    array = depth_map(height, width).astype(np.float64)
    array[rng.random(array.shape) < 0.05] = np.nan
    return array


def rgba_gradient(size: int = 200) -> np.ndarray:
    """A real alpha channel, to check the checkerboard toggle."""
    y, x = np.mgrid[0:size, 0:size]
    alpha = (255 - np.hypot(x - size / 2, y - size / 2) * 2).clip(0, 255)
    return np.dstack(
        [
            (x / size * 255),
            (y / size * 255),
            np.full_like(x, 180),
            alpha,
        ]
    ).astype(np.uint8)


def main() -> None:
    rgb = photo_like()                                   # (240, 320, 3) uint8
    grey = rgb[..., 0]                                   # (240, 320)    uint8
    depth = depth_map()                                  # (240, 320)    float32, ~0.8 .. 6.8
    scores = logits()                                    # (64, 64)      float64, negative values
    holes = with_holes()                                 # (120, 120)    float64 with NaNs
    rgba = rgba_gradient()                               # (200, 200, 4) uint8
    mask = depth > 3.5                                   # (240, 320)    bool
    sixteen_bit = (depth / depth.max() * 65535).astype(np.uint16)
    chw = np.transpose(rgb, (2, 0, 1))                   # (3, 240, 320) channel-first
    batch = np.stack([photo_like(64, 64) for _ in range(4)])  # (4, 64, 64, 3)
    huge = rng.integers(0, 255, (3000, 4000), dtype=np.uint8)  # over the pixel budget

    pil_rgb = Image.fromarray(rgb)
    pil_grey = pil_rgb.convert("L")
    pil_palette = pil_rgb.convert("P")
    pil_float = Image.fromarray(depth, mode="F")

    tensor_chw = tensor_float = tensor_batch = None
    try:
        import torch
    except ImportError:
        print("torch is not installed; skipping the tensor fixtures.")
    else:
        tensor_chw = torch.from_numpy(chw.copy())                    # (3, H, W) uint8
        tensor_float = torch.from_numpy(depth.copy()).unsqueeze(0)   # (1, H, W) float32
        tensor_batch = torch.rand(8, 3, 64, 64, requires_grad=True)  # a batch, with a grad_fn

    # Rejection-path fixtures: none of these is previewable.
    not_an_image = {"a": 1, "b": [2, 3]}
    some_string = "hello"
    wrong_shape = np.zeros((5, 6, 7))

    print("Right-click any of these in Variables, or select an expression and press Ctrl+Alt+V.")
    breakpoint()  # <-- STOP HERE

    del rgb, grey, depth, scores, holes, rgba, mask, sixteen_bit, chw, batch, huge
    del pil_rgb, pil_grey, pil_palette, pil_float
    del tensor_chw, tensor_float, tensor_batch
    del not_an_image, some_string, wrong_shape


if __name__ == "__main__":
    main()
