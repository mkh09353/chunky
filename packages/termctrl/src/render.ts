import {Resvg} from '@resvg/resvg-js';
import type {Cell, Color, Frame} from './frame.ts';

export type SvgOptions = {
	cellWidth?: number;
	cellHeight?: number;
	fontSize?: number;
	padding?: number;
	fontFamily?: string;
	showCursor?: boolean;
};

export type PngOptions = SvgOptions & {pixelRatio?: number};

type Resolved = Required<SvgOptions>;

export const DEFAULT_OPTIONS: Readonly<Resolved & {pixelRatio: number}> = Object.freeze({
	cellWidth: 9,
	cellHeight: 18,
	fontSize: 14,
	padding: 18,
	fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
	showCursor: true,
	pixelRatio: 2,
});

const resolve = (options: SvgOptions = {}): Resolved => ({
	cellWidth: options.cellWidth ?? DEFAULT_OPTIONS.cellWidth,
	cellHeight: options.cellHeight ?? DEFAULT_OPTIONS.cellHeight,
	fontSize: options.fontSize ?? DEFAULT_OPTIONS.fontSize,
	padding: options.padding ?? DEFAULT_OPTIONS.padding,
	fontFamily: options.fontFamily ?? DEFAULT_OPTIONS.fontFamily,
	showCursor: options.showCursor ?? DEFAULT_OPTIONS.showCursor,
});

/** Format a number the way the Rust original does, minus float noise. */
const num = (value: number): string => {
	const rounded = Math.round(value * 1e4) / 1e4;
	return Object.is(rounded, -0) ? '0' : String(rounded);
};

export const css = (color: Color): string =>
	`#${[color.r, color.g, color.b].map((channel) => (channel & 255).toString(16).padStart(2, '0')).join('')}`;

const sameColor = (a: Color, b: Color): boolean => a.r === b.r && a.g === b.g && a.b === b.b;

export const xml = (value: string): string =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

const text = (cell: Cell, options: Resolved): string => {
	const x = options.padding + cell.x * options.cellWidth;
	const y = options.padding + cell.y * options.cellHeight + options.cellHeight * 0.78;
	const decorations = [
		cell.attributes.underline === 'single' ? 'underline' : null,
		cell.attributes.strikethrough ? 'line-through' : null,
		cell.attributes.overline ? 'overline' : null,
	]
		.filter((value): value is string => value !== null)
		.join(' ');
	return (
		`<text x="${num(x)}" y="${num(y)}" fill="${css(cell.foreground)}"` +
		(cell.attributes.bold ? ' font-weight="700"' : '') +
		(cell.attributes.italic ? ' font-style="italic"' : '') +
		(cell.attributes.faint ? ' opacity="0.55"' : '') +
		(decorations === '' ? '' : ` text-decoration="${decorations}"`) +
		`>${xml(cell.text)}</text>`
	);
};

export function svg(frame: Frame, options: SvgOptions = {}): string {
	const resolved = resolve(options);
	const width = frame.cols * resolved.cellWidth + resolved.padding * 2;
	const height = frame.rows * resolved.cellHeight + resolved.padding * 2;
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" ` +
			`viewBox="0 0 ${num(width)} ${num(height)}">` +
			`<rect width="100%" height="100%" rx="10" fill="${css(frame.background)}"/>` +
			`<g font-family="${xml(resolved.fontFamily)}" font-size="${num(resolved.fontSize)}" xml:space="preserve">`,
	];

	for (const cell of frame.cells) {
		if (sameColor(cell.background, frame.background)) continue;
		parts.push(
			`<rect x="${num(resolved.padding + cell.x * resolved.cellWidth)}" ` +
				`y="${num(resolved.padding + cell.y * resolved.cellHeight)}" ` +
				`width="${num(cell.width * resolved.cellWidth)}" height="${num(resolved.cellHeight)}" ` +
				`fill="${css(cell.background)}"/>`,
		);
	}

	for (const cell of frame.cells) {
		if (cell.text === '' || cell.attributes.invisible) continue;
		parts.push(text(cell, resolved));
	}

	if (resolved.showCursor && frame.cursor) {
		const cursor = frame.cursor;
		parts.push(
			`<rect x="${num(resolved.padding + cursor.x * resolved.cellWidth)}" ` +
				`y="${num(resolved.padding + cursor.y * resolved.cellHeight)}" ` +
				`width="${num(resolved.cellWidth)}" height="${num(resolved.cellHeight)}" ` +
				`fill="${css(cursor.color)}" opacity="0.32"/>`,
		);
	}

	parts.push('</g></svg>');
	return parts.join('');
}

/** Standard macOS/Linux font directories resvg scans for a monospace face. */
const home = process.env.HOME ?? '';
const FONT_DIRS = [
	'/System/Library/Fonts',
	'/System/Library/Fonts/Supplemental',
	'/Library/Fonts',
	'/usr/share/fonts',
	'/usr/local/share/fonts',
	...(home === '' ? [] : [`${home}/Library/Fonts`, `${home}/.local/share/fonts`, `${home}/.fonts`]),
];

export function png(frame: Frame, options: PngOptions = {}): Uint8Array {
	const pixelRatio = options.pixelRatio ?? DEFAULT_OPTIONS.pixelRatio;
	const renderer = new Resvg(svg(frame, options), {
		fitTo: {mode: 'zoom', value: pixelRatio},
		font: {
			loadSystemFonts: true,
			fontDirs: FONT_DIRS,
			defaultFontFamily: 'monospace',
			monospaceFamily: 'Menlo',
		},
	});
	return renderer.render().asPng();
}
