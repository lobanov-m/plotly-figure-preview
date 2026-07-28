// @ts-check
/* global Plotly, acquireVsCodeApi */
(function () {
	'use strict';

	/** Trace types that render into a `scene` (3-D) subplot rather than a cartesian one. */
	const THREE_D_TRACES = new Set([
		'scatter3d',
		'surface',
		'mesh3d',
		'cone',
		'streamtube',
		'volume',
		'isosurface',
	]);

	const vscode = acquireVsCodeApi();
	const plotEl = document.getElementById('plot');
	const statusEl = document.getElementById('status');

	/** Restores the last figure when VS Code recycles a hidden webview. */
	const previous = vscode.getState();
	if (previous && previous.figure) {
		draw(previous.name, previous.figure);
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || message.type !== 'render') {
			return;
		}
		vscode.setState({ name: message.name, figure: message.figure });
		draw(message.name, message.figure);
	});

	function draw(name, figure) {
		statusEl.hidden = true;
		const data = Array.isArray(figure.data) ? figure.data : [];
		const layout = figure.layout && typeof figure.layout === 'object' ? figure.layout : {};

		// `react` diffs into the existing chart, so re-inspecting the same variable keeps the
		// current camera/zoom instead of resetting it.
		Plotly.react(plotEl, data, themed(layout, data), {
			responsive: true,
			displaylogo: false,
			toImageButtonOptions: { filename: name || 'figure' },
		}).catch((err) => {
			statusEl.hidden = false;
			statusEl.textContent = `Could not render the figure: ${err && err.message ? err.message : err}`;
		});
	}

	/**
	 * Applies editor-theme defaults *underneath* the figure's own layout, so anything the user set
	 * explicitly in Python still wins.
	 *
	 * Plotly attaches a default `template` to every serialized figure, and that template hardcodes
	 * a white paper colour, an #E5ECF6 plot area and dark text — unreadable against a dark editor
	 * theme. Explicit top-level layout attributes take precedence over the template, which is what
	 * these defaults rely on. The merge must be deep: `px` figures already carry an `xaxis` object
	 * (holding the axis title), so a shallow merge would drop the grid colours entirely.
	 *
	 * @param {Record<string, any>} layout
	 * @param {any[]} data
	 */
	function themed(layout, data) {
		const style = getComputedStyle(document.body);
		const foreground = style.getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
		const gridColor = style.getPropertyValue('--vscode-editorIndentGuide-background').trim() || 'rgba(128,128,128,0.35)';

		const axisTheme = { gridcolor: gridColor, zerolinecolor: gridColor };
		/** @type {Record<string, any>} */
		const base = {
			paper_bgcolor: 'rgba(0,0,0,0)',
			plot_bgcolor: 'rgba(0,0,0,0)',
			font: { color: foreground },
			margin: { t: 40, r: 20, b: 45, l: 55 },
		};

		// Cover the default axes plus any numbered ones a subplot grid introduced (xaxis2, yaxis3…).
		const axes = new Set(['xaxis', 'yaxis']);
		for (const key of Object.keys(layout)) {
			if (/^[xy]axis\d*$/.test(key)) {
				axes.add(key);
			}
		}
		for (const key of axes) {
			base[key] = Object.assign({}, axisTheme);
		}

		// 3-D scenes carry their own axes and an opaque background panel. `layout.scene` is usually
		// absent until the user configures it, so infer the need from the trace types instead.
		const has3dTrace = data.some((trace) => THREE_D_TRACES.has(trace && trace.type));
		if (layout.scene || has3dTrace) {
			const sceneAxis = Object.assign({ backgroundcolor: 'rgba(0,0,0,0)' }, axisTheme);
			base.scene = {
				xaxis: Object.assign({}, sceneAxis),
				yaxis: Object.assign({}, sceneAxis),
				zaxis: Object.assign({}, sceneAxis),
			};
		}

		return deepMerge(base, layout);
	}

	/**
	 * Recursive merge where `override` wins. Arrays and non-plain values are taken wholesale.
	 * @param {Record<string, any>} base
	 * @param {Record<string, any>} override
	 * @returns {Record<string, any>}
	 */
	function deepMerge(base, override) {
		/** @type {Record<string, any>} */
		const out = Object.assign({}, base);
		for (const key of Object.keys(override || {})) {
			const value = override[key];
			out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
		}
		return out;
	}

	/** @param {any} value */
	function isPlainObject(value) {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
})();
