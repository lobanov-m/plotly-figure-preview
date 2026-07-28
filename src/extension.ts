import * as vscode from 'vscode';
import { fetchFigure, FigureError, type DebugVariableContext } from './figureSource';
import { PanelManager, type PanelMode } from './panels';

export function activate(context: vscode.ExtensionContext): void {
	const panels = new PanelManager(context.extensionUri);

	context.subscriptions.push(
		panels,
		vscode.commands.registerCommand('plotlyPreview.show', (arg: DebugVariableContext) =>
			open(arg, panels, 'shared'),
		),
		vscode.commands.registerCommand('plotlyPreview.showInNewTab', (arg: DebugVariableContext) =>
			open(arg, panels, 'new'),
		),
	);
}

export function deactivate(): void {
	// PanelManager is disposed via context.subscriptions.
}

async function open(arg: DebugVariableContext, panels: PanelManager, mode: PanelMode): Promise<void> {
	try {
		const { name, figure } = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Loading Plotly figure…' },
			(progress) => fetchFigure(arg, progress),
		);
		panels.render(name, figure, mode);
	} catch (err) {
		// Only FigureError carries a message meant for humans; anything else is a bug worth surfacing raw.
		const message = err instanceof FigureError ? err.message : `Plotly Preview failed: ${String(err)}`;
		void vscode.window.showErrorMessage(message);
	}
}
