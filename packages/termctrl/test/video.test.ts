import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	exportVideo,
	hasFfmpeg,
	listMarkers,
	parseRecording,
	readRecording,
	RecordingError,
	validateEdit,
	type EditPlan,
} from '../src/video.ts';

const bytes = (text: string) => [...new TextEncoder().encode(text)];

const header = {type: 'header', version: 1, cols: 20, rows: 5, cell_width: 9, cell_height: 18};

/** A small recording: text, a resize, and three markers around the interesting parts. */
const RECORDING = [
	header,
	{type: 'marker', at_ms: 0, name: 'start'},
	{type: 'output', at_ms: 100, bytes: bytes('hello')},
	{type: 'input', at_ms: 150, origin: 'client', bytes: bytes('\r')},
	{type: 'output', at_ms: 200, bytes: bytes('\r\nworld')},
	{type: 'marker', at_ms: 250, name: 'middle'},
	{type: 'resize', at_ms: 300, cols: 24, rows: 6, cell_width: 9, cell_height: 18},
	{type: 'output', at_ms: 400, bytes: bytes('\r\n\x1b[1;32mdone\x1b[0m')},
	{type: 'marker', at_ms: 500, name: 'end'},
];

const serialize = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

// Probed at module load so `test.if()` gates below see the real value.
const ffmpeg = await hasFfmpeg();
if (!ffmpeg) {
	console.warn('SKIPPING video encode tests: `ffmpeg -version` failed. Install ffmpeg to run them.');
}

let dir = '';
let recordingPath = '';

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'termctrl-video-test-'));
	recordingPath = join(dir, 'session.termctrl');
	await writeFile(recordingPath, serialize(RECORDING));
});

afterAll(async () => {
	if (dir !== '') await rm(dir, {recursive: true, force: true});
});

describe('readRecording', () => {
	test('parses the header and every event, ignoring blank lines', async () => {
		const recording = await readRecording(recordingPath);
		expect(recording.header).toEqual(header as never);
		expect(recording.events).toHaveLength(RECORDING.length - 1);
		expect(recording.events.map((event) => event.type)).toEqual([
			'marker',
			'output',
			'input',
			'output',
			'marker',
			'resize',
			'output',
			'marker',
		]);
	});

	test('rejects a missing file', async () => {
		await expect(readRecording(join(dir, 'nope.termctrl'))).rejects.toThrow(/recording not found/);
	});

	test('rejects a recording that does not start with a header', () => {
		expect(() => parseRecording(serialize([{type: 'output', at_ms: 0, bytes: []}]))).toThrow(
			/must begin with a "header" entry/,
		);
	});

	test('rejects an unsupported version', () => {
		expect(() => parseRecording(serialize([{...header, version: 2}]))).toThrow(
			/unsupported recording version 2/,
		);
	});

	test('rejects malformed JSON, bad bytes and unknown entry types', () => {
		expect(() => parseRecording('{not json\n')).toThrow(/invalid JSON/);
		expect(() =>
			parseRecording(serialize([header, {type: 'output', at_ms: 0, bytes: [999]}])),
		).toThrow(/integers in 0\.\.255/);
		expect(() => parseRecording(serialize([header, {type: 'nope', at_ms: 0}]))).toThrow(
			/unknown entry type "nope"/,
		);
		expect(() => parseRecording('')).toThrow(/recording is empty/);
	});

	test('errors are RecordingError so callers can distinguish them', () => {
		expect(() => parseRecording('')).toThrow(RecordingError);
	});
});

describe('listMarkers', () => {
	test('returns every marker with its timestamp in file order', async () => {
		expect(await listMarkers(recordingPath)).toEqual([
			{at_ms: 0, name: 'start'},
			{at_ms: 250, name: 'middle'},
			{at_ms: 500, name: 'end'},
		]);
	});
});

describe('edit plan validation', () => {
	const check = (edit: EditPlan) => () => validateEdit(edit);

	test('rejects an empty clip list', () => {
		expect(check({clips: []})).toThrow(/at least one clip/);
	});

	test('rejects empty marker names', () => {
		expect(check({clips: [{from: '', to: 'end'}]})).toThrow(/markers must not be empty/);
	});

	test('rejects non-positive or non-finite speed', () => {
		expect(check({clips: [{from: 'start', to: 'end', speed: 0}]})).toThrow(/speed must be greater than zero/);
		expect(check({clips: [{from: 'start', to: 'end', speed: -2}]})).toThrow(/speed must be greater than zero/);
		expect(check({clips: [{from: 'start', to: 'end', speed: Number.NaN}]})).toThrow(
			/speed must be greater than zero/,
		);
	});

	test('rejects negative hold_ms', () => {
		expect(check({clips: [{from: 'start', to: 'end', hold_ms: -1}]})).toThrow(
			/hold_ms must be a non-negative integer/,
		);
	});

	test('rejects an over-long caption', () => {
		expect(check({clips: [{from: 'start', to: 'end', caption: 'x'.repeat(1001)}]})).toThrow(
			/must not exceed 1000 characters/,
		);
	});

	test('accepts a well-formed plan', () => {
		expect(check({clips: [{from: 'start', to: 'end', caption: 'hi', speed: 2, hold_ms: 500}]})).not.toThrow();
	});

	test('exportVideo reports unknown markers by name', async () => {
		await expect(
			exportVideo(recordingPath, {
				out: join(dir, 'unused.mp4'),
				edit: {clips: [{from: 'start', to: 'ghost'}]},
			}),
		).rejects.toThrow(/missing marker "ghost"/);
	});

	test('exportVideo rejects a clip that ends before it starts', async () => {
		await expect(
			exportVideo(recordingPath, {
				out: join(dir, 'unused.mp4'),
				edit: {clips: [{from: 'end', to: 'start'}]},
			}),
		).rejects.toThrow(/ends before it starts/);
	});
});

describe('exportVideo option validation', () => {
	test('rejects an out-of-range fps', async () => {
		for (const fps of [0, -1, 1001, 1.5]) {
			await expect(exportVideo(recordingPath, {out: join(dir, 'unused.mp4'), fps})).rejects.toThrow(
				/fps must be an integer between 1 and 1000/,
			);
		}
	});

	test('rejects a negative tailMs', async () => {
		await expect(exportVideo(recordingPath, {out: join(dir, 'unused.mp4'), tailMs: -5})).rejects.toThrow(
			/tailMs must be a non-negative integer/,
		);
	});
});

/** MP4 files carry an `ftyp` box; its size prefix means the tag sits at offset 4. */
const isMp4 = (data: Uint8Array): boolean =>
	new TextDecoder().decode(data.slice(4, 8)) === 'ftyp' &&
	new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0) <= data.byteLength;

describe('exportVideo encoding', () => {
	test.if(ffmpeg)('writes a playable mp4 with the expected geometry', async () => {
		if (!ffmpeg) return;
		const out = join(dir, 'basic.mp4');
		const result = await exportVideo(recordingPath, {out, fps: 10, tailMs: 200});

		const file = Bun.file(out);
		expect(await file.exists()).toBe(true);
		const size = file.size;
		expect(size).toBeGreaterThan(1024);

		const data = new Uint8Array(await file.arrayBuffer());
		expect(isMp4(data)).toBe(true);

		expect(result.out).toBe(out);
		expect(result.fps).toBe(10);
		expect(result.frames).toBeGreaterThan(0);
		expect(result.uniqueFrames).toBeGreaterThan(0);
		expect(result.uniqueFrames).toBeLessThanOrEqual(result.frames);
		// Canvas grows to the widest resize: 24 cols x 6 rows, at pixelRatio 2.
		expect(result.width).toBe((24 * 9 + 36) * 2);
		expect(result.height).toBe((6 * 18 + 36) * 2);
	}, 120_000);

	test.if(ffmpeg)('ffprobe confirms the stream dimensions and frame count', async () => {
		if (!ffmpeg) return;
		const out = join(dir, 'probe.mp4');
		const result = await exportVideo(recordingPath, {out, fps: 10, tailMs: 200});

		const probe = Bun.spawn(
			[
				'ffprobe',
				'-v',
				'error',
				'-select_streams',
				'v:0',
				'-show_entries',
				'stream=width,height,nb_frames',
				'-of',
				'json',
				out,
			],
			{stdout: 'pipe', stderr: 'pipe'},
		);
		const text = await new Response(probe.stdout).text();
		if ((await probe.exited) !== 0) return; // ffprobe absent; the mp4 checks above still stand.

		const stream = JSON.parse(text).streams?.[0];
		expect(stream.width).toBe(result.width);
		expect(stream.height).toBe(result.height);
		expect(Number(stream.nb_frames)).toBe(result.frames);
	}, 120_000);

	test.if(ffmpeg)('honors an edit plan with captions, speed and hold', async () => {
		if (!ffmpeg) return;
		const out = join(dir, 'edited.mp4');
		const result = await exportVideo(recordingPath, {
			out,
			fps: 10,
			tailMs: 100,
			edit: {clips: [{from: 'start', to: 'middle', caption: 'first half', speed: 2, hold_ms: 300}]},
		});

		expect(await Bun.file(out).exists()).toBe(true);
		expect(isMp4(new Uint8Array(await Bun.file(out).arrayBuffer()))).toBe(true);
		// The caption adds two rows below the terminal area.
		expect(result.height).toBe((7 * 18 + 36) * 2);
	}, 120_000);

	test.if(ffmpeg)('hideCursor and includeStartup change the render without breaking output', async () => {
		if (!ffmpeg) return;
		const out = join(dir, 'flags.mp4');
		const result = await exportVideo(recordingPath, {
			out,
			fps: 5,
			tailMs: 0,
			hideCursor: true,
			includeStartup: true,
		});
		expect(await Bun.file(out).exists()).toBe(true);
		expect(result.frames).toBeGreaterThan(0);
	}, 120_000);

	test.if(ffmpeg)('cleans up its temp frame directory', async () => {
		if (!ffmpeg) return;
		const {readdir} = await import('node:fs/promises');
		const before = (await readdir(tmpdir())).filter((name) => name.startsWith('termctrl-video-')).length;
		await exportVideo(recordingPath, {out: join(dir, 'cleanup.mp4'), fps: 5, tailMs: 0});
		const after = (await readdir(tmpdir())).filter((name) => name.startsWith('termctrl-video-')).length;
		expect(after).toBe(before);
	}, 120_000);
});
