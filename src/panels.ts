import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import type { Preview } from './preview';

export type PanelMode = 'shared' | 'new';
type PanelKind = Preview['kind'];

const VIEW_TYPE = { plotly: 'plotlyPreview', image: 'plotlyPreview.image' } as const;
const SHARED_TITLE = { plotly: 'Plotly Preview', image: 'Image Preview' } as const;
const TITLE_PREFIX = { plotly: 'Plotly', image: 'Image' } as const;

/**
 * Owns the webview tabs.
 *
 * `shared` mode reuses one tab per kind; `new` mode opens an independent tab per invocation, so
 * figures and images can be compared side by side. Plotly and image previews never share a tab —
 * their documents load different scripts.
 */
export class PanelManager implements vscode.Disposable {
	private readonly shared = new Map<PanelKind, vscode.WebviewPanel>();
	private readonly extras = new Set<vscode.WebviewPanel>();
	/** Last image shown in each panel, so "Save PNG…" has something to write. */
	private readonly images = new WeakMap<vscode.WebviewPanel, { name: string; png: string }>();

	constructor(private readonly extensionUri: vscode.Uri) {}

	render(preview: Preview, mode: PanelMode): void {
		const panel =
			mode === 'shared' ? this.sharedPanel(preview.kind) : this.newPanel(preview.kind, preview.name);
		panel.reveal(panel.viewColumn, true);
		if (preview.kind === 'image') {
			this.images.set(panel, { name: preview.name, png: preview.png });
		}
		// Reusing a panel means only posting the payload — rebuilding the HTML would reload
		// plotly.js and throw away the current zoom/pan state.
		void panel.webview.postMessage({ type: 'render', preview });
	}

	private sharedPanel(kind: PanelKind): vscode.WebviewPanel {
		const existing = this.shared.get(kind);
		if (existing) {
			return existing;
		}

		const panel = this.createPanel(kind, SHARED_TITLE[kind]);
		panel.onDidDispose(() => this.shared.delete(kind));
		this.shared.set(kind, panel);
		return panel;
	}

	private newPanel(kind: PanelKind, name: string): vscode.WebviewPanel {
		const panel = this.createPanel(kind, `${TITLE_PREFIX[kind]}: ${name}`);
		this.extras.add(panel);
		panel.onDidDispose(() => this.extras.delete(panel));
		return panel;
	}

	private createPanel(kind: PanelKind, title: string): vscode.WebviewPanel {
		const roots = [vscode.Uri.joinPath(this.extensionUri, 'media')];
		if (kind === 'plotly') {
			roots.push(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'plotly.js-dist-min'));
		}

		const panel = vscode.window.createWebviewPanel(VIEW_TYPE[kind], title, {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: true,
		}, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: roots,
		});

		panel.webview.html = kind === 'plotly' ? this.plotlyHtml(panel.webview) : this.imageHtml(panel.webview);
		panel.webview.onDidReceiveMessage((message) => this.onMessage(panel, message));
		return panel;
	}

	private onMessage(panel: vscode.WebviewPanel, message: unknown): void {
		if ((message as { type?: string })?.type === 'save') {
			void this.savePng(panel);
		}
	}

	private async savePng(panel: vscode.WebviewPanel): Promise<void> {
		const image = this.images.get(panel);
		if (!image) {
			return;
		}
		// The PNG is exactly what the webview is displaying, normalization included.
		const suggested = `${image.name.replace(/[^\w.-]+/g, '_') || 'image'}.png`;
		const target = await vscode.window.showSaveDialog({
			filters: { 'PNG image': ['png'] },
			defaultUri: vscode.Uri.joinPath(defaultSaveDir(), suggested),
		});
		if (!target) {
			return;
		}
		try {
			await vscode.workspace.fs.writeFile(target, Buffer.from(image.png, 'base64'));
		} catch (err) {
			void vscode.window.showErrorMessage(`Could not save the image: ${String(err)}`);
		}
	}

	private uri(webview: vscode.Webview, ...segments: string[]): vscode.Uri {
		return webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...segments));
	}

	private plotlyHtml(webview: vscode.Webview): string {
		const plotlyUri = this.uri(webview, 'node_modules', 'plotly.js-dist-min', 'plotly.min.js');
		const scriptUri = this.uri(webview, 'media', 'main.js');
		const styleUri = this.uri(webview, 'media', 'style.css');
		const nonce = newNonce();

		// plotly.js writes inline styles, hence 'unsafe-inline' for style-src. Its regl/gl-based
		// traces compile shaders through Function(), hence 'unsafe-eval' for script-src.
		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}' 'unsafe-eval'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`img-src ${webview.cspSource} data: blob:`,
			`font-src ${webview.cspSource}`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Plotly Preview</title>
</head>
<body>
	<div id="status" class="status">Waiting for a figure…</div>
	<div id="plot"></div>
	<script nonce="${nonce}" src="${plotlyUri}"></script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private imageHtml(webview: vscode.Webview): string {
		const scriptUri = this.uri(webview, 'media', 'image.js');
		const styleUri = this.uri(webview, 'media', 'image.css');
		const nonce = newNonce();

		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`img-src ${webview.cspSource} data: blob:`,
			`font-src ${webview.cspSource}`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Image Preview</title>
</head>
<body>
	<div id="toolbar">
		<button id="zoom-out" title="Zoom out (-)">&minus;</button>
		<span id="zoom-label">100%</span>
		<button id="zoom-in" title="Zoom in (+)">&plus;</button>
		<button id="fit" title="Fit to window (0)">Fit</button>
		<button id="actual" title="Actual size (1)">1:1</button>
		<button id="checker" class="toggle" title="Checkerboard behind transparent pixels">Alpha</button>
		<button id="smooth" class="toggle" title="Smooth instead of showing hard pixels when zoomed in">Smooth</button>
		<span class="spacer"></span>
		<button id="save" title="Save the rendered PNG">Save PNG…</button>
	</div>
	<div id="stage" tabindex="0">
		<div id="status">Waiting for an image…</div>
		<canvas id="canvas" hidden></canvas>
	</div>
	<div id="notes" hidden></div>
	<div id="statusbar">
		<span id="info"></span>
		<span id="probe"></span>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		for (const panel of [...this.shared.values(), ...this.extras]) {
			panel.dispose();
		}
		this.shared.clear();
		this.extras.clear();
	}
}

function newNonce(): string {
	return randomUUID().replace(/-/g, '');
}

/** Somewhere sensible to point the save dialog at, without assuming a workspace is open. */
function defaultSaveDir(): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? folder.uri : vscode.Uri.file(homedir());
}
