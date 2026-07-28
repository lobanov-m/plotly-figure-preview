import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** A Plotly figure, as produced by `plotly.io.write_json`. */
export interface PlotlyFigure {
	data: unknown[];
	layout: Record<string, unknown>;
}

/**
 * The argument VS Code passes to a command invoked from the `debug/variables/context` menu.
 * Shape confirmed against VS Code's own `workbench.desktop.main.js`.
 */
export interface DebugVariableContext {
	sessionId?: string;
	container?: unknown;
	variable?: {
		name: string;
		value?: string;
		type?: string;
		evaluateName?: string;
		variablesReference?: number;
	};
}

/** Raised for conditions we can explain to the user; the message is shown verbatim. */
export class FigureError extends Error {}

/**
 * Reads a Plotly figure out of a paused Python debug session.
 *
 * The figure is serialized to a temp file *inside the debuggee* rather than returned as an
 * expression result: debugpy truncates long `repr` values, which would silently corrupt any
 * figure of a realistic size.
 */
export async function fetchFigure(ctx: DebugVariableContext): Promise<{ name: string; figure: PlotlyFigure }> {
	const variable = ctx?.variable;
	if (!variable) {
		throw new FigureError('No debugger variable was selected.');
	}

	// `evaluateName` is the fully-qualified path (e.g. `self.fig`); `name` is just the leaf.
	const expression = variable.evaluateName ?? variable.name;
	if (!expression) {
		throw new FigureError('This variable cannot be evaluated by name.');
	}

	const session = vscode.debug.activeDebugSession;
	if (!session) {
		throw new FigureError('No debug session is active.');
	}
	if (ctx.sessionId && ctx.sessionId !== session.id) {
		throw new FigureError('That variable belongs to a debug session that is no longer active.');
	}

	const frameId = await resolveFrameId(session);
	const tmpPath = path.join(os.tmpdir(), `plotly-vsix-${randomUUID()}.json`);

	try {
		await serializeInDebuggee(session, expression, tmpPath, frameId, variable.name);
		const raw = await readSerialized(tmpPath, variable.name);
		return { name: variable.name, figure: raw };
	} finally {
		await fs.rm(tmpPath, { force: true }).catch(() => {
			/* best effort — a stray temp file is not worth bothering the user about */
		});
	}
}

/**
 * Finds a stack frame to evaluate against.
 *
 * The menu argument carries no frame id, so we take the top frame of the first thread that is
 * actually stopped. Threads that are still running reject the `stackTrace` request.
 */
async function resolveFrameId(session: vscode.DebugSession): Promise<number> {
	let threads: { threads?: Array<{ id: number }> };
	try {
		threads = await session.customRequest('threads', {});
	} catch {
		throw new FigureError('Could not read threads from the debug session. Is it paused?');
	}

	for (const thread of threads.threads ?? []) {
		try {
			const trace = await session.customRequest('stackTrace', { threadId: thread.id, levels: 1 });
			const frame = trace?.stackFrames?.[0];
			if (frame) {
				return frame.id;
			}
		} catch {
			continue; // thread is running, not stopped — try the next one
		}
	}

	throw new FigureError('The debug session is not paused at a breakpoint.');
}

/** Asks the debuggee to write the figure to `tmpPath` as JSON. */
async function serializeInDebuggee(
	session: vscode.DebugSession,
	expression: string,
	tmpPath: string,
	frameId: number,
	displayName: string,
): Promise<void> {
	// `plotly.io.write_json` accepts Figure, FigureWidget, and plain figure dicts, and validates
	// the input — so a non-figure raises here rather than producing garbage JSON.
	const code = `__import__('plotly').io.write_json(${expression}, ${pyStringLiteral(tmpPath)})`;

	try {
		await session.customRequest('evaluate', { expression: code, frameId, context: 'repl' });
	} catch (err) {
		const detail = errorText(err);

		if (/No module named ['"]?plotly/.test(detail)) {
			throw new FigureError(
				'Plotly is not installed in the interpreter being debugged. Install it (e.g. `uv sync`) and restart the session.',
			);
		}
		if (/NameError|is not defined/.test(detail)) {
			throw new FigureError(
				`'${displayName}' could not be resolved in the top stack frame. Variables from caller frames are not supported.`,
			);
		}

		throw new FigureError(`'${displayName}' is not a Plotly figure: ${firstLine(detail)}`);
	}
}

async function readSerialized(tmpPath: string, displayName: string): Promise<PlotlyFigure> {
	let raw: string;
	try {
		raw = await fs.readFile(tmpPath, 'utf8');
	} catch {
		throw new FigureError(
			`Could not read the serialized figure for '${displayName}'. This can happen when debugging a remote or containerized interpreter, whose filesystem is not shared with the editor.`,
		);
	}

	let parsed: PlotlyFigure;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new FigureError(`The serialized figure for '${displayName}' was not valid JSON.`);
	}

	return { data: parsed.data ?? [], layout: parsed.layout ?? {} };
}

/** Renders a path as a Python string literal, safe for Windows backslashes and quotes. */
function pyStringLiteral(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function errorText(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function firstLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
	return line.trim().slice(0, 300);
}
