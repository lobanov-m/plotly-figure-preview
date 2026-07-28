import * as vscode from 'vscode';
import { inflateSync } from 'zlib';
import { randomUUID } from 'crypto';

/** A Plotly figure, as produced by `plotly.io.to_json`. */
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
 * debugpy truncates `evaluate` results at 65,538 characters (65,536 plus the two quotes of the
 * repr) — measured directly against debugpy 1.8.21 over DAP. Reading in 32 KB slices keeps a 2x
 * safety margin.
 */
const CHUNK_SIZE = 32_000;

export interface Progress {
	report(value: { message?: string; increment?: number }): void;
}

/**
 * Reads a Plotly figure out of a paused Python debug session.
 *
 * The payload is moved entirely over the Debug Adapter Protocol — compressed, base64-encoded and
 * pulled back in slices — so it never touches a filesystem. That is what makes this work when the
 * debuggee is on another machine or inside a container, where the editor and the interpreter share
 * no directories.
 */
export async function fetchFigure(
	ctx: DebugVariableContext,
	progress?: Progress,
): Promise<{ name: string; figure: PlotlyFigure }> {
	const variable = ctx?.variable;
	if (!variable) {
		throw new FigureError('No debugger variable was selected.');
	}

	// `evaluateName` is the fully-qualified path (e.g. `self.fig`); `name` is just the leaf.
	const expression = variable.evaluateName ?? variable.name;
	if (!expression) {
		throw new FigureError('This variable cannot be evaluated by name.');
	}

	const session = findSession(ctx);
	const frameId = await resolveFrameId(session);

	// Stashed on `builtins` so the follow-up reads can find it from any frame, and keyed uniquely
	// so concurrent inspections cannot collide.
	const key = `__plotly_vsix_${randomUUID().replace(/-/g, '')}__`;
	const stash = `__import__('builtins').__dict__`;

	try {
		await prepare(session, frameId, expression, key, stash, variable.name);
		const total = await payloadLength(session, frameId, key, stash);
		const encoded = await readChunks(session, frameId, key, stash, total, progress);
		return { name: variable.name, figure: decode(encoded, variable.name) };
	} finally {
		// Drop the stash without shipping its contents back over the wire.
		await evaluate(session, frameId, `(${stash}.pop(${quote(key)}, None), None)[1]`).catch(() => {
			/* best effort — a stray entry on builtins is not worth bothering the user about */
		});
	}
}

function findSession(ctx: DebugVariableContext): vscode.DebugSession {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		throw new FigureError('No debug session is active.');
	}
	if (ctx.sessionId && ctx.sessionId !== session.id) {
		throw new FigureError('That variable belongs to a debug session that is no longer active.');
	}
	return session;
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

/** Serializes, compresses and base64-encodes the figure inside the debuggee, in one expression. */
async function prepare(
	session: vscode.DebugSession,
	frameId: number,
	expression: string,
	key: string,
	stash: string,
	displayName: string,
): Promise<void> {
	// `plotly.io.to_json` accepts Figure, FigureWidget and plain figure dicts, and validates its
	// input — so a non-figure raises here rather than producing garbage.
	const code =
		`${stash}.__setitem__(${quote(key)}, ` +
		`__import__('base64').b64encode(__import__('zlib').compress(` +
		`__import__('plotly').io.to_json(${expression}).encode('utf-8'), 6)).decode('ascii'))`;

	try {
		await evaluate(session, frameId, code);
	} catch (err) {
		throw explain(err, displayName);
	}
}

async function payloadLength(
	session: vscode.DebugSession,
	frameId: number,
	key: string,
	stash: string,
): Promise<number> {
	const raw = await evaluate(session, frameId, `len(${stash}[${quote(key)}])`);
	const total = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(total) || total <= 0) {
		throw new FigureError(`The debugger returned an unexpected payload length (${raw}).`);
	}
	return total;
}

async function readChunks(
	session: vscode.DebugSession,
	frameId: number,
	key: string,
	stash: string,
	total: number,
	progress?: Progress,
): Promise<string> {
	const parts: string[] = [];
	const reads = Math.ceil(total / CHUNK_SIZE);

	for (let offset = 0, i = 0; offset < total; offset += CHUNK_SIZE, i++) {
		const slice = await evaluate(
			session,
			frameId,
			`${stash}[${quote(key)}][${offset}:${offset + CHUNK_SIZE}]`,
		);
		parts.push(unrepr(slice));
		if (reads > 4) {
			progress?.report({ message: `${Math.round(((i + 1) / reads) * 100)}%` });
		}
	}

	const encoded = parts.join('');
	// Length is reported by the debuggee before transfer, so this catches any silent truncation.
	if (encoded.length !== total) {
		throw new FigureError(
			`The figure was truncated in transit (expected ${total} characters, got ${encoded.length}).`,
		);
	}
	return encoded;
}

function decode(encoded: string, displayName: string): PlotlyFigure {
	let parsed: PlotlyFigure;
	try {
		parsed = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString('utf8'));
	} catch (err) {
		throw new FigureError(`Could not decode the figure for '${displayName}': ${String(err)}`);
	}
	return { data: parsed.data ?? [], layout: parsed.layout ?? {} };
}

async function evaluate(session: vscode.DebugSession, frameId: number, expression: string): Promise<string> {
	const response = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
	return String(response?.result ?? '');
}

/** Turns a debugpy traceback into a single actionable sentence. */
function explain(err: unknown, displayName: string): FigureError {
	const detail = err instanceof Error ? err.message : String(err);

	if (/No module named ['"]?plotly/.test(detail)) {
		return new FigureError(
			'Plotly is not installed in the interpreter being debugged. Install it there and restart the session.',
		);
	}
	if (/NameError/.test(detail)) {
		return new FigureError(
			`'${displayName}' could not be resolved in the top stack frame. Variables from caller frames are not supported.`,
		);
	}
	return new FigureError(`'${displayName}' is not a Plotly figure: ${exceptionLine(detail)}`);
}

/**
 * Pulls the actionable line out of a debugpy traceback.
 *
 * Neither the first nor the last line will do: the first is always "Traceback (most recent call
 * last):", and the last is wherever the exception's own text trailed off — plotly's validation
 * errors, for instance, end with a bare "^" caret under a property path. So scan backwards for the
 * line that actually names an exception type.
 */
function exceptionLine(detail: string): string {
	const lines = detail.split('\n');
	const pattern = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit))\s*:(.*)$/;

	for (let i = lines.length - 1; i >= 0; i--) {
		const match = lines[i].match(pattern);
		if (!match) {
			continue;
		}
		// Some exceptions (plotly's included) are raised with a leading newline, which puts the
		// message on the following lines rather than after the colon.
		const inline = match[2].trim();
		const message = inline || lines.slice(i + 1).map((l) => l.trim()).find(Boolean) || '';
		return truncate(message ? `${match[1]}: ${message}` : match[1]);
	}

	const fallback = lines.map((l) => l.trim()).filter(Boolean).pop() ?? detail;
	return truncate(fallback);
}

function truncate(text: string): string {
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/**
 * Strips the quotes debugpy puts around a returned string. The payload is base64, whose alphabet
 * contains no quotes or backslashes, so the repr is never escaped.
 */
function unrepr(result: string): string {
	const first = result[0];
	if ((first === "'" || first === '"') && result.endsWith(first) && result.length >= 2) {
		return result.slice(1, -1);
	}
	return result;
}

/** Renders a value as a Python string literal. */
function quote(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
