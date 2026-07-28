import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { PlotlyFigure } from './figureSource';

export type PanelMode = 'shared' | 'new';

const VIEW_TYPE = 'plotlyPreview';
const SHARED_TITLE = 'Plotly Preview';

/**
 * Owns the webview tabs.
 *
 * `shared` mode reuses a single "Plotly Preview" tab; `new` mode opens an independent tab per
 * invocation, so figures can be compared side by side.
 */
export class PanelManager implements vscode.Disposable {
	private shared?: vscode.WebviewPanel;
	private readonly extras = new Set<vscode.WebviewPanel>();

	constructor(private readonly extensionUri: vscode.Uri) {}

	render(name: string, figure: PlotlyFigure, mode: PanelMode): void {
		const panel = mode === 'shared' ? this.sharedPanel() : this.newPanel(name);
		panel.reveal(panel.viewColumn, true);
		// Reusing a panel means only posting the figure — rebuilding the HTML would reload
		// plotly.js and throw away the current zoom/pan state.
		void panel.webview.postMessage({ type: 'render', name, figure });
	}

	private sharedPanel(): vscode.WebviewPanel {
		if (this.shared) {
			return this.shared;
		}

		const panel = this.createPanel(SHARED_TITLE);
		panel.onDidDispose(() => {
			this.shared = undefined;
		});
		this.shared = panel;
		return panel;
	}

	private newPanel(name: string): vscode.WebviewPanel {
		const panel = this.createPanel(`Plotly: ${name}`);
		this.extras.add(panel);
		panel.onDidDispose(() => this.extras.delete(panel));
		return panel;
	}

	private createPanel(title: string): vscode.WebviewPanel {
		const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: true,
		}, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'media'),
				vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'plotly.js-dist-min'),
			],
		});

		panel.webview.html = this.html(panel.webview);
		return panel;
	}

	private html(webview: vscode.Webview): string {
		const plotlyUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'plotly.js-dist-min', 'plotly.min.js'),
		);
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
		const nonce = randomUUID().replace(/-/g, '');

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

	dispose(): void {
		this.shared?.dispose();
		for (const panel of [...this.extras]) {
			panel.dispose();
		}
		this.extras.clear();
	}
}
