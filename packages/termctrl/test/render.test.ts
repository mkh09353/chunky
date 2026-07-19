import {describe, expect, test} from 'bun:test';
import type {Frame} from '../src/frame.ts';
import {css, png, svg, xml} from '../src/render.ts';

const BLACK = {r: 0, g: 0, b: 0};
const WHITE = {r: 255, g: 255, b: 255};

const attributes = (overrides: Partial<Frame['cells'][number]['attributes']> = {}) => ({
	bold: false,
	italic: false,
	faint: false,
	invisible: false,
	strikethrough: false,
	overline: false,
	underline: null,
	...overrides,
});

const cell = (overrides: Partial<Frame['cells'][number]> = {}): Frame['cells'][number] => ({
	x: 0,
	y: 0,
	text: 'A',
	width: 1,
	foreground: WHITE,
	background: BLACK,
	attributes: attributes(),
	...overrides,
});

const frame = (overrides: Partial<Frame> = {}): Frame => ({
	version: 1,
	cols: 4,
	rows: 2,
	foreground: WHITE,
	background: BLACK,
	cursor: null,
	cells: [],
	...overrides,
});

describe('css / xml helpers', () => {
	test('formats colors as zero-padded lowercase hex', () => {
		expect(css({r: 4, g: 5, b: 6})).toBe('#040506');
		expect(css({r: 255, g: 255, b: 255})).toBe('#ffffff');
	});

	test('escapes all five XML entities', () => {
		expect(xml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
	});
});

describe('svg', () => {
	test('root dimensions are cols*cellWidth + 2*padding', () => {
		const output = svg(frame({cols: 4, rows: 2}));
		// 4*9 + 36 = 72 ; 2*18 + 36 = 72
		expect(output).toContain('width="72" height="72"');
		expect(output).toContain('viewBox="0 0 72 72"');
		expect(output.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
		expect(output.endsWith('</g></svg>')).toBe(true);
	});

	test('honors custom geometry options', () => {
		const output = svg(frame({cols: 10, rows: 3}), {cellWidth: 8, cellHeight: 16, padding: 4});
		// 10*8 + 8 = 88 ; 3*16 + 8 = 56
		expect(output).toContain('width="88" height="56"');
	});

	test('emits the frame background rect with rx=10 and the font group', () => {
		const output = svg(frame({background: {r: 13, g: 17, b: 23}}));
		expect(output).toContain('<rect width="100%" height="100%" rx="10" fill="#0d1117"/>');
		expect(output).toContain(
			'<g font-family="JetBrains Mono, SFMono-Regular, Menlo, monospace" font-size="14" xml:space="preserve">',
		);
	});

	test('emits a per-cell background rect only when it differs from the frame background', () => {
		const output = svg(
			frame({
				cells: [
					cell({x: 0, background: BLACK}),
					cell({x: 1, background: {r: 4, g: 5, b: 6}}),
				],
			}),
		);
		// one root rect + exactly one cell rect
		expect(output.match(/<rect/g)).toHaveLength(2);
		expect(output).toContain('<rect x="27" y="18" width="9" height="18" fill="#040506"/>');
	});

	test('a double-width cell background spans two columns', () => {
		const output = svg(frame({cells: [cell({width: 2, background: {r: 4, g: 5, b: 6}})]}));
		expect(output).toContain('<rect x="18" y="18" width="18" height="18" fill="#040506"/>');
	});

	test('positions text on the baseline at cellHeight*0.78', () => {
		const output = svg(frame({cells: [cell({x: 1, y: 1, text: 'Hi', foreground: {r: 1, g: 2, b: 3}})]}));
		// x = 18 + 9 = 27 ; y = 18 + 18 + 14.04 = 50.04
		expect(output).toContain('<text x="27" y="50.04" fill="#010203">Hi</text>');
	});

	test('renders every text attribute', () => {
		const output = svg(
			frame({
				cells: [
					cell({
						text: 'Hi',
						foreground: {r: 1, g: 2, b: 3},
						attributes: attributes({
							bold: true,
							italic: true,
							faint: true,
							underline: 'single',
							strikethrough: true,
							overline: true,
						}),
					}),
				],
			}),
		);
		expect(output).toContain('font-weight="700"');
		expect(output).toContain('font-style="italic"');
		expect(output).toContain('opacity="0.55"');
		expect(output).toContain('text-decoration="underline line-through overline"');
	});

	test('omits attribute markup when the cell is plain', () => {
		const output = svg(frame({cells: [cell()]}));
		expect(output).not.toContain('font-weight');
		expect(output).not.toContain('font-style');
		expect(output).not.toContain('text-decoration');
		expect(output).not.toContain('opacity="0.55"');
	});

	test('invisible and empty cells emit no text element', () => {
		const output = svg(
			frame({
				cells: [
					cell({x: 0, text: 'a', attributes: attributes({invisible: true})}),
					cell({x: 1, text: ''}),
				],
			}),
		);
		expect(output).not.toContain('<text');
	});

	test('an invisible cell still paints its background', () => {
		const output = svg(
			frame({
				cells: [
					cell({text: 'a', background: {r: 4, g: 5, b: 6}, attributes: attributes({invisible: true})}),
				],
			}),
		);
		expect(output).toContain('fill="#040506"');
		expect(output).not.toContain('<text');
	});

	test('XML-escapes cell text', () => {
		const output = svg(frame({cells: [cell({text: `<&">`})]}));
		expect(output).toContain('>&lt;&amp;&quot;&gt;</text>');
		expect(output).not.toContain('><&">');
	});

	test('draws the cursor rect at 0.32 opacity in the cursor color', () => {
		const output = svg(frame({cursor: {x: 2, y: 1, color: {r: 1, g: 2, b: 3}, blinking: true}}));
		// x = 18 + 2*9 = 36 ; y = 18 + 18 = 36
		expect(output).toContain('<rect x="36" y="36" width="9" height="18" fill="#010203" opacity="0.32"/>');
	});

	test('showCursor:false suppresses the cursor', () => {
		const cursor = {x: 2, y: 1, color: {r: 1, g: 2, b: 3}, blinking: true};
		expect(svg(frame({cursor}), {showCursor: false})).not.toContain('opacity="0.32"');
		expect(svg(frame({cursor: null}))).not.toContain('opacity="0.32"');
	});

	test('box-drawing and block glyphs render as text, not geometry', () => {
		const glyphs = ['▀', '━', '┼', '●', '⠋'];
		const output = svg(
			frame({
				cols: glyphs.length,
				cells: glyphs.map((text, x) => cell({x, text})),
			}),
		);
		expect(output).not.toContain('<circle');
		expect(output).not.toContain('<polygon');
		for (const glyph of glyphs) expect(output).toContain(`>${glyph}</text>`);
	});
});

describe('png', () => {
	const fixture = frame({
		cols: 4,
		rows: 2,
		cells: [cell({x: 0, text: 'H'}), cell({x: 1, text: 'i', background: {r: 4, g: 5, b: 6}})],
		cursor: {x: 2, y: 0, color: WHITE, blinking: true},
	});

	const dimensions = (bytes: Uint8Array) => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		// IHDR width/height are the two big-endian u32s at offset 16.
		return {width: view.getUint32(16), height: view.getUint32(20)};
	};

	test('returns bytes with the PNG magic signature', () => {
		const bytes = png(fixture);
		expect(bytes.length).toBeGreaterThan(0);
		expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	});

	test('scales the raster by pixelRatio (default 2)', () => {
		// SVG is 4*9+36 = 72 wide, 2*18+36 = 72 tall.
		expect(dimensions(png(fixture))).toEqual({width: 144, height: 144});
		expect(dimensions(png(fixture, {pixelRatio: 1}))).toEqual({width: 72, height: 72});
		expect(dimensions(png(fixture, {pixelRatio: 3}))).toEqual({width: 216, height: 216});
	});

	test('rasterizes text with a real font face', () => {
		// A frame with glyphs must produce different, larger PNG data than an identical
		// empty one; if no font resolved, resvg would drop the text and the two would match.
		// (Verified out-of-band at pixel level: 124 lit pixels vs 0 for the blank frame.)
		const blank = png(frame({cols: 4, rows: 2}), {pixelRatio: 1});
		const glyphs = png(
			frame({
				cols: 4,
				rows: 2,
				cells: [...'Hi!?'].map((text, x) => cell({x, text})),
			}),
			{pixelRatio: 1},
		);
		expect(glyphs.length).toBeGreaterThan(blank.length);
		expect(Buffer.from(glyphs).equals(Buffer.from(blank))).toBe(false);
	});
});
