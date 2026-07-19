/**
 * Video export for `.termctrl` recordings.
 *
 * Replays the recorded byte stream through a headless terminal, samples the
 * reconstructed screens at a fixed frame rate, renders each unique screen to PNG
 * and encodes the sequence with ffmpeg.
 */

import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Terminal} from '@xterm/headless';
import type {Attributes, Cell, Frame} from './frame.ts';
import {frameFromTerminal} from './frame.ts';
import {
	markerTimes,
	readRecording,
	RecordingError,
	type Recording,
	type RecordingEntry,
} from './recording.ts';
import {png} from './render.ts';

export {
	listMarkers,
	parseRecording,
	readRecording,
	RecordingError,
	type Marker,
	type Recording,
	type RecordingEntry,
	type RecordingHeader,
} from './recording.ts';

export type EditClip = {
	from: string;
	to: string;
	caption?: string;
	speed?: number;
	hold_ms?: number;
};

export type EditPlan = {clips: EditClip[]};

export type VideoOptions = {
	out?: string;
	fps?: number;
	cellWidth?: number;
	cellHeight?: number;
	padding?: number;
	fontFamily?: string;
	pixelRatio?: number;
	hideCursor?: boolean;
	tailMs?: number;
	includeStartup?: boolean;
	edit?: EditPlan;
};

export type VideoResult = {
	out: string;
	frames: number;
	uniqueFrames: number;
	fps: number;
	durationMs: number;
	width: number;
	height: number;
};

export const MAX_FPS = 1000;
const SCROLLBACK_ROWS = 1000;
const DEFAULT_FONT_FAMILY = 'JetBrains Mono, SFMono-Regular, Menlo, monospace';
const MAX_CAPTION_LENGTH = 1000;

const fail = (message: string): never => {
	throw new RecordingError(message);
};

/** A reconstructed screen at a point on the (possibly edited) timeline. */
type VideoFrame = {atMs: number; frame: Frame};

const cloneFrame = (frame: Frame): Frame => ({
	...frame,
	foreground: {...frame.foreground},
	background: {...frame.background},
	cursor: frame.cursor === null ? null : {...frame.cursor, color: {...frame.cursor.color}},
	cells: frame.cells.map((cell) => ({
		...cell,
		foreground: {...cell.foreground},
		background: {...cell.background},
		attributes: {...cell.attributes},
	})),
});

/** Stable identity for a frame, used to dedupe consecutive and repeated screens. */
const frameKey = (frame: Frame): string => JSON.stringify(frame);

const write = (terminal: Terminal, bytes: Uint8Array): Promise<void> =>
	new Promise((resolve) => {
		terminal.write(bytes, resolve);
	});

/**
 * Replay every output/resize event, capturing a frame whenever the screen changes.
 * Input and marker entries do not alter terminal state and are skipped.
 */
async function replay(recording: Recording): Promise<VideoFrame[]> {
	const terminal = new Terminal({
		cols: recording.header.cols,
		rows: recording.header.rows,
		scrollback: SCROLLBACK_ROWS,
		allowProposedApi: true,
	});
	const frames: VideoFrame[] = [{atMs: 0, frame: frameFromTerminal(terminal)}];
	let previous = frameKey(frames[0]!.frame);

	for (const event of recording.events) {
		if (event.type === 'output') {
			await write(terminal, Uint8Array.from(event.bytes));
		} else if (event.type === 'resize') {
			terminal.resize(event.cols, event.rows);
		} else {
			continue;
		}
		const frame = frameFromTerminal(terminal);
		const key = frameKey(frame);
		if (key === previous) continue;
		previous = key;
		frames.push({atMs: event.at_ms, frame});
	}

	terminal.dispose();
	return frames;
}

const hasNonWhitespaceText = (frame: Frame): boolean =>
	frame.cells.some((cell) => cell.text.trim() !== '');

const hasVisibleContent = (frame: Frame): boolean =>
	frame.cells.some(
		(cell) =>
			cell.text.trim() !== '' ||
			cell.background.r !== frame.background.r ||
			cell.background.g !== frame.background.g ||
			cell.background.b !== frame.background.b,
	);

/** Drop leading frames that carry no content, so videos start at the first real output. */
function visibleStates(states: VideoFrame[], includeStartup: boolean): VideoFrame[] {
	if (includeStartup) return states;
	let index = states.findIndex((state) => hasNonWhitespaceText(state.frame));
	if (index === -1) index = states.findIndex((state) => hasVisibleContent(state.frame));
	return index === -1 ? [] : states.slice(index);
}

const DEFAULT_ATTRIBUTES: Attributes = {
	bold: false,
	italic: false,
	faint: false,
	invisible: false,
	strikethrough: false,
	overline: false,
	underline: null,
};

/** Append a caption row beneath the terminal area as a single bold text cell. */
function annotate(frame: Frame, caption: string | undefined): Frame {
	if (caption === undefined) return frame;
	const text = `> ${caption}`.slice(0, Math.max(frame.cols - 2, 0));
	if (text === '') return frame;
	const next = cloneFrame(frame);
	const y = next.rows;
	next.rows += 2;
	const cell: Cell = {
		x: 1,
		y,
		text,
		width: 1,
		foreground: {...next.foreground},
		background: {...next.background},
		attributes: {...DEFAULT_ATTRIBUTES, bold: true},
	};
	next.cells.push(cell);
	return next;
}

export function validateEdit(edit: EditPlan): void {
	if (!edit || !Array.isArray(edit.clips)) fail('video edit must be an object with a "clips" array');
	if (edit.clips.length === 0) fail('video edit must contain at least one clip');
	for (const clip of edit.clips) {
		if (typeof clip.from !== 'string' || clip.from === '' || typeof clip.to !== 'string' || clip.to === '') {
			fail('video edit clip markers must not be empty');
		}
		if (clip.caption !== undefined && [...clip.caption].length > MAX_CAPTION_LENGTH) {
			fail(`video edit clip caption must not exceed ${MAX_CAPTION_LENGTH} characters`);
		}
		if (clip.speed !== undefined && (!Number.isFinite(clip.speed) || clip.speed <= 0)) {
			fail(`video edit clip ${JSON.stringify(clip.from)} speed must be greater than zero`);
		}
		if (clip.hold_ms !== undefined && (!Number.isInteger(clip.hold_ms) || clip.hold_ms < 0)) {
			fail(`video edit clip ${JSON.stringify(clip.from)} hold_ms must be a non-negative integer`);
		}
	}
}

const scaleClipTime = (clipStart: number, from: number, atMs: number, speed: number): number =>
	clipStart + Math.floor(Math.max(atMs - from, 0) / speed);

/** Stitch the marker ranges named by the edit plan into one rebased timeline. */
function editedStates(states: VideoFrame[], events: RecordingEntry[], edit: EditPlan): VideoFrame[] {
	validateEdit(edit);
	const markers = markerTimes(events);
	const output: VideoFrame[] = [];
	let offset = 0;

	for (const clip of edit.clips) {
		const from = markers.get(clip.from);
		const to = markers.get(clip.to);
		if (from === undefined) fail(`video edit references missing marker ${JSON.stringify(clip.from)}`);
		if (to === undefined) fail(`video edit references missing marker ${JSON.stringify(clip.to)}`);
		if (from! > to!) fail(`video edit clip ${JSON.stringify(clip.from)} ends before it starts`);

		const speed = clip.speed ?? 1;
		const clipStart = offset;
		const first = [...states].reverse().find((state) => state.atMs <= from!) ?? states[0];
		if (first === undefined) fail('video edit has no visible screen state');

		output.push({atMs: offset, frame: annotate(first!.frame, clip.caption)});
		for (const state of states) {
			if (state.atMs <= from! || state.atMs > to!) continue;
			output.push({
				atMs: scaleClipTime(clipStart, from!, state.atMs, speed),
				frame: annotate(state.frame, clip.caption),
			});
		}

		const clipEnd = scaleClipTime(clipStart, from!, to!, speed);
		const last = output.at(-1);
		if (last !== undefined && last.atMs < clipEnd) {
			output.push({atMs: clipEnd, frame: last.frame});
		}

		const holdMs = clip.hold_ms ?? 0;
		offset = clipEnd + holdMs;
		if (holdMs > 0) {
			const tail = output.at(-1);
			if (tail !== undefined) output.push({atMs: offset, frame: tail.frame});
		}
	}
	return output;
}

/**
 * Map sample index -> state index at the requested frame rate, holding the final
 * screen for `tailMs`.
 */
function samples(states: VideoFrame[], fps: number, tailMs: number): number[] {
	if (states.length === 0) return [];
	const timeline: number[] = [];
	let atMs = 0;
	for (const [index, state] of states.entries()) {
		timeline.push(atMs);
		const next = states[index + 1];
		if (next !== undefined) atMs += Math.max(next.atMs - state.atMs, 0);
	}

	const endMs = atMs + tailMs;
	const output: number[] = [];
	let state = 0;
	for (let sample = 0; ; sample += 1) {
		const sampleMs = Math.floor((sample * 1000) / fps);
		if (sampleMs > endMs) break;
		while (state + 1 < timeline.length && timeline[state + 1]! <= sampleMs) state += 1;
		output.push(state);
	}
	if (output.at(-1) !== states.length - 1) output.push(states.length - 1);
	return output;
}

/** Force one canvas size for the whole video; ffmpeg requires constant dimensions. */
function renderKey(frame: Frame, cols: number, rows: number, hideCursor: boolean): Frame {
	const next = cloneFrame(frame);
	next.cols = cols;
	next.rows = rows;
	if (hideCursor) next.cursor = null;
	return next;
}

async function run(command: string[]): Promise<{ok: boolean; stderr: string}> {
	const child = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'});
	const stderr = await new Response(child.stderr).text();
	const code = await child.exited;
	return {ok: code === 0, stderr};
}

/** True when a usable `ffmpeg` binary is on PATH. */
export async function hasFfmpeg(): Promise<boolean> {
	try {
		return (await run(['ffmpeg', '-version'])).ok;
	} catch {
		return false;
	}
}

/**
 * Export a `.termctrl` recording to an MP4.
 *
 * @returns where the video landed plus frame/duration statistics.
 */
export async function exportVideo(recordingPath: string, options: VideoOptions = {}): Promise<VideoResult> {
	const out = options.out ?? 'video.mp4';
	const fps = options.fps ?? 20;
	if (!Number.isInteger(fps) || fps < 1 || fps > MAX_FPS) {
		fail(`fps must be an integer between 1 and ${MAX_FPS}`);
	}
	const tailMs = options.tailMs ?? 1000;
	if (!Number.isInteger(tailMs) || tailMs < 0) fail('tailMs must be a non-negative integer');
	if (options.edit !== undefined) validateEdit(options.edit);

	const recording = await readRecording(recordingPath);
	const cellWidth = options.cellWidth ?? recording.header.cell_width;
	const cellHeight = options.cellHeight ?? recording.header.cell_height;
	if (cellWidth <= 0 || cellHeight <= 0) {
		fail('cellWidth and cellHeight must be greater than zero (recording header may be missing them)');
	}
	const padding = options.padding ?? 18;
	const pixelRatio = options.pixelRatio ?? 2;
	const hideCursor = options.hideCursor ?? false;

	const replayed = await replay(recording);
	const visible = visibleStates(replayed, options.includeStartup ?? false);
	if (visible.length === 0) fail('recording contains no visible output frames');

	const states =
		options.edit === undefined ? visible : editedStates(visible, recording.events, options.edit);
	if (states.length === 0) fail('video edit produced no frames');

	const cols = Math.max(...states.map((state) => state.frame.cols), recording.header.cols);
	const rows = Math.max(...states.map((state) => state.frame.rows), recording.header.rows);
	const sampled = samples(states, fps, tailMs);

	const parent = dirname(out);
	if (parent !== '' && parent !== '.') await mkdir(parent, {recursive: true});
	const temp = await mkdtemp(join(tmpdir(), 'termctrl-video-'));

	const renderOptions = {
		cellWidth,
		cellHeight,
		fontSize: cellHeight * 0.78,
		padding,
		fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
		pixelRatio,
		showCursor: !hideCursor,
	};

	try {
		// One PNG per sampled index (ffmpeg needs a gapless sequence), but each unique
		// screen is only rasterized once and its bytes reused for repeats.
		const rendered = new Map<string, Uint8Array>();
		for (const [index, state] of sampled.entries()) {
			const key = renderKey(states[state]!.frame, cols, rows, hideCursor);
			const identity = frameKey(key);
			let bytes = rendered.get(identity);
			if (bytes === undefined) {
				bytes = png(key, renderOptions);
				rendered.set(identity, bytes);
			}
			await writeFile(join(temp, `frame-${String(index).padStart(6, '0')}.png`), bytes);
		}

		const result = await run([
			'ffmpeg',
			'-y',
			'-loglevel',
			'error',
			'-framerate',
			String(fps),
			'-i',
			join(temp, 'frame-%06d.png'),
			'-vf',
			'format=yuv420p',
			'-movflags',
			'+faststart',
			out,
		]);
		if (!result.ok) {
			fail(
				`ffmpeg failed while exporting ${out}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`,
			);
		}

		return {
			out,
			frames: sampled.length,
			uniqueFrames: rendered.size,
			fps,
			durationMs: Math.round((sampled.length * 1000) / fps),
			width: Math.ceil((cols * cellWidth + padding * 2) * pixelRatio),
			height: Math.ceil((rows * cellHeight + padding * 2) * pixelRatio),
		};
	} finally {
		await rm(temp, {recursive: true, force: true});
	}
}
