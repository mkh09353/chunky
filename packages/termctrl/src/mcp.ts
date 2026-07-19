/**
 * MCP stdio server exposing named Terminal Control sessions as tools.
 *
 * Talks to the per-session daemons over their unix sockets via `request()` from
 * `daemon.ts`. Run directly (`bun run src/mcp.ts`) or call `runMcpServer()`.
 */

import {readdirSync, existsSync} from 'node:fs';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {dir, request, socketPath} from './daemon.ts';
import {KEY_BYTES, concatBytes, type KeyName} from './keys.ts';
import type {Frame} from './frame.ts';

export const SERVER_NAME = 'terminal-control';
export const SERVER_VERSION = '0.1.0';

/** MCP key names (camelCase) mapped onto the byte tables in `keys.ts`. */
export const KEY_ALIASES = {
	enter: 'enter',
	escape: 'escape',
	arrowUp: 'up',
	arrowDown: 'down',
	arrowLeft: 'left',
	arrowRight: 'right',
	tab: 'tab',
	shiftTab: 'shift-tab',
	backspace: 'backspace',
	delete: 'delete',
	home: 'home',
	end: 'end',
	pageUp: 'page-up',
	pageDown: 'page-down',
} as const satisfies Record<string, KeyName>;

export type McpKey = keyof typeof KEY_ALIASES;

const KEY_NAMES = Object.keys(KEY_ALIASES) as [McpKey, ...McpKey[]];

const inputAtom = z.discriminatedUnion('type', [
	z.object({type: z.literal('text'), text: z.string()}),
	z.object({type: z.literal('key'), key: z.enum(KEY_NAMES)}),
	z.object({
		type: z.literal('control'),
		letter: z.string().regex(/^[A-Za-z]$/, 'control input must be one ASCII letter'),
	}),
	z.object({type: z.literal('bytes'), bytes: z.array(z.number().int().min(0).max(255))}),
]);

export type InputAtom = z.infer<typeof inputAtom>;

/** Encode one typed input atom to the bytes the PTY should receive. */
export function encodeAtom(atom: InputAtom): Uint8Array {
	switch (atom.type) {
		case 'text':
			return new TextEncoder().encode(atom.text);
		case 'key':
			return KEY_BYTES[KEY_ALIASES[atom.key]];
		case 'control':
			return Uint8Array.from([atom.letter.toUpperCase().charCodeAt(0) - 64]);
		case 'bytes':
			return Uint8Array.from(atom.bytes);
	}
}

/** Rebuild visible text from a frame captured over the socket. */
export function frameToText(frame: Frame): string {
	const rows: string[] = [];
	for (let y = 0; y < frame.rows; y += 1) {
		const cells = frame.cells.filter((cell) => cell.y === y).sort((a, b) => a.x - b.x);
		let line = '';
		let cursor = 0;
		for (const cell of cells) {
			if (cell.x < cursor) continue; // overlapping wide-cell remnant
			line += ' '.repeat(cell.x - cursor) + (cell.text === '' ? ' ' : cell.text);
			cursor = cell.x + cell.width;
		}
		rows.push(line.replace(/\s+$/, ''));
	}
	return rows.join('\n').replace(/\s+$/, '');
}

/** Session names with a live socket in the runtime directory. */
export function sessionNames(): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => entry.endsWith('.sock'))
		.map((entry) => entry.slice(0, -'.sock'.length))
		.sort();
}

const known = (name: string): void => {
	if (!existsSync(socketPath(name))) {
		throw new Error(
			`unknown session ${JSON.stringify(name)}; run list_sessions to see the available sessions`,
		);
	}
};

/** Send a daemon request, turning transport failures into readable messages. */
async function call(name: string, message: Record<string, unknown>): Promise<any> {
	known(name);
	try {
		return await request(name, message);
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		if (/ECONNREFUSED|ENOENT/.test(text)) {
			throw new Error(`session ${JSON.stringify(name)} is not responding; its daemon may have exited`);
		}
		throw new Error(text);
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sendInput(name: string, input: InputAtom[], paceMs: number): Promise<void> {
	const bytes = input.map(encodeAtom);
	if (bytes.length === 0) return;
	if (paceMs <= 0) {
		await call(name, {method: 'send', bytes: Array.from(concatBytes(bytes))});
		return;
	}
	for (const [index, chunk] of bytes.entries()) {
		if (index > 0) await sleep(paceMs);
		await call(name, {method: 'send', bytes: Array.from(chunk)});
	}
}

type Screen = {name: string; text: string; state: string; cols: number; rows: number};

async function capture(name: string, settleMs: number, deadlineMs: number): Promise<Screen> {
	const result = await call(name, {method: 'capture', settle_ms: settleMs, deadline_ms: deadlineMs});
	const status = await call(name, {method: 'status'});
	return {
		name,
		text: frameToText(result.shot.frame),
		state: status.state,
		cols: status.cols,
		rows: status.rows,
	};
}

const screenShape = {
	name: z.string(),
	text: z.string(),
	state: z.string(),
	cols: z.number(),
	rows: z.number(),
};

const sessionName = z.string().min(1).describe('Named Terminal Control session');
const inputList = z.array(inputAtom).describe('Ordered typed terminal input');

/** Wrap a handler so thrown errors become MCP tool errors with readable text. */
const tool =
	<T>(handler: (args: T) => Promise<{text: string; structured?: unknown}>) =>
	async (args: T) => {
		try {
			const {text, structured} = await handler(args);
			return structured === undefined
				? {content: [{type: 'text' as const, text}]}
				: {content: [{type: 'text' as const, text}], structuredContent: structured as Record<string, unknown>};
		} catch (error) {
			return {
				content: [{type: 'text' as const, text: error instanceof Error ? error.message : String(error)}],
				isError: true,
			};
		}
	};

/** Build the MCP server with all seven terminal tools registered. */
export function createMcpServer(): McpServer {
	const server = new McpServer({name: SERVER_NAME, version: SERVER_VERSION});

	server.registerTool(
		'list_sessions',
		{
			description: 'List named local Terminal Control sessions and their state',
			inputSchema: {},
			outputSchema: {
				sessions: z.array(
					z.object({
						name: z.string(),
						state: z.string().nullable(),
						command: z.array(z.string()).nullable(),
						cwd: z.string().nullable(),
						cols: z.number().nullable(),
						rows: z.number().nullable(),
						recording: z.boolean().nullable(),
						error: z.string().nullable(),
						unavailable: z.string().nullable(),
					}),
				),
			},
		},
		tool(async () => {
			const sessions = [];
			for (const name of sessionNames()) {
				try {
					const status = await request(name, {method: 'status'});
					sessions.push({
						name,
						state: status.state,
						command: status.launch.command,
						cwd: status.launch.cwd,
						cols: status.cols,
						rows: status.rows,
						recording: status.recording,
						error: null,
						unavailable: null,
					});
				} catch (error) {
					sessions.push({
						name,
						state: null,
						command: null,
						cwd: null,
						cols: null,
						rows: null,
						recording: null,
						error: error instanceof Error ? error.message : String(error),
						unavailable: 'stale',
					});
				}
			}
			const structured = {sessions};
			return {text: JSON.stringify(structured, null, 2), structured};
		}),
	);

	server.registerTool(
		'get_session_status',
		{
			description: 'Get structured status and launch details for a named terminal session',
			inputSchema: {name: sessionName},
			outputSchema: {
				name: z.string(),
				state: z.string(),
				exit: z
					.object({code: z.number(), signal: z.string().nullable(), success: z.boolean()})
					.nullable(),
				command: z.array(z.string()),
				cwd: z.string(),
				cols: z.number(),
				rows: z.number(),
				cellWidth: z.number(),
				cellHeight: z.number(),
				idleForMs: z.number().nullable(),
				hasVisibleContent: z.boolean(),
				recording: z.boolean(),
				recordingPath: z.string().nullable(),
				logsTruncated: z.boolean(),
			},
		},
		tool(async ({name}: {name: string}) => {
			const status = await call(name, {method: 'status'});
			const structured = {
				name,
				state: status.state,
				exit: status.exit ?? null,
				command: status.launch.command,
				cwd: status.launch.cwd,
				cols: status.cols,
				rows: status.rows,
				cellWidth: status.cell_width,
				cellHeight: status.cell_height,
				idleForMs: status.idle_for_ms ?? null,
				hasVisibleContent: status.has_visible_content,
				recording: status.recording,
				recordingPath: status.launch.record ?? null,
				logsTruncated: status.logs_truncated,
			};
			return {text: JSON.stringify(structured, null, 2), structured};
		}),
	);

	server.registerTool(
		'get_screen',
		{
			description: 'Read the current visible screen of a named terminal session',
			inputSchema: {
				name: sessionName,
				settleMs: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe('Optional quiet period before returning; omit for an immediate snapshot'),
				deadlineMs: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe('Maximum optional settling wait; omit for an immediate snapshot'),
			},
			outputSchema: screenShape,
		},
		tool(async ({name, settleMs = 0, deadlineMs = 0}: {name: string; settleMs?: number; deadlineMs?: number}) => {
			const structured = await capture(name, settleMs, deadlineMs);
			return {text: structured.text, structured};
		}),
	);

	server.registerTool(
		'send_input',
		{
			description: 'Send typed text, keys, controls, or exact bytes to a named terminal session',
			inputSchema: {
				name: sessionName,
				input: inputList,
				paceMs: z.number().int().min(0).default(0).describe('Delay between input atoms'),
			},
		},
		tool(async ({name, input, paceMs = 0}: {name: string; input: InputAtom[]; paceMs?: number}) => {
			await sendInput(name, input, paceMs);
			return {text: `sent input to ${name}`};
		}),
	);

	server.registerTool(
		'interact',
		{
			description: 'Send input, optionally wait for visible text, and return the resulting screen',
			inputSchema: {
				name: sessionName,
				input: z.array(inputAtom).default([]).describe('Ordered typed terminal input'),
				paceMs: z.number().int().min(0).default(0),
				waitFor: z.string().optional().describe('Optional visible text to await after sending input'),
				timeoutMs: z.number().int().min(0).default(5000),
				settleMs: z.number().int().min(0).default(0),
				deadlineMs: z.number().int().min(0).default(0),
			},
			outputSchema: screenShape,
		},
		tool(
			async ({
				name,
				input = [],
				paceMs = 0,
				waitFor,
				timeoutMs = 5000,
				settleMs = 0,
				deadlineMs = 0,
			}: {
				name: string;
				input?: InputAtom[];
				paceMs?: number;
				waitFor?: string;
				timeoutMs?: number;
				settleMs?: number;
				deadlineMs?: number;
			}) => {
				await sendInput(name, input, paceMs);
				if (waitFor !== undefined) {
					await call(name, {method: 'wait', text: waitFor, timeout_ms: timeoutMs});
				}
				const structured = await capture(name, settleMs, deadlineMs);
				return {text: structured.text, structured};
			},
		),
	);

	server.registerTool(
		'resize_session',
		{
			description: 'Resize a named terminal session',
			inputSchema: {
				name: sessionName,
				cols: z.number().int().min(1).max(65535),
				rows: z.number().int().min(1).max(65535),
				cellWidth: z.number().int().min(0).max(65535).optional(),
				cellHeight: z.number().int().min(0).max(65535).optional(),
			},
		},
		tool(async ({name, cols, rows}: {name: string; cols: number; rows: number}) => {
			await call(name, {method: 'resize', cols, rows});
			return {text: `resized ${name} to ${cols}x${rows}`};
		}),
	);

	server.registerTool(
		'stop_session',
		{
			description: 'Stop a named terminal session and its child process',
			inputSchema: {name: sessionName},
		},
		tool(async ({name}: {name: string}) => {
			await call(name, {method: 'stop'});
			return {text: `stopped ${name}`};
		}),
	);

	return server;
}

/** Serve the MCP tools over stdio. Resolves when the transport closes. */
export async function runMcpServer(): Promise<void> {
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	await new Promise<void>((resolve) => {
		transport.onclose = resolve;
	});
}

if (import.meta.main) {
	runMcpServer().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
