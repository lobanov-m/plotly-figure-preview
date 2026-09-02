import * as vscode from 'vscode';
import { deflateSync, inflateSync } from 'zlib';
import { randomUUID } from 'crypto';
import HELPER_SOURCE from './python/preview.py';

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
export class PreviewError extends Error {}

/**
 * debugpy truncates `evaluate` results at 65,538 characters (65,536 plus the two quotes of the
 * repr) — measured directly against debugpy 1.8.21 over DAP. Reading in 32 KB slices keeps a 2x
 * safety margin.
 */
const CHUNK_SIZE = 32_000;

/** Name the helper is installed under inside the debuggee. Bump with the protocol. */
const HELPER = '__pfp_v1__';

/** Where the Debug Console helper leaves a payload for us to collect. */
const CONSOLE_SLOT = '__pfp_console__';

/**
 * Debug session types that run Python through debugpy.
 *
 * `debugpy` is a plain script or an attach; the other two are the Jupyter extension's adapters for
 * debugging a notebook cell and the Interactive Window. All three speak the same protocol and take
 * the same expressions, so everything downstream treats them alike.
 */
export const PYTHON_DEBUG_TYPES = new Set([
	'debugpy',
	'Python Kernel Debug Adapter',
	'Python Interactive Window Debug Adapter',
]);

/** The subset of those that are debugging a notebook — the cell kind and the Interactive Window. */
export const NOTEBOOK_DEBUG_TYPES = new Set([
	'Python Kernel Debug Adapter',
	'Python Interactive Window Debug Adapter',
]);

export interface Progress {
	report(value: { message?: string; increment?: number }): void;
}

/** What the caller wants back: a specific kind, or `auto` to let the debuggee decide. */
export type PayloadKind = 'plotly' | 'image' | 'auto';

export interface EncodeOptions {
	maxPixels: number;
	normalize: 'auto' | 'always' | 'never';
}

/** Compressed once per extension host, not once per inspection. */
let compressedHelper: string | undefined;

function helperLiteral(): string {
	if (compressedHelper === undefined) {
		compressedHelper = deflateSync(Buffer.from(HELPER_SOURCE, 'utf8'), { level: 9 }).toString('base64');
	}
	return quote(compressedHelper);
}

/**
 * One Python expression that unpacks the helper into a throwaway namespace, runs it, and evaluates
 * to the payload — leaving nothing of itself behind in the interpreter.
 *
 * Shared by the two transports. Over the Debug Adapter Protocol the result is stashed and read back
 * in slices, because debugpy truncates long results; in a notebook kernel it is simply printed,
 * because `Kernel.executeCode` has no such limit.
 */
export function payloadExpression(
	expression: string,
	displayName: string,
	kind: PayloadKind,
	options: EncodeOptions,
): string {
	const source = `__import__('zlib').decompress(__import__('base64').b64decode(${helperLiteral()}))`;
	return (
		`(lambda ns: (__import__('builtins').exec(${source}, ns), ` +
		`ns[${quote(HELPER)}](${expression}, ${quote(kind)}, ${quote(displayName)}, ` +
		`${optionsLiteral(options)}))[1])({})`
	);
}

/**
 * Runs the preview helper against `expression` in a paused Python debug session and returns the
 * JSON payload it produced.
 *
 * Everything moves over the Debug Adapter Protocol — the helper source in, the payload back out,
 * compressed, base64-encoded and read in slices. Nothing touches a filesystem, which is what makes
 * this work when the debuggee is in a container or on another machine with no shared directories.
 */
export async function fetchPayload(
	expression: string,
	displayName: string,
	kind: PayloadKind,
	options: EncodeOptions,
	sessionId: string | undefined,
	progress?: Progress,
): Promise<unknown> {
	const session = findSession(sessionId);
	const frameId = await resolveFrameId(session);

	// Stashed on `builtins` so the follow-up reads can find it from any frame, and keyed uniquely
	// so concurrent inspections cannot collide.
	const key = `__pfp_payload_${randomUUID().replace(/-/g, '')}__`;
	const stash = `__import__('builtins').__dict__`;

	try {
		await prepare(session, frameId, expression, displayName, kind, options, key, stash);
		const total = await payloadLength(session, frameId, key, stash, displayName);
		const encoded = await readChunks(session, frameId, key, stash, total, progress);
		return decode(encoded, displayName);
	} finally {
		// Drop the payload without shipping its contents back over the wire. The helper itself
		// never reached `builtins`: it lives and dies inside the expression above.
		await evaluate(session, frameId, `(${stash}.pop(${quote(key)}, None), None)[1]`).catch(() => {
			/* best effort — a stray entry on builtins is not worth bothering the user about */
		});
	}
}

function findSession(sessionId: string | undefined): vscode.DebugSession {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		throw new PreviewError('No debug session is active.');
	}
	if (sessionId && sessionId !== session.id) {
		throw new PreviewError('That variable belongs to a debug session that is no longer active.');
	}
	return session;
}

/**
 * Finds the stack frame to evaluate against.
 *
 * Whatever the user has selected in the Call Stack pane wins. That is the frame whose locals the
 * Variables pane is showing and the frame the Debug Console types into, so it is the frame a
 * right-click or a hotkey means — `activeStackItem` is how VS Code exposes that selection.
 *
 * Only when nothing is selected, or the selection belongs to a different session, do we fall back
 * to the top frame of a thread that is stopped. Threads that are still running reject `stackTrace`.
 */
export async function resolveFrameId(session: vscode.DebugSession): Promise<number> {
	const selected = vscode.debug.activeStackItem;
	if (selected && selected.session.id === session.id) {
		const frameId = (selected as vscode.DebugStackFrame).frameId;
		if (typeof frameId === 'number') {
			return frameId;
		}
		// A thread is selected rather than one of its frames: take that thread's top frame.
		const frame = await topFrame(session, selected.threadId);
		if (frame !== undefined) {
			return frame;
		}
	}

	let threads: { threads?: Array<{ id: number }> };
	try {
		threads = await session.customRequest('threads', {});
	} catch {
		throw new PreviewError('Could not read threads from the debug session. Is it paused?');
	}

	for (const thread of threads.threads ?? []) {
		const frame = await topFrame(session, thread.id);
		if (frame !== undefined) {
			return frame;
		}
	}

	throw new PreviewError('The debug session is not paused at a breakpoint.');
}

async function topFrame(session: vscode.DebugSession, threadId: number): Promise<number | undefined> {
	try {
		const trace = await session.customRequest('stackTrace', { threadId, levels: 1 });
		return trace?.stackFrames?.[0]?.id;
	} catch {
		return undefined; // thread is running, not stopped
	}
}

/**
 * Installs the helper and runs it, in a single `evaluate`.
 *
 * One round trip, and nothing of the helper outlives it: `payloadExpression` unpacks it into a
 * throwaway namespace, so only the payload is stashed. Exec'ing straight into `builtins.__dict__`
 * would be shorter, but it would also overwrite `builtins.__doc__` with the helper's module
 * docstring and leave `__builtins__` and the helper's private factory behind — three surprises to
 * plant in somebody else's interpreter.
 */
async function prepare(
	session: vscode.DebugSession,
	frameId: number,
	expression: string,
	displayName: string,
	kind: PayloadKind,
	options: EncodeOptions,
	key: string,
	stash: string,
): Promise<void> {
	const call = payloadExpression(expression, displayName, kind, options);

	try {
		await evaluate(session, frameId, `${stash}.__setitem__(${quote(key)}, ${call})`);
	} catch (err) {
		throw explain(err, displayName);
	}
}

async function payloadLength(
	session: vscode.DebugSession,
	frameId: number,
	key: string,
	stash: string,
	displayName: string,
): Promise<number> {
	const raw = await evaluate(session, frameId, `len(${stash}[${quote(key)}])`);
	const total = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(total) || total <= 0) {
		throw new PreviewError(`The debugger returned an unexpected payload length for '${displayName}' (${raw}).`);
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
		throw new PreviewError(
			`The payload was truncated in transit (expected ${total} characters, got ${encoded.length}).`,
		);
	}
	return encoded;
}

export function decode(encoded: string, displayName: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString('utf8'));
	} catch (err) {
		throw new PreviewError(`Could not decode the payload for '${displayName}': ${String(err)}`);
	}
	// The helper reports conditions it can explain as data rather than as a traceback.
	if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
		throw new PreviewError((parsed as { error: string }).error);
	}
	return parsed;
}

async function evaluate(session: vscode.DebugSession, frameId: number, expression: string): Promise<string> {
	const response = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
	return String(response?.result ?? '');
}

/** Turns a debugpy traceback into a single actionable sentence. */
function explain(err: unknown, displayName: string): PreviewError {
	const detail = err instanceof Error ? err.message : String(err);

	if (/No module named ['"]?numpy/.test(detail)) {
		return new PreviewError(
			'numpy is not installed in the interpreter being debugged. Install it there and restart the session.',
		);
	}
	if (/NameError/.test(detail)) {
		return new PreviewError(
			`'${displayName}' could not be resolved in the top stack frame. Variables from caller frames are not supported.`,
		);
	}
	if (/SyntaxError/.test(detail)) {
		return new PreviewError(`'${displayName}' is not a valid Python expression.`);
	}
	return new PreviewError(`Could not read '${displayName}': ${exceptionLine(detail)}`);
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
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

/**
 * Binds the Debug Console helper into the debuggee's `builtins` under `functionName`.
 *
 * This one stays installed for the life of the session — the user is going to type its name — so
 * it deliberately does not get popped the way the menu path's helper does. Options are captured
 * here, at install time.
 */
export async function installConsoleHelper(
	session: vscode.DebugSession,
	frameId: number,
	functionName: string,
	options: EncodeOptions,
): Promise<void> {
	const stash = `__import__('builtins').__dict__`;
	const source = `__import__('zlib').decompress(__import__('base64').b64decode(${helperLiteral()}))`;
	await evaluate(
		session,
		frameId,
		`(lambda ns: (__import__('builtins').exec(${source}, ns), ` +
			`${stash}.__setitem__(${quote(functionName)}, ns[${quote(HELPER)}].console(${optionsLiteral(options)}, ${quote(CONSOLE_SLOT)})))[1])({})`,
	);
}

/**
 * Collects the payload a Debug Console `preview(...)` call left behind, if there is one.
 *
 * Returns undefined when the slot is empty — which is the normal outcome when the user has shadowed
 * the helper with a `preview` of their own, so it is a quiet no-op rather than an error.
 */
export async function collectConsolePayload(
	session: vscode.DebugSession,
	frameId: number,
	progress?: Progress,
): Promise<unknown | undefined> {
	const stash = `__import__('builtins').__dict__`;
	const slot = `${stash}.get(${quote(CONSOLE_SLOT)})`;

	const raw = await evaluate(session, frameId, `len(${slot} or '')`);
	const total = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(total) || total <= 0) {
		return undefined;
	}

	try {
		const encoded = await readChunks(session, frameId, CONSOLE_SLOT, stash, total, progress);
		return decode(encoded, 'the console preview');
	} finally {
		await evaluate(session, frameId, `(${stash}.pop(${quote(CONSOLE_SLOT)}, None), None)[1]`).catch(() => {
			/* best effort — the next call overwrites the slot anyway */
		});
	}
}

/** Renders the encode options as the Python dict literal both entry points take. */
function optionsLiteral(options: EncodeOptions): string {
	return (
		`{'maxPixels': ${Math.max(0, Math.floor(options.maxPixels))}, ` +
		`'normalize': ${quote(options.normalize)}}`
	);
}
