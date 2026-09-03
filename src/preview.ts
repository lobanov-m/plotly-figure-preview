import * as vscode from 'vscode';
import {
	fetchPayload,
	NOTEBOOK_DEBUG_TYPES,
	PreviewError,
	PYTHON_DEBUG_TYPES,
	type DebugVariableContext,
	type EncodeOptions,
	type PayloadKind,
	type Progress,
} from './debugBridge';
import { fetchFromKernel, hasActiveNotebook } from './kernelSource';

/** A Plotly figure, as produced by `plotly.io.to_json`. */
export interface PlotlyFigure {
	data: unknown[];
	layout: Record<string, unknown>;
}

/** Everything the image webview needs besides the pixels themselves. */
export interface ImageMeta {
	name: string;
	source: string;
	dtype: string;
	shape: number[];
	layout: 'HW' | 'HWC' | 'CHW';
	width: number;
	height: number;
	channels: number;
	normalized: boolean;
	notes: string[];
	min?: number;
	max?: number;
	mean?: number;
	device?: string;
	requires_grad?: boolean;
	pil_mode?: string;
}

export type Preview =
	| { kind: 'plotly'; name: string; figure: PlotlyFigure }
	| { kind: 'image'; name: string; meta: ImageMeta; png: string };

/** What to evaluate, and what to call it in the UI. */
export interface Target {
	expression: string;
	name: string;
	sessionId?: string;
}

/**
 * Reads one previewable value out of a paused Python debug session.
 *
 * `kind` narrows what the debuggee will accept: the context-menu commands pass `plotly` or `image`
 * so a wrong type produces a pointed error, while the hotkey passes `auto` because the user only
 * said *what* to look at, not what it is.
 */
export async function fetchPreview(
	target: Target,
	kind: PayloadKind,
	progress?: Progress,
): Promise<Preview> {
	const options = encodeOptions();
	const payload = useDebugger(target)
		? await fetchPayload(target.expression, target.name, kind, options, target.sessionId, progress)
		: await fetchFromKernel(target.expression, target.name, kind, options, progress);

	return toPreview(payload, target.name);
}

/**
 * Turns a decoded payload into something a panel can render, under the name the user will see.
 *
 * The name is supplied here rather than taken from the payload because only this side knows what
 * the user actually pointed at — a variable, an editor selection, or the argument of a console
 * call. The debuggee only ever sees the value.
 */
export function toPreview(payload: unknown, name: string): Preview {
	const shape = payload as { kind?: string; figure?: PlotlyFigure; meta?: ImageMeta; png?: string };
	if (shape?.kind === 'plotly') {
		const figure = shape.figure ?? ({} as PlotlyFigure);
		return { kind: 'plotly', name, figure: { data: figure.data ?? [], layout: figure.layout ?? {} } };
	}
	if (shape?.kind === 'image' && shape.meta && shape.png) {
		return { kind: 'image', name, meta: { ...shape.meta, name }, png: shape.png };
	}
	throw new PreviewError(`The debugger returned an unrecognized payload for '${name}'.`);
}

/**
 * Picks the transport: the paused debuggee, or the notebook's own kernel.
 *
 * The trap this avoids is a script paused in the background while the user is reading a notebook.
 * Both contexts then look available, but only one holds the value being pointed at:
 *
 * - A target from the Variables pane carries the session it belongs to, so it is never in doubt.
 * - A notebook in front of the user means that notebook's kernel — unless the debugger *is* that
 *   notebook, which the Jupyter extension's own adapter types identify.
 * - Otherwise a paused Python debugger, and failing that the kernel, whose errors explain what is
 *   missing.
 */
function useDebugger(target: Target): boolean {
	if (target.sessionId) {
		return true;
	}
	const session = vscode.debug.activeDebugSession;
	if (!session || !PYTHON_DEBUG_TYPES.has(session.type)) {
		return false;
	}
	return hasActiveNotebook() ? NOTEBOOK_DEBUG_TYPES.has(session.type) : true;
}

export function encodeOptions(): EncodeOptions {
	const config = vscode.workspace.getConfiguration('plotlyPreview');
	const maxPixels = config.get<number>('image.maxPixels', 16_000_000);
	const normalize = config.get<EncodeOptions['normalize']>('image.normalize', 'auto');
	return {
		maxPixels: Number.isFinite(maxPixels) ? maxPixels : 16_000_000,
		normalize: normalize === 'always' || normalize === 'never' ? normalize : 'auto',
	};
}

/** The target behind a right-click in the debugger's Variables pane. */
export function targetFromVariable(ctx: DebugVariableContext | undefined): Target {
	const variable = ctx?.variable;
	if (!variable) {
		throw new PreviewError('No debugger variable was selected.');
	}
	// `evaluateName` is the fully-qualified path (e.g. `self.fig`); `name` is just the leaf.
	const expression = variable.evaluateName ?? variable.name;
	if (!expression) {
		throw new PreviewError('This variable cannot be evaluated by name.');
	}
	return { expression, name: variable.name, sessionId: ctx?.sessionId };
}

/**
 * The target behind the keyboard shortcut: whatever is selected in the editor, or failing that the
 * identifier under the cursor.
 *
 * Because this evaluates an arbitrary expression rather than a variable, it also covers what the
 * Variables pane cannot reach — `batch[3]`, `frame[..., 0]`, `img.T`.
 */
export function targetFromEditor(): Target {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		throw new PreviewError('Open a Python file and select an expression first.');
	}

	const selection = editor.selection;
	const range = selection.isEmpty ? editor.document.getWordRangeAtPosition(selection.active) : selection;
	const expression = range ? editor.document.getText(range).trim() : '';
	if (!expression) {
		throw new PreviewError(
			'Select an expression in the editor (or put the cursor on a variable) and try again.',
		);
	}

	return { expression, name: label(expression) };
}

/** Keeps a long expression from taking over a tab title. */
function label(expression: string): string {
	const collapsed = expression.replace(/\s+/g, ' ').trim();
	return collapsed.length > 48 ? `${collapsed.slice(0, 47)}…` : collapsed;
}
