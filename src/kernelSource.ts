import * as vscode from 'vscode';
import {
	decode,
	payloadExpression,
	PreviewError,
	type EncodeOptions,
	type PayloadKind,
	type Progress,
} from './debugBridge';

/**
 * Reads a previewable value straight out of a notebook's Jupyter kernel, with no debugger involved.
 *
 * In a notebook you usually are not debugging — you ran some cells and now want to look at what is
 * in the kernel. There is no Variables pane and no stack frame to evaluate against, so this goes
 * through the Jupyter extension's kernel API instead of the Debug Adapter Protocol.
 *
 * That transport is the easier of the two: `executeCode` runs code without touching the execution
 * count or history, and its output arrives whole. A 4.4 MB payload comes back in a single stream
 * message, so none of the DAP path's slicing and length-checking is needed here.
 */

/** The public surface of `@vscode/jupyter-extension` that this uses. Typed here to avoid the dep. */
interface JupyterOutputItem {
	mime: string;
	data: Uint8Array;
}
interface JupyterOutput {
	items: JupyterOutputItem[];
}
interface JupyterKernel {
	status: string;
	language: string;
	executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<JupyterOutput>;
}
interface JupyterApi {
	kernels?: { getKernel(uri: vscode.Uri): Thenable<JupyterKernel | undefined> };
}

const JUPYTER_EXTENSION = 'ms-toolsai.jupyter';
const STDOUT = 'application/x.notebook.stream.stdout';
const STDERR = 'application/x.notebook.stream.stderr';
const ERROR = 'application/vnd.code.notebook.error';

/** True when a notebook is in front of the user, so the caller knows this transport is worth trying. */
export function hasActiveNotebook(): boolean {
	return vscode.window.activeNotebookEditor !== undefined;
}

export async function fetchFromKernel(
	expression: string,
	displayName: string,
	kind: PayloadKind,
	options: EncodeOptions,
	progress?: Progress,
): Promise<unknown> {
	const kernel = await activeKernel();
	progress?.report({ message: 'running in the kernel' });

	const source = new vscode.CancellationTokenSource();
	const timeout = setTimeout(() => source.cancel(), 120_000);
	const stdout: string[] = [];
	const problems: string[] = [];

	try {
		for await (const output of kernel.executeCode(
			`print(${payloadExpression(expression, displayName, kind, options)})`,
			source.token,
		)) {
			for (const item of output.items ?? []) {
				const text = new TextDecoder().decode(item.data);
				if (item.mime === STDOUT) {
					stdout.push(text);
				} else if (item.mime === ERROR || item.mime === STDERR) {
					problems.push(text);
				}
			}
		}
	} catch (err) {
		throw new PreviewError(`The kernel could not evaluate '${displayName}': ${String(err)}`);
	} finally {
		clearTimeout(timeout);
		source.dispose();
	}

	const encoded = stdout.join('').trim();
	if (!encoded) {
		throw explain(problems, displayName);
	}
	return decode(encoded, displayName);
}

/** Finds the kernel behind the notebook the user is looking at, explaining every way that can fail. */
async function activeKernel(): Promise<JupyterKernel> {
	const notebook = vscode.window.activeNotebookEditor?.notebook;
	if (!notebook) {
		throw new PreviewError(
			'Open a notebook (or start a Python debug session) and try again — there is nothing to evaluate against.',
		);
	}

	const extension = vscode.extensions.getExtension<JupyterApi>(JUPYTER_EXTENSION);
	if (!extension) {
		throw new PreviewError(
			'The Jupyter extension is not installed, so this notebook has no kernel this extension can reach.',
		);
	}

	const api = extension.isActive ? extension.exports : await extension.activate();
	const kernel = await api?.kernels?.getKernel(notebook.uri);
	if (!kernel) {
		// getKernel only returns kernels the user has already started.
		throw new PreviewError('This notebook has no running kernel yet. Run a cell first, then try again.');
	}
	if (kernel.language !== 'python') {
		throw new PreviewError(`This notebook's kernel runs ${kernel.language}, and this extension only reads Python.`);
	}
	if (kernel.status === 'dead' || kernel.status === 'terminating') {
		throw new PreviewError(`The kernel is ${kernel.status}. Restart it and run a cell before previewing.`);
	}
	return kernel;
}

/**
 * Turns whatever the kernel complained about into one sentence.
 *
 * Python's own traceback is the useful part, and its last line names the exception, so unlike the
 * debugpy path there is nothing to dig for.
 */
function explain(problems: string[], displayName: string): PreviewError {
	const detail = problems.join('\n').trim();
	if (!detail) {
		return new PreviewError(`The kernel returned nothing for '${displayName}'.`);
	}
	if (/NameError/.test(detail)) {
		return new PreviewError(
			`'${displayName}' is not defined in the kernel. Has the cell that creates it been run?`,
		);
	}
	const line = detail.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? detail;
	return new PreviewError(`The kernel could not read '${displayName}': ${line.slice(0, 240)}`);
}
