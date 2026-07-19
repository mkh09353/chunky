/**
 * Reader for `.termctrl` JSON Lines recordings (recording-entry-v1).
 *
 * The first line must be a `header` entry with `version: 1`; every later line is
 * an `output`, `input`, `resize` or `marker` event carrying `at_ms` (milliseconds
 * since the session started).
 */

export type RecordingHeader = {
	type: 'header';
	version: 1;
	cols: number;
	rows: number;
	cell_width: number;
	cell_height: number;
};

export type OutputEntry = {type: 'output'; at_ms: number; bytes: number[]};
export type InputEntry = {type: 'input'; at_ms: number; origin: 'client' | 'host'; bytes: number[]};
export type ResizeEntry = {
	type: 'resize';
	at_ms: number;
	cols: number;
	rows: number;
	cell_width: number;
	cell_height: number;
};
export type MarkerEntry = {type: 'marker'; at_ms: number; name: string};

export type RecordingEntry = OutputEntry | InputEntry | ResizeEntry | MarkerEntry;

export type Recording = {
	header: RecordingHeader;
	events: RecordingEntry[];
};

export type Marker = {at_ms: number; name: string};

/** Thrown for any malformed recording or edit plan, so callers can report cleanly. */
export class RecordingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RecordingError';
	}
}

const fail = (message: string): never => {
	throw new RecordingError(message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const integer = (value: unknown, min: number, max: number): boolean =>
	typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const dimension = (value: unknown): boolean => integer(value, 0, 65535);
const terminalDimension = (value: unknown): boolean => integer(value, 1, 65535);

const byteArray = (value: unknown, where: string): number[] => {
	if (!Array.isArray(value)) return fail(`${where}: "bytes" must be an array of byte values`);
	for (const byte of value) {
		if (!integer(byte, 0, 255)) return fail(`${where}: "bytes" must contain integers in 0..255`);
	}
	return value as number[];
};

function parseHeader(value: unknown, where: string): RecordingHeader {
	if (!isObject(value) || value.type !== 'header') {
		return fail(`${where}: recording must begin with a "header" entry`);
	}
	if (value.version !== 1) {
		return fail(`${where}: unsupported recording version ${JSON.stringify(value.version)} (expected 1)`);
	}
	if (!terminalDimension(value.cols) || !terminalDimension(value.rows)) {
		return fail(`${where}: header "cols" and "rows" must be integers in 1..65535`);
	}
	if (!dimension(value.cell_width) || !dimension(value.cell_height)) {
		return fail(`${where}: header "cell_width" and "cell_height" must be integers in 0..65535`);
	}
	return value as unknown as RecordingHeader;
}

function parseEntry(value: unknown, where: string): RecordingEntry {
	if (!isObject(value)) return fail(`${where}: entry must be a JSON object`);
	if (value.type === 'header') return fail(`${where}: a "header" entry may only appear on the first line`);
	if (!dimension(value.at_ms) && !integer(value.at_ms, 0, Number.MAX_SAFE_INTEGER)) {
		return fail(`${where}: "at_ms" must be a non-negative integer`);
	}
	switch (value.type) {
		case 'output':
			byteArray(value.bytes, where);
			return value as unknown as OutputEntry;
		case 'input':
			if (value.origin !== 'client' && value.origin !== 'host') {
				return fail(`${where}: input "origin" must be "client" or "host"`);
			}
			byteArray(value.bytes, where);
			return value as unknown as InputEntry;
		case 'resize':
			if (!terminalDimension(value.cols) || !terminalDimension(value.rows)) {
				return fail(`${where}: resize "cols" and "rows" must be integers in 1..65535`);
			}
			if (!dimension(value.cell_width) || !dimension(value.cell_height)) {
				return fail(`${where}: resize "cell_width" and "cell_height" must be integers in 0..65535`);
			}
			return value as unknown as ResizeEntry;
		case 'marker':
			if (typeof value.name !== 'string' || value.name.length === 0) {
				return fail(`${where}: marker "name" must be a non-empty string`);
			}
			return value as unknown as MarkerEntry;
		default:
			return fail(`${where}: unknown entry type ${JSON.stringify(value.type)}`);
	}
}

/** Parse a `.termctrl` recording from disk, validating header and every entry. */
export async function readRecording(path: string): Promise<Recording> {
	const file = Bun.file(path);
	if (!(await file.exists())) return fail(`recording not found: ${path}`);
	return parseRecording(await file.text(), path);
}

/** Parse recording text already in memory. Exposed for tests and streaming callers. */
export function parseRecording(text: string, path = '<recording>'): Recording {
	const lines = text.split('\n');
	let header: RecordingHeader | null = null;
	const events: RecordingEntry[] = [];

	for (const [index, line] of lines.entries()) {
		if (line.trim() === '') continue;
		const where = `${path}:${index + 1}`;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			return fail(`${where}: invalid JSON (${(error as Error).message})`);
		}
		if (header === null) {
			header = parseHeader(value, where);
			continue;
		}
		events.push(parseEntry(value, where));
	}

	if (header === null) return fail(`${path}: recording is empty; expected a "header" entry on line 1`);
	return {header, events};
}

/** All markers in the recording, in file order. */
export async function listMarkers(path: string): Promise<Marker[]> {
	const {events} = await readRecording(path);
	return events
		.filter((entry): entry is MarkerEntry => entry.type === 'marker')
		.map(({at_ms, name}) => ({at_ms, name}));
}

/** Marker name -> timestamp. Errors on duplicates, which would make edits ambiguous. */
export function markerTimes(events: RecordingEntry[]): Map<string, number> {
	const markers = new Map<string, number>();
	for (const entry of events) {
		if (entry.type !== 'marker') continue;
		if (markers.has(entry.name)) {
			fail(`recording contains duplicate marker ${JSON.stringify(entry.name)}`);
		}
		markers.set(entry.name, entry.at_ms);
	}
	return markers;
}
