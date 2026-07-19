import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {hasFfmpeg} from '../src/video.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const packageDir = new URL('..', import.meta.url).pathname;

/** ffmpeg is probed once at load so `test.if()` gates see a real value. */
const ffmpeg = await hasFfmpeg();
if (!ffmpeg) {
	console.warn('SKIPPING cli video test: `ffmpeg -version` failed. Install ffmpeg to run it.');
}

let runtimeDir = '';
let workDir = '';

type Run = {stdout: string; stderr: string; code: number};

/** Spawn the CLI as a subprocess against the current temp runtime dir. */
async function cli(args: string[], options: {check?: boolean} = {}): Promise<Run> {
	const child = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: packageDir,
		env: {...process.env, TERMCTRL_RUNTIME_DIR: runtimeDir},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const run = {stdout, stderr, code};
	if (options.check !== false && code !== 0) {
		throw new Error(`termctrl ${args.join(' ')} exited ${code}\nstderr: ${stderr}\nstdout: ${stdout}`);
	}
	return run;
}

/** Poll a predicate instead of sleeping a fixed amount. */
async function poll<T>(
	produce: () => Promise<T>,
	done: (value: T) => boolean,
	{timeoutMs = 20_000, everyMs = 50, label = 'condition'} = {},
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T;
	for (;;) {
		last = await produce();
		if (done(last)) return last;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 400)}`);
		}
		await Bun.sleep(everyMs);
	}
}

const socketFor = (name: string) => join(runtimeDir, `${name}.sock`);
const status = async (name: string) => JSON.parse((await cli(['status', name, '--json'])).stdout);

beforeEach(async () => {
	// Short /tmp paths: unix socket paths are capped near 104 bytes on macOS.
	runtimeDir = await mkdtemp('/tmp/tc-cli-');
	workDir = await mkdtemp('/tmp/tc-work-');
});

afterEach(async () => {
	// Stop every session this test left behind, even if it failed mid-flow.
	try {
		for (const entry of await readdir(runtimeDir)) {
			if (!entry.endsWith('.sock')) continue;
			await cli(['stop', entry.slice(0, -'.sock'.length)], {check: false});
		}
	} catch {
		// runtime dir already gone
	}
	await rm(runtimeDir, {recursive: true, force: true});
	await rm(workDir, {recursive: true, force: true});
});

describe('lifecycle', () => {
	test('start, send, show, exit status, and stop', async () => {
		const name = 'life';
		// `echo READY` gives us deterministic text to wait on before sending input.
		await cli(['start', name, '--', 'bash', '-c', 'echo READY; read line; echo got:$line; sleep 0.2']);
		expect(existsSync(socketFor(name))).toBe(true);

		await cli(['wait', name, 'READY', '--timeout', '15000']);

		const running = await status(name);
		expect(running.state).toBe('running');
		expect(running.launch.command[0]).toBe('bash');

		await cli(['send', name, 'text:hello', 'enter']);
		await cli(['wait', name, 'got:hello', '--timeout', '15000']);

		const shown = await cli(['show', name]);
		expect(shown.stdout).toContain('got:hello');

		// The child exits on its own after the trailing sleep.
		const exited = await poll(() => status(name), (value) => value.state === 'exited', {
			label: 'session to exit',
		});
		expect(exited.state).toBe('exited');
		expect(exited.exit).toMatchObject({code: 0, success: true});
		expect(exited.exit.signal).toBeNull();

		// An exited session still serves its retained final screen.
		const afterExit = await cli(['show', name]);
		expect(afterExit.stdout).toContain('got:hello');

		await cli(['stop', name]);
		await poll(
			async () => existsSync(socketFor(name)),
			(present) => !present,
			{label: 'socket removal'},
		);
		expect(existsSync(socketFor(name))).toBe(false);
	}, 120_000);
});

describe('recording', () => {
	test('records header, output, input and markers, and lists them', async () => {
		const name = 'rec';
		const recording = join(workDir, 'rec.termctrl');
		await cli([
			'start',
			name,
			'--record',
			recording,
			'--',
			'bash',
			'-c',
			'echo READY; read line; echo got:$line; sleep 0.2',
		]);
		await cli(['wait', name, 'READY', '--timeout', '15000']);

		await cli(['send', name, 'text:hello', 'enter']);
		await cli(['wait', name, 'got:hello', '--timeout', '15000']);
		await cli(['mark', name, 'm1']);
		await cli(['stop', name]);

		const lines = await poll(
			async () =>
				existsSync(recording)
					? (await Bun.file(recording).text()).trim().split('\n').filter(Boolean)
					: [],
			(value) => value.some((line) => line.includes('"type":"marker"')),
			{label: 'recording to contain a marker'},
		);

		const header = JSON.parse(lines[0]!);
		expect(header).toMatchObject({type: 'header', version: 1, cols: 80, rows: 24});
		expect(header.cell_width).toBeGreaterThan(0);
		expect(header.cell_height).toBeGreaterThan(0);

		const entries = lines.slice(1).map((line) => JSON.parse(line));
		const types = new Set(entries.map((entry) => entry.type));
		expect(types.has('output')).toBe(true);
		expect(types.has('input')).toBe(true);
		expect(types.has('marker')).toBe(true);
		// Only the first line may be a header.
		expect(types.has('header')).toBe(false);

		const marker = entries.find((entry) => entry.type === 'marker');
		expect(marker).toMatchObject({type: 'marker', name: 'm1'});
		expect(Number.isInteger(marker.at_ms)).toBe(true);

		const input = entries.find((entry) => entry.type === 'input');
		expect(input.bytes).toEqual([...new TextEncoder().encode('hello\r')]);

		const listed = await cli(['markers', recording]);
		const markerLines = listed.stdout.trim().split('\n');
		expect(markerLines).toHaveLength(1);
		expect(markerLines[0]).toMatch(/^\d+\tm1$/);
	}, 120_000);
});

describe('save', () => {
	test('one-shot capture writes txt, json, svg and png artifacts', async () => {
		const out = join(workDir, 'cap');
		const result = await cli([
			'save',
			'--out',
			out,
			'--format',
			'txt',
			'--format',
			'json',
			'--format',
			'svg',
			'--format',
			'png',
			'--',
			'printf',
			'hi',
		]);
		// Each written path is echoed on stdout.
		for (const extension of ['txt', 'json', 'svg', 'png']) {
			expect(result.stdout).toContain(`${out}.${extension}`);
			expect(existsSync(`${out}.${extension}`)).toBe(true);
		}

		expect(await Bun.file(`${out}.txt`).text()).toContain('hi');

		const frame = JSON.parse(await Bun.file(`${out}.json`).text());
		expect(frame.version).toBe(1);
		expect(frame.cols).toBeGreaterThan(0);
		expect(frame.rows).toBeGreaterThan(0);
		expect(Array.isArray(frame.cells)).toBe(true);
		expect(frame.cells.some((cell: {text: string}) => cell.text === 'h')).toBe(true);

		const svg = await Bun.file(`${out}.svg`).text();
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('</svg>');

		const png = new Uint8Array(await Bun.file(`${out}.png`).arrayBuffer());
		expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(png.length).toBeGreaterThan(100);
	}, 120_000);
});

describe('video', () => {
	test.if(ffmpeg)('exports a recorded session to mp4', async () => {
		const name = 'vid';
		const recording = join(workDir, 'vid.termctrl');
		await cli([
			'start',
			name,
			'--record',
			recording,
			'--',
			'bash',
			'-c',
			'echo READY; read a; echo first:$a; read b; echo second:$b; sleep 0.2',
		]);
		await cli(['wait', name, 'READY', '--timeout', '15000']);

		await cli(['send', name, 'text:one', 'enter']);
		await cli(['wait', name, 'first:one', '--timeout', '15000']);
		await cli(['send', name, 'text:two', 'enter']);
		await cli(['wait', name, 'second:two', '--timeout', '15000']);
		await cli(['stop', name]);

		await poll(
			async () => (existsSync(recording) ? (await Bun.file(recording).text()).length : 0),
			(size) => size > 0,
			{label: 'recording to be written'},
		);

		const out = join(workDir, 'out.mp4');
		const result = await cli(['video', recording, '-o', out, '--fps', '10']);
		expect(result.stdout.trim()).toContain(out);

		expect(existsSync(out)).toBe(true);
		const file = Bun.file(out);
		expect(file.size).toBeGreaterThan(1000);

		const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
		expect(new TextDecoder().decode(head)).toContain('ftyp');
	}, 180_000);
});
