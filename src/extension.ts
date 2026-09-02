import * as vscode from 'vscode';
import { PreviewError, type DebugVariableContext, type PayloadKind } from './debugBridge';
import { fetchPreview, targetFromEditor, targetFromVariable, type Target } from './preview';
import { PanelManager, type PanelMode } from './panels';
import { registerDebugConsole } from './debugConsole';

export function activate(context: vscode.ExtensionContext): void {
	const panels = new PanelManager(context.extensionUri);

	/** Wires one command to a way of naming the target and a kind to demand of it. */
	const register = (
		command: string,
		resolve: (arg: DebugVariableContext | undefined) => Target,
		kind: PayloadKind,
		mode: PanelMode,
	) =>
		vscode.commands.registerCommand(command, (arg?: DebugVariableContext) =>
			open(() => resolve(arg), kind, panels, mode),
		);

	context.subscriptions.push(
		panels,
		// `preview(x)` typed into the Debug Console, which evaluates in the selected frame.
		registerDebugConsole(panels),
		register('plotlyPreview.show', targetFromVariable, 'plotly', 'shared'),
		register('plotlyPreview.showInNewTab', targetFromVariable, 'plotly', 'new'),
		register('plotlyPreview.showImage', targetFromVariable, 'image', 'shared'),
		register('plotlyPreview.showImageInNewTab', targetFromVariable, 'image', 'new'),
		// The keyboard/editor path knows only an expression, so the debuggee decides what it is.
		register('plotlyPreview.showSelection', targetFromEditor, 'auto', 'shared'),
		register('plotlyPreview.showSelectionInNewTab', targetFromEditor, 'auto', 'new'),
	);
}

export function deactivate(): void {
	// PanelManager is disposed via context.subscriptions.
}

async function open(
	resolve: () => Target,
	kind: PayloadKind,
	panels: PanelManager,
	mode: PanelMode,
): Promise<void> {
	try {
		const target = resolve();
		const preview = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: title(kind, target.name) },
			(progress) => fetchPreview(target, kind, progress),
		);
		panels.render(preview, mode);
	} catch (err) {
		// Only PreviewError carries a message meant for humans; anything else is a bug worth
		// surfacing raw.
		const message = err instanceof PreviewError ? err.message : `Preview failed: ${String(err)}`;
		void vscode.window.showErrorMessage(message);
	}
}

function title(kind: PayloadKind, name: string): string {
	const what = kind === 'plotly' ? 'figure' : kind === 'image' ? 'image' : 'value';
	return `Loading ${what} '${name}'…`;
}
