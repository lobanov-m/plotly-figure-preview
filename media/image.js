// @ts-check
/* global acquireVsCodeApi */
(function () {
	'use strict';

	const MIN_SCALE = 0.02;
	const MAX_SCALE = 64;
	/** Zoom steps the +/- buttons snap through, so clicking twice lands somewhere predictable. */
	const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64];

	const vscode = acquireVsCodeApi();
	const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
	const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
	const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
	const notesEl = /** @type {HTMLElement} */ (document.getElementById('notes'));
	const infoEl = /** @type {HTMLElement} */ (document.getElementById('info'));
	const probeEl = /** @type {HTMLElement} */ (document.getElementById('probe'));
	const zoomLabel = /** @type {HTMLElement} */ (document.getElementById('zoom-label'));

	/** Off-screen copy at natural size, kept for `getImageData` pixel readout. */
	const source = document.createElement('canvas');
	const sourceCtx = /** @type {CanvasRenderingContext2D} */ (source.getContext('2d', { willReadFrequently: true }));

	/** @type {{ meta: any, png: string } | null} */
	let current = null;
	let scale = 1;
	let originX = 0;
	let originY = 0;
	let fitted = true;

	restore();
	wireControls();
	wirePointer();
	wireKeyboard();

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || message.type !== 'render' || !message.preview || message.preview.kind !== 'image') {
			return;
		}
		const { meta, png } = message.preview;
		vscode.setState({ meta, png });
		show(meta, png);
	});

	window.addEventListener('resize', () => {
		if (fitted) {
			fit();
		} else {
			apply();
		}
	});

	/** Restores the last image when VS Code recycles a hidden webview. */
	function restore() {
		const previous = vscode.getState();
		if (previous && previous.png) {
			show(previous.meta, previous.png);
		}
	}

	/**
	 * @param {any} meta
	 * @param {string} png base64, without a data: prefix
	 */
	function show(meta, png) {
		const image = new Image();
		image.onload = () => {
			source.width = image.naturalWidth;
			source.height = image.naturalHeight;
			sourceCtx.clearRect(0, 0, source.width, source.height);
			sourceCtx.drawImage(image, 0, 0);

			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(image, 0, 0);

			current = { meta: meta || {}, png };
			statusEl.hidden = true;
			canvas.hidden = false;
			describe(current.meta);
			fit();
		};
		image.onerror = () => {
			canvas.hidden = true;
			statusEl.hidden = false;
			statusEl.textContent = 'The image could not be decoded.';
		};
		image.src = 'data:image/png;base64,' + png;
	}

	/** Writes the one-line summary and any caveats the debuggee reported. */
	function describe(meta) {
		const bits = [];
		if (meta.name) {
			bits.push(meta.name);
		}
		bits.push(meta.width + '×' + meta.height);
		bits.push(channelName(meta.channels));
		if (meta.dtype) {
			bits.push(meta.dtype);
		}
		if (Array.isArray(meta.shape)) {
			bits.push('shape (' + meta.shape.join(', ') + ')');
		}
		if (typeof meta.min === 'number' && typeof meta.max === 'number') {
			bits.push('min ' + format(meta.min) + ' · max ' + format(meta.max));
		}
		if (typeof meta.mean === 'number') {
			bits.push('mean ' + format(meta.mean));
		}
		if (meta.normalized) {
			bits.push('normalized to 0–255');
		}
		if (meta.device && meta.device !== 'cpu') {
			bits.push(meta.device);
		}
		infoEl.textContent = bits.join('  ·  ');

		const notes = Array.isArray(meta.notes) ? meta.notes : [];
		notesEl.textContent = notes.join('  ');
		notesEl.hidden = notes.length === 0;
	}

	function channelName(channels) {
		return { 1: 'grey', 2: 'grey+alpha', 3: 'RGB', 4: 'RGBA' }[channels] || channels + ' channels';
	}

	/** Short but honest: integers stay integral, floats keep four significant digits. */
	function format(value) {
		if (!isFinite(value)) {
			return String(value);
		}
		if (Number.isInteger(value) && Math.abs(value) < 1e6) {
			return String(value);
		}
		return Number(value.toPrecision(4)).toString();
	}

	// ------------------------------------------------------------------ view transform

	function apply() {
		canvas.style.transform = 'translate(' + originX + 'px, ' + originY + 'px) scale(' + scale + ')';
		zoomLabel.textContent = Math.round(scale * 100) + '%';
	}

	function fit() {
		if (!current) {
			return;
		}
		const box = stage.getBoundingClientRect();
		const margin = 16;
		const usable = Math.max(1, box.width - margin * 2);
		const usableHeight = Math.max(1, box.height - margin * 2);
		scale = clamp(Math.min(usable / canvas.width, usableHeight / canvas.height, 1));
		originX = (box.width - canvas.width * scale) / 2;
		originY = (box.height - canvas.height * scale) / 2;
		fitted = true;
		apply();
	}

	function actual() {
		zoomAround(1, stage.clientWidth / 2, stage.clientHeight / 2);
	}

	/** Zooms so the image point under (cx, cy) stays under (cx, cy). */
	function zoomAround(next, cx, cy) {
		next = clamp(next);
		originX = cx - ((cx - originX) / scale) * next;
		originY = cy - ((cy - originY) / scale) * next;
		scale = next;
		fitted = false;
		apply();
	}

	function step(direction) {
		const centreX = stage.clientWidth / 2;
		const centreY = stage.clientHeight / 2;
		if (direction > 0) {
			zoomAround(STEPS.find((s) => s > scale + 1e-9) || MAX_SCALE, centreX, centreY);
		} else {
			const smaller = STEPS.filter((s) => s < scale - 1e-9).pop();
			zoomAround(smaller || MIN_SCALE, centreX, centreY);
		}
	}

	function clamp(value) {
		return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
	}

	// ------------------------------------------------------------------ interaction

	function wireControls() {
		document.getElementById('zoom-in').addEventListener('click', () => step(1));
		document.getElementById('zoom-out').addEventListener('click', () => step(-1));
		document.getElementById('fit').addEventListener('click', fit);
		document.getElementById('actual').addEventListener('click', actual);
		document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save' }));

		toggle('checker', 'checkerboard', true);
		toggle('smooth', 'smooth', false);
	}

	/**
	 * A toolbar button that flips a class on the stage and remembers its position.
	 * @param {string} id
	 * @param {string} className
	 * @param {boolean} initial
	 */
	function toggle(id, className, initial) {
		const button = /** @type {HTMLElement} */ (document.getElementById(id));
		let on = initial;
		const paint = () => {
			button.classList.toggle('active', on);
			stage.classList.toggle(className, on);
		};
		button.addEventListener('click', () => {
			on = !on;
			paint();
		});
		paint();
	}

	function wirePointer() {
		let dragging = false;
		let lastX = 0;
		let lastY = 0;

		stage.addEventListener('pointerdown', (event) => {
			dragging = true;
			lastX = event.clientX;
			lastY = event.clientY;
			stage.setPointerCapture(event.pointerId);
			stage.classList.add('dragging');
		});

		stage.addEventListener('pointermove', (event) => {
			if (dragging) {
				originX += event.clientX - lastX;
				originY += event.clientY - lastY;
				lastX = event.clientX;
				lastY = event.clientY;
				fitted = false;
				apply();
				return;
			}
			probe(event);
		});

		const stop = (event) => {
			if (!dragging) {
				return;
			}
			dragging = false;
			stage.releasePointerCapture(event.pointerId);
			stage.classList.remove('dragging');
		};
		stage.addEventListener('pointerup', stop);
		stage.addEventListener('pointercancel', stop);
		stage.addEventListener('pointerleave', () => {
			probeEl.textContent = '';
		});
		stage.addEventListener('dblclick', fit);

		stage.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				const box = stage.getBoundingClientRect();
				// A trackpad reports small deltas continuously; the exponential keeps it smooth.
				const factor = Math.exp(-event.deltaY * 0.0025);
				zoomAround(scale * factor, event.clientX - box.left, event.clientY - box.top);
			},
			{ passive: false },
		);
	}

	function wireKeyboard() {
		stage.addEventListener('keydown', (event) => {
			if (event.key === '+' || event.key === '=') {
				step(1);
			} else if (event.key === '-' || event.key === '_') {
				step(-1);
			} else if (event.key === '0') {
				fit();
			} else if (event.key === '1') {
				actual();
			} else {
				return;
			}
			event.preventDefault();
		});
	}

	/** Reports the pixel under the cursor, in image coordinates and in original units. */
	function probe(event) {
		if (!current) {
			return;
		}
		const box = stage.getBoundingClientRect();
		const x = Math.floor((event.clientX - box.left - originX) / scale);
		const y = Math.floor((event.clientY - box.top - originY) / scale);
		if (x < 0 || y < 0 || x >= source.width || y >= source.height) {
			probeEl.textContent = '';
			return;
		}

		const [r, g, b, a] = sourceCtx.getImageData(x, y, 1, 1).data;
		const meta = current.meta;
		const channels = meta.channels || 4;
		let value;
		if (channels === 1) {
			value = String(r);
		} else if (channels === 2) {
			value = r + ', a ' + a;
		} else if (channels === 3) {
			value = r + ', ' + g + ', ' + b;
		} else {
			value = r + ', ' + g + ', ' + b + ', ' + a;
		}

		let suffix = '';
		// Only single-channel data has an unambiguous inverse: the same min/max mapped every pixel.
		if (meta.normalized && channels === 1 && typeof meta.min === 'number' && typeof meta.max === 'number') {
			suffix = '  ≈ ' + format(meta.min + (r / 255) * (meta.max - meta.min));
		}
		probeEl.textContent = '[' + y + ', ' + x + ']  ' + value + suffix;
	}
})();
