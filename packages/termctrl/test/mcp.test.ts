import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {encodeAtom, frameToText, KEY_ALIASES} from '../src/mcp.ts';
import {KEY_BYTES} from '../src/keys.ts';

const packageDir = new URL('..', import.meta.url).pathname;
const SESSION = 'demo';

let runtimeDir = '';
let client: Client;

/** Short /tmp path: unix socket paths are capped near 104 bytes on macOS. */
const makeRuntimeDir = () => mkdtemp('/tmp/tc-mcp-');

const cli = async (args: string[]) => {
	const child = Bun.spawn([process.execPath, join(packageDir, 'src/cli.ts'), ...args], {
		cwd: packageDir,
		env: {...process.env, TERMCTRL_RUNTIME_DIR: runtimeDir},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const stderr = await new Response(child.stderr).text();
	const code = await child.exited;
	if (code !== 0) throw new Error(`termctrl ${args.join(' ')} failed: ${stderr}`);
};

const callTool = (name: string, args: Record<string, unknown>) =>
	client.callTool({name, arguments: args});

const textOf = (result: Awaited<ReturnType<typeof callTool>>) =>
	(result.content as {type: string; text: string}[])[0]!.text;

beforeAll(async () => {
	runtimeDir = await makeRuntimeDir();
	await cli(['start', SESSION, '--', 'sh']);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(packageDir, 'src/mcp.ts')],
		cwd: packageDir,
		env: {...process.env, TERMCTRL_RUNTIME_DIR: runtimeDir},
	});
	client = new Client({name: 'mcp-test', version: '1.0.0'});
	await client.connect(transport);
}, 60_000);

afterAll(async () => {
	try {
		await callTool('stop_session', {name: SESSION});
	} catch {
		// already stopped by a test
	}
	await client?.close().catch(() => {});
	if (runtimeDir !== '') await rm(runtimeDir, {recursive: true, force: true});
}, 30_000);

describe('unit helpers', () => {
	test('every MCP key name maps to the byte table in keys.ts', () => {
		expect(Object.keys(KEY_ALIASES)).toEqual([
			'enter',
			'escape',
			'arrowUp',
			'arrowDown',
			'arrowLeft',
			'arrowRight',
			'tab',
			'shiftTab',
			'backspace',
			'delete',
			'home',
			'end',
			'pageUp',
			'pageDown',
		]);
		for (const [alias, name] of Object.entries(KEY_ALIASES)) {
			expect(encodeAtom({type: 'key', key: alias as never})).toEqual(KEY_BYTES[name]);
		}
	});

	test('encodes the documented byte sequences', () => {
		expect([...encodeAtom({type: 'key', key: 'enter'})]).toEqual([13]);
		expect([...encodeAtom({type: 'key', key: 'arrowUp'})]).toEqual([27, 91, 65]);
		expect([...encodeAtom({type: 'key', key: 'shiftTab'})]).toEqual([27, 91, 90]);
		expect([...encodeAtom({type: 'key', key: 'pageDown'})]).toEqual([27, 91, 54, 126]);
		expect([...encodeAtom({type: 'control', letter: 'c'})]).toEqual([3]);
		expect([...encodeAtom({type: 'control', letter: 'D'})]).toEqual([4]);
		expect([...encodeAtom({type: 'text', text: 'hi'})]).toEqual([104, 105]);
		expect([...encodeAtom({type: 'bytes', bytes: [1, 2, 3]})]).toEqual([1, 2, 3]);
	});

	test('frameToText lays out gaps and wide cells', () => {
		const attributes = {
			bold: false,
			italic: false,
			faint: false,
			invisible: false,
			strikethrough: false,
			overline: false,
			underline: null,
		} as const;
		const color = {r: 0, g: 0, b: 0};
		const cell = (x: number, y: number, text: string, width: 1 | 2 = 1) => ({
			x,
			y,
			text,
			width,
			foreground: color,
			background: color,
			attributes: {...attributes},
		});
		const text = frameToText({
			version: 1,
			cols: 8,
			rows: 2,
			foreground: color,
			background: color,
			cursor: null,
			cells: [cell(0, 0, 'a'), cell(2, 0, 'b'), cell(0, 1, '界', 2), cell(2, 1, 'x')],
		} as never);
		expect(text).toBe('a b\n界x');
	});
});

describe('tool discovery', () => {
	test('exposes exactly the seven documented tools', async () => {
		const {tools} = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'get_screen',
			'get_session_status',
			'interact',
			'list_sessions',
			'resize_session',
			'send_input',
			'stop_session',
		]);
		for (const tool of tools) expect(tool.description).toBeTruthy();
	});

	test('get_screen advertises optional settleMs/deadlineMs', async () => {
		const {tools} = await client.listTools();
		const schema = tools.find((tool) => tool.name === 'get_screen')!.inputSchema;
		expect(Object.keys(schema.properties!).sort()).toEqual(['deadlineMs', 'name', 'settleMs']);
		expect(schema.required).toEqual(['name']);
	});
});

describe('session tools against a real session', () => {
	test('list_sessions reports the running session', async () => {
		const result = await callTool('list_sessions', {});
		const {sessions} = result.structuredContent as {sessions: Record<string, unknown>[]};
		const session = sessions.find((entry) => entry.name === SESSION);
		expect(session).toBeDefined();
		expect(session).toMatchObject({
			name: SESSION,
			state: 'running',
			command: ['sh'],
			cols: 80,
			rows: 24,
			recording: false,
			error: null,
			unavailable: null,
		});
		expect(typeof session!.cwd).toBe('string');
	}, 30_000);

	test('get_session_status returns camelCase structured detail', async () => {
		const result = await callTool('get_session_status', {name: SESSION});
		const status = result.structuredContent as Record<string, unknown>;
		expect(status).toMatchObject({
			name: SESSION,
			state: 'running',
			exit: null,
			command: ['sh'],
			cellWidth: 9,
			cellHeight: 18,
			recording: false,
			recordingPath: null,
			logsTruncated: false,
			hasVisibleContent: true,
		});
		expect(Object.keys(status)).toEqual([
			'name',
			'state',
			'exit',
			'command',
			'cwd',
			'cols',
			'rows',
			'cellWidth',
			'cellHeight',
			'idleForMs',
			'hasVisibleContent',
			'recording',
			'recordingPath',
			'logsTruncated',
		]);
	}, 30_000);

	test('get_screen returns an immediate snapshot', async () => {
		const result = await callTool('get_screen', {name: SESSION});
		const screen = result.structuredContent as Record<string, unknown>;
		expect(screen.name).toBe(SESSION);
		expect(screen.state).toBe('running');
		expect(screen.cols).toBe(80);
		expect(screen.rows).toBe(24);
		expect(typeof screen.text).toBe('string');
	}, 30_000);

	test('interact sends text plus enter and returns the echoed screen', async () => {
		const result = await callTool('interact', {
			name: SESSION,
			input: [
				{type: 'text', text: 'echo hello-from-mcp'},
				{type: 'key', key: 'enter'},
			],
			waitFor: 'hello-from-mcp',
			timeoutMs: 15_000,
			settleMs: 150,
			deadlineMs: 3_000,
		});
		expect(result.isError).toBeFalsy();
		const screen = result.structuredContent as {text: string; state: string};
		// The command echoes, so the output line appears in addition to the typed line.
		expect(screen.text).toContain('hello-from-mcp');
		expect(screen.text.split('\n').filter((line) => line.includes('hello-from-mcp')).length).toBeGreaterThanOrEqual(2);
		expect(screen.state).toBe('running');
	}, 45_000);

	test('send_input returns its confirmation string', async () => {
		const result = await callTool('send_input', {
			name: SESSION,
			input: [
				{type: 'text', text: 'echo paced'},
				{type: 'key', key: 'enter'},
			],
			paceMs: 5,
		});
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toBe(`sent input to ${SESSION}`);

		const screen = await callTool('interact', {name: SESSION, waitFor: 'paced', timeoutMs: 15_000});
		expect((screen.structuredContent as {text: string}).text).toContain('paced');
	}, 45_000);

	test('resize_session changes the reported geometry', async () => {
		const result = await callTool('resize_session', {name: SESSION, cols: 100, rows: 30});
		expect(textOf(result)).toBe(`resized ${SESSION} to 100x30`);
		const status = await callTool('get_session_status', {name: SESSION});
		expect(status.structuredContent).toMatchObject({cols: 100, rows: 30});
	}, 30_000);
});

describe('errors', () => {
	test('unknown session names produce a tool error naming the session', async () => {
		for (const name of ['get_screen', 'get_session_status', 'stop_session']) {
			const result = await callTool(name, {name: 'ghost-session'});
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('unknown session "ghost-session"');
		}
	}, 30_000);

	test('sending to an exited session reports the exit', async () => {
		const name = 'shortlived';
		await cli(['start', name, '--', 'sh', '-c', 'exit 0']);
		await Bun.sleep(300);
		const result = await callTool('send_input', {name, input: [{type: 'text', text: 'x'}]});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/exited/);
		await callTool('stop_session', {name}).catch(() => {});
	}, 45_000);

	test('schema rejects malformed input', async () => {
		const bad: [string, Record<string, unknown>][] = [
			['get_screen', {}],
			['get_screen', {name: ''}],
			['get_session_status', {name: 42}],
			['send_input', {name: SESSION, input: [{type: 'key', key: 'up'}]}],
			['send_input', {name: SESSION, input: [{type: 'control', letter: 'ctrl'}]}],
			['send_input', {name: SESSION, input: [{type: 'bytes', bytes: [999]}]}],
			['send_input', {name: SESSION, input: [{type: 'nope', text: 'x'}]}],
			['resize_session', {name: SESSION, cols: 0, rows: 10}],
			['resize_session', {name: SESSION, cols: 80}],
			['get_screen', {name: SESSION, settleMs: -1}],
		];
		for (const [name, args] of bad) {
			const result = await callTool(name, args).catch((error: unknown) => ({
				isError: true,
				content: [{type: 'text', text: String(error)}],
			}));
			expect({tool: name, args, isError: result.isError}).toMatchObject({isError: true});
		}

		// Positive controls: the schema must not simply reject everything.
		const good: [string, Record<string, unknown>][] = [
			['get_screen', {name: SESSION}],
			['get_screen', {name: SESSION, settleMs: 0, deadlineMs: 0}],
			['send_input', {name: SESSION, input: [{type: 'key', key: 'arrowUp'}]}],
			['send_input', {name: SESSION, input: [{type: 'control', letter: 'a'}]}],
			['send_input', {name: SESSION, input: [{type: 'bytes', bytes: [0, 255]}]}],
		];
		for (const [name, args] of good) {
			const result = await callTool(name, args);
			expect({tool: name, args, isError: result.isError ?? false}).toMatchObject({isError: false});
		}
	}, 45_000);

	test('stop_session stops the session and it disappears from list_sessions', async () => {
		const name = 'stoppable';
		await cli(['start', name, '--', 'sh']);
		expect(textOf(await callTool('stop_session', {name}))).toBe(`stopped ${name}`);
		await Bun.sleep(300);
		const {sessions} = (await callTool('list_sessions', {})).structuredContent as {
			sessions: {name: string}[];
		};
		expect(sessions.map((entry) => entry.name)).not.toContain(name);
	}, 45_000);
});
