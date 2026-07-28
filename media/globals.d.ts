/**
 * Globals injected into the webview at runtime rather than imported:
 * `Plotly` by the bundled plotly.min.js, `acquireVsCodeApi` by VS Code itself.
 */

declare const Plotly: {
	react(
		root: HTMLElement | string,
		data: unknown[],
		layout: Record<string, unknown>,
		config?: Record<string, unknown>,
	): Promise<unknown>;
};

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): any;
	setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
