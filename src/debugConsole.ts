import * as vscode from 'vscode';
import { collectConsolePayload, installConsoleHelper, PYTHON_DEBUG_TYPES } from './debugBridge';
import { encodeOptions, toPreview } from './preview';
import type { PanelManager, PanelMode } from './panels';

/**
 * Lets the Debug Console open previews: type `preview(img)` and the image appears.
 *
 * This exists because the console evaluates in *the frame selected in the Call Stack*, which makes
 * it the natural way to inspect a value that only exists in a caller frame, or one that has to be
 * computed on the spot.
 *
 * VS Code offers no way to intercept what the user types into the console — a debug adapter tracker
 * has read access to the traffic and nothing more. So rather than hooking the input, we bind a real
 * Python function into the debuggee for the user to call. It does the encoding, leaves the payload
 * on `builtins`, and returns a line of text for the console to print. The tracker's only job is to
 * notice that the call happened and collect what it left behind.
 */
export function registerDebugConsole(panels: PanelManager): vscode.Disposable {
	const factory = {
		createDebugAdapterTracker(session: vscode.DebugSession) {
			return new ConsoleTracker(session, panels);
		},
	};
	// One registration per type: notebook and Interactive Window debugging go through the Jupyter
	// extension's own adapters, but debugpy is underneath all three.
	return vscode.Disposable.from(
		...[...PYTHON_DEBUG_TYPES].map((type) => vscode.debug.registerDebugAdapterTrackerFactory(type, factory)),
	);
}

class ConsoleTracker implements vscode.DebugAdapterTracker {
	/** Frame ids of console `preview(...)` calls in flight, keyed by their request seq. */
	private readonly pending = new Map<number, { frameId: number; label: string }>();
	private installed = false;

	constructor(
		private readonly session: vscode.DebugSession,
		private readonly panels: PanelManager,
	) {}

	onWillReceiveMessage(message: any): void {
		if (message?.type !== 'request' || message.command !== 'evaluate') {
			return;
		}
		const args = message.arguments ?? {};
		if (args.context !== 'repl' || typeof args.frameId !== 'number') {
			return;
		}
		const label = callArgument(args.expression, functionName());
		if (label !== undefined) {
			this.pending.set(message.seq, { frameId: args.frameId, label });
		}
	}

	onDidSendMessage(message: any): void {
		if (message?.type !== 'response') {
			return;
		}

		// Every stop repopulates the Call Stack, which hands us a live frame for free — no extra
		// round trip just to find somewhere to install the helper.
		if (message.command === 'stackTrace' && !this.installed && enabled()) {
			const frameId = message.body?.stackFrames?.[0]?.id;
			if (typeof frameId === 'number') {
				this.installed = true;
				void this.install(frameId);
			}
			return;
		}

		if (message.command === 'evaluate') {
			const call = this.pending.get(message.request_seq);
			if (call) {
				this.pending.delete(message.request_seq);
				// A failed call already printed its traceback in the console; nothing was stashed.
				if (message.success) {
					void this.collect(call.frameId, call.label);
				}
			}
		}
	}

	onWillStopSession(): void {
		this.pending.clear();
	}

	private async install(frameId: number): Promise<void> {
		try {
			await installConsoleHelper(this.session, frameId, functionName(), encodeOptions());
		} catch {
			// Not worth a popup: the user has not asked for anything yet, and every other entry
			// point still works. Calling the function will simply raise NameError in the console.
			this.installed = false;
		}
	}

	private async collect(frameId: number, label: string): Promise<void> {
		try {
			const payload = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Loading ${label}…` },
				(progress) => collectConsolePayload(this.session, frameId, progress),
			);
			if (!payload) {
				return; // the helper was shadowed by something else named `preview`
			}
			const mode: PanelMode = (payload as { mode?: string }).mode === 'new' ? 'new' : 'shared';
			this.panels.render(toPreview(payload, label), mode);
		} catch (err) {
			void vscode.window.showErrorMessage(`Could not open the console preview: ${String(err)}`);
		}
	}
}

function enabled(): boolean {
	return vscode.workspace.getConfiguration('plotlyPreview').get<boolean>('debugConsole.enabled', true);
}

function functionName(): string {
	const name = vscode.workspace
		.getConfiguration('plotlyPreview')
		.get<string>('debugConsole.functionName', 'preview')
		.trim();
	// Anything else would be un-callable from Python, and would be spliced into an expression.
	return /^[A-Za-z_]\w*$/.test(name) ? name : 'preview';
}

/**
 * Recognises `preview(expr)` / `preview(expr, True)` and returns the text of the first argument,
 * which is what the tab gets named. Returns undefined when the expression is not such a call.
 *
 * Splitting on the first top-level comma is enough for the shapes a person types into a console;
 * anything it cannot parse still previews, just under the whole argument text as its name.
 */
export function callArgument(expression: unknown, name: string): string | undefined {
	if (typeof expression !== 'string') {
		return undefined;
	}
	const match = expression.trim().match(new RegExp(`^${name}\\s*\\(([\\s\\S]*)\\)\\s*$`));
	if (!match) {
		return undefined;
	}

	const inner = match[1];
	let depth = 0;
	let cut = inner.length;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if ('([{'.includes(ch)) {
			depth++;
		} else if (')]}'.includes(ch)) {
			depth--;
		} else if (ch === ',' && depth === 0) {
			cut = i;
			break;
		} else if (ch === '"' || ch === "'") {
			// Skip the string body so a comma inside it does not look like an argument separator.
			const end = inner.indexOf(ch, i + 1);
			i = end === -1 ? inner.length : end;
		}
	}

	const argument = inner.slice(0, cut).trim();
	return argument.length > 48 ? `${argument.slice(0, 47)}…` : argument || '<value>';
}
