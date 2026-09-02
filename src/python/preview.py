"""Serializer that runs *inside the debuggee*.

The extension exec()s this source into the debuggee's ``builtins`` namespace and then calls
``__pfp_v1__(obj, kind, options)``. The return value is always a JSON string, which the caller
compresses, base64-encodes and reads back over the Debug Adapter Protocol in slices.

Constraints this file has to respect, because it runs in somebody else's interpreter:

* **No imports beyond the standard library.** ``numpy``/``torch``/``PIL`` are looked up in
  ``sys.modules`` or imported defensively, never assumed.
* **Nothing is written to disk** — the debuggee may be in a container with no shared filesystem.
* **Nothing is mutated.** Tensors are detached and copied, never modified in place.
* Python 3.7+ syntax only.

The JSON is one of:

    {"kind": "plotly", "figure": {...}}
    {"kind": "image", "meta": {...}, "png": "<base64>"}
    {"error": "message shown verbatim to the user"}
"""


def _pfp_build():
    import base64
    import json
    import struct
    import sys
    import zlib

    # ---------------------------------------------------------------- type detection

    def class_path(obj):
        cls = type(obj)
        return (getattr(cls, "__module__", "") or "") + "." + cls.__name__

    def root_module(obj):
        return ((getattr(type(obj), "__module__", "") or "").split(".") or [""])[0]

    def is_plotly(obj):
        if root_module(obj) == "plotly":
            return True
        # `to_plotly_json` is the duck type every plotly figure-like object implements.
        if callable(getattr(obj, "to_plotly_json", None)):
            return True
        return isinstance(obj, dict) and ("data" in obj or "layout" in obj)

    def is_torch(obj):
        if root_module(obj) != "torch":
            return False
        return type(obj).__name__ in ("Tensor", "Parameter", "nn.Parameter") or hasattr(obj, "detach")

    def is_numpy(obj):
        np = sys.modules.get("numpy")
        return np is not None and isinstance(obj, np.ndarray)

    def pil_image(obj):
        """Returns the PIL Image base class if `obj` is one, else None (without importing PIL)."""
        for base in type(obj).__mro__:
            if getattr(base, "__module__", "") == "PIL.Image" and base.__name__ == "Image":
                return base
        return None

    def is_image(obj):
        return is_numpy(obj) or is_torch(obj) or pil_image(obj) is not None

    # ---------------------------------------------------------------- numpy access

    def require_numpy():
        try:
            import numpy
        except ImportError:
            raise PreviewError(
                "numpy is not installed in the interpreter being debugged, and it is needed to "
                "convert this value into an image."
            )
        return numpy

    class PreviewError(Exception):
        """Carries a message meant for a human; the extension shows it verbatim."""

    # ---------------------------------------------------------------- PNG encoding

    def png_via_pil(array, channels):
        """Encodes with PIL when it is available — much faster, and it filters rows properly."""
        try:
            from PIL import Image
        except Exception:
            return None
        import io

        mode = {1: "L", 2: "LA", 3: "RGB", 4: "RGBA"}[channels]
        source = array[:, :, 0] if channels == 1 else array
        buffer = io.BytesIO()
        try:
            Image.fromarray(source, mode=mode).save(buffer, format="PNG", optimize=False)
        except Exception:
            return None
        return buffer.getvalue()

    def png_pure(data, width, height, channels):
        """Minimal PNG writer: 8-bit, no interlace, filter type 0 on every row.

        The fallback for interpreters without PIL. Row filtering is skipped because doing it in
        pure Python costs more than the bytes it saves at this size.
        """
        color_type = {1: 0, 2: 4, 3: 2, 4: 6}[channels]
        stride = width * channels
        view = memoryview(data)
        raw = bytearray(height * (stride + 1))
        for y in range(height):
            start = y * (stride + 1)
            raw[start] = 0  # filter: None
            raw[start + 1 : start + 1 + stride] = view[y * stride : (y + 1) * stride]

        def chunk(tag, payload):
            crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
            return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

        header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b"")
        )

    def encode_png(array):
        """`array` is a contiguous uint8 (H, W, C) numpy array with C in 1..4."""
        np = require_numpy()
        array = np.ascontiguousarray(array, dtype=np.uint8)
        height, width, channels = array.shape
        blob = png_via_pil(array, channels)
        if blob is None:
            blob = png_pure(array.tobytes(), width, height, channels)
        return base64.b64encode(blob).decode("ascii")

    # ---------------------------------------------------------------- shape handling

    def as_hwc(array, prefer_chw, notes):
        """Normalizes any supported shape to (H, W, C), reporting what it assumed."""
        np = require_numpy()

        # Peel leading singleton dimensions: (1, 1, 3, H, W) and friends.
        while array.ndim > 3 and array.shape[0] == 1:
            array = array[0]
        if array.ndim == 4:
            notes.append("Batch of %d; showing index 0." % array.shape[0])
            array = array[0]
            while array.ndim > 3 and array.shape[0] == 1:
                array = array[0]

        if array.ndim > 4:
            raise PreviewError(
                "Cannot display a %d-dimensional array as an image (shape %s)."
                % (array.ndim, tuple(array.shape))
            )
        if array.ndim < 2:
            raise PreviewError(
                "Cannot display a %d-dimensional array as an image (shape %s). An image needs at "
                "least a height and a width." % (array.ndim, tuple(array.shape))
            )

        if array.ndim == 2:
            return array[:, :, None], "HW"

        # Which axis holds the colour channels? Sizes 1, 3 and 4 are unmistakable; 2 (grey+alpha)
        # is accepted only when neither end offers something stronger, since a 2-row array is far
        # more often two stacked greyscales than one LA image. When both ends qualify — (3, 3, 3),
        # (4, H, 3) — the caller's convention breaks the tie: torch tensors are channel-first,
        # numpy arrays and PIL buffers are channel-last.
        for sizes in ((1, 3, 4), (1, 2, 3, 4)):
            chw = array.shape[0] in sizes
            hwc = array.shape[-1] in sizes
            if not (chw or hwc):
                continue
            if chw and hwc:
                notes.append(
                    "Shape %s is ambiguous; read as %s."
                    % (
                        tuple(array.shape),
                        "channel-first (CHW)" if prefer_chw else "channel-last (HWC)",
                    )
                )
            if hwc and not (chw and prefer_chw):
                return array, "HWC"
            return np.transpose(array, (1, 2, 0)), "CHW"

        raise PreviewError(
            "Cannot display an array of shape %s as an image: no axis of size 1, 2, 3 or 4 to read "
            "as colour channels. Slice it down first, e.g. `arr[0]` or `arr[..., 0]`."
            % (tuple(array.shape),)
        )

    def decimate(array, max_pixels, notes):
        """Keeps huge arrays from stalling the transfer, at the cost of resolution."""
        height, width = array.shape[0], array.shape[1]
        if max_pixels <= 0 or height * width <= max_pixels:
            return array
        step = 1
        while (height // (step + 1)) * (width // (step + 1)) > max_pixels:
            step += 1
        step += 1
        notes.append(
            "Downsampled %dx%d by taking every %dth pixel (over the %s pixel limit)."
            % (width, height, step, "{:,}".format(max_pixels))
        )
        return array[::step, ::step]

    # ---------------------------------------------------------------- value normalization

    def to_uint8(array, mode, meta, notes):
        """Maps arbitrary numeric data onto 0..255, recording in `meta` how it was mapped."""
        np = require_numpy()
        kind = array.dtype.kind

        if kind == "c":
            notes.append("Complex input; showing the magnitude.")
            array = np.abs(array)
            kind = array.dtype.kind
        elif kind not in ("f", "i", "u", "b"):
            raise PreviewError("Cannot display an array of dtype '%s' as an image." % array.dtype)

        # Non-finite values would poison min/max, so the range is measured over the finite ones.
        finite = array
        if kind == "f":
            mask = np.isfinite(array)
            if not bool(mask.all()):
                notes.append(
                    "Non-finite values are outside the range: NaN and -Inf render black, +Inf white."
                )
            finite = array[mask] if bool(mask.any()) else np.zeros(1, dtype=array.dtype)

        low = float(finite.min()) if finite.size else 0.0
        high = float(finite.max()) if finite.size else 0.0
        meta["min"] = low
        meta["max"] = high
        meta["mean"] = float(finite.mean()) if finite.size else 0.0

        if kind == "b":
            meta["normalized"] = False
            return (array.astype(np.uint8) * 255), meta

        native_uint8 = array.dtype == np.uint8
        if mode == "never" or (mode == "auto" and native_uint8):
            meta["normalized"] = False
            if native_uint8:
                return array, meta
            notes.append("Values clipped to 0..255 without normalization.")
            return np.clip(np.nan_to_num(array, nan=0.0), 0, 255).astype(np.uint8), meta

        meta["normalized"] = True
        if high <= low:
            notes.append("Every value is %g; the image is uniform." % low)
            return np.zeros(array.shape, dtype=np.uint8), meta

        scaled = (array.astype(np.float64) - low) * (255.0 / (high - low))
        scaled = np.nan_to_num(scaled, nan=0.0, posinf=255.0, neginf=0.0)
        return np.clip(scaled, 0, 255).astype(np.uint8), meta

    # ---------------------------------------------------------------- sources

    def from_torch(obj, notes):
        tensor = obj
        if getattr(tensor, "is_sparse", False):
            tensor = tensor.to_dense()
        if hasattr(tensor, "dequantize") and getattr(tensor, "is_quantized", False):
            tensor = tensor.dequantize()
        tensor = tensor.detach()
        if hasattr(tensor, "cpu"):
            tensor = tensor.cpu()
        dtype = str(getattr(tensor, "dtype", ""))
        # numpy has no bfloat16/float16-safe path for some versions; widen first.
        if "bfloat16" in dtype or "float16" in dtype:
            tensor = tensor.float()
        try:
            array = tensor.numpy()
        except Exception as exc:
            raise PreviewError("Could not convert the tensor to a numpy array: %s" % exc)
        info = {
            "source": "torch.Tensor",
            "dtype": dtype or str(array.dtype),
            "device": str(getattr(obj, "device", "")),
            "requires_grad": bool(getattr(obj, "requires_grad", False)),
        }
        return array, info, True

    def from_pil(obj, notes):
        np = require_numpy()
        image = obj
        mode = getattr(image, "mode", "")
        info = {"source": "PIL.Image", "dtype": mode, "pil_mode": mode}
        if mode in ("P", "PA"):
            notes.append("Palette image expanded to RGBA.")
            image = image.convert("RGBA")
        elif mode in ("CMYK", "YCbCr", "LAB", "HSV"):
            notes.append("Converted from %s to RGB for display." % mode)
            image = image.convert("RGB")
        elif mode == "1":
            image = image.convert("L")
        array = np.asarray(image)
        if array.dtype == np.bool_:
            array = array.astype(np.uint8) * 255
        return array, info, False

    def from_numpy(obj, notes):
        np = require_numpy()
        array = obj
        if array.dtype == np.object_:
            raise PreviewError("Cannot display an object-dtype array as an image.")
        if getattr(array, "mask", None) is not None and hasattr(array, "filled"):
            notes.append("Masked array; masked cells are filled with the minimum.")
            array = array.filled(array.min())
        return np.asarray(array), {"source": "numpy.ndarray", "dtype": str(array.dtype)}, False

    # ---------------------------------------------------------------- entry points

    def build_image(obj, name, options):
        np = require_numpy()
        notes = []

        if is_torch(obj):
            array, info, prefer_chw = from_torch(obj, notes)
        elif pil_image(obj) is not None:
            array, info, prefer_chw = from_pil(obj, notes)
        elif is_numpy(obj):
            array, info, prefer_chw = from_numpy(obj, notes)
        else:
            raise PreviewError(
                "'%s' is a %s, which is not a numpy array, a torch tensor or a PIL image."
                % (name, class_path(obj))
            )

        array = np.asarray(array)
        original_shape = tuple(int(d) for d in array.shape)
        array, layout = as_hwc(array, prefer_chw, notes)
        array = decimate(array, int(options.get("maxPixels", 16000000)), notes)

        height, width, channels = array.shape
        if channels not in (1, 2, 3, 4):
            raise PreviewError(
                "Cannot display %d colour channels; expected 1 (grey), 2 (grey+alpha), 3 (RGB) or "
                "4 (RGBA)." % channels
            )

        meta = {
            "name": name,
            "shape": original_shape,
            "layout": layout,
            "width": width,
            "height": height,
            "channels": channels,
            "notes": notes,
        }
        meta.update(info)
        pixels, meta = to_uint8(array, options.get("normalize", "auto"), meta, notes)
        meta["notes"] = notes
        return '{"kind":"image","meta":%s,"png":"%s"}' % (json.dumps(meta), encode_png(pixels))

    def build_plotly(obj, name):
        try:
            import plotly.io
        except ImportError:
            raise PreviewError(
                "plotly is not installed in the interpreter being debugged. Install it there and "
                "restart the session."
            )
        try:
            figure = plotly.io.to_json(obj)
        except Exception as exc:
            first = str(exc).strip().splitlines()
            detail = next((line.strip() for line in first if line.strip()), type(exc).__name__)
            raise PreviewError("'%s' is not a Plotly figure: %s" % (name, detail[:240]))
        return '{"kind":"plotly","figure":%s}' % figure

    def encode(obj, kind, name, options):
        options = options or {}
        try:
            if kind == "plotly":
                return build_plotly(obj, name)
            if kind == "image":
                return build_image(obj, name, options)
            # 'auto': the hotkey path, where the user only told us *what* to look at.
            if is_image(obj):
                return build_image(obj, name, options)
            if is_plotly(obj):
                return build_plotly(obj, name)
            raise PreviewError(
                "'%s' is a %s. This extension previews Plotly figures, numpy arrays, torch tensors "
                "and PIL images." % (name, class_path(obj))
            )
        except PreviewError as exc:
            return json.dumps({"error": str(exc)})

    def compress(text):
        return base64.b64encode(zlib.compress(text.encode("utf-8"), 6)).decode("ascii")

    def entry(obj, kind, name, options=None):
        return compress(encode(obj, kind, name, options))

    return entry


__pfp_v1__ = _pfp_build()
