import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

const WELCOME_TEXT = "Ciallo～(∠・ω< )⌒★";
const WELCOME_ENTRY_TYPE = "ciallomax-welcome";
const EFFECT_WIDGET_KEY = "ciallomax-max-effect";
const FRAME_INTERVAL_MS = 33;
const IGNITION_MS = 1600;
const BAND_ROWS = 3;
const TITLE_FRAME_INTERVAL_MS = 80;
const TITLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TITLE_DONE_TEXT = "🟢 yaho";

// Blue-purple palette ported from Codex's Ultra effort ignition (effort_ignition.rs).
type RGB = [number, number, number];
const IGNITION_HUES: RGB[] = [
	[186, 130, 255], // purple
	[255, 120, 220], // magenta
	[120, 170, 255], // blue
];
// Dark band the glow blends into (alpha is capped at 0.6 like Codex).
const IGNITION_DARK: RGB = [18, 14, 30];

type CialloColor = "accent";

type TuiLike = {
	requestRender(): void;
};

function clamp(value: number, minimum = 0, maximum = 1): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function characterWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
		return 0;
	}

	// Keep the welcome text aligned in terminals that render CJK/full-width glyphs as two cells.
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2329 && codePoint <= 0x232a) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff01 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff)
	) {
		return 2;
	}

	return 1;
}

function clipText(text: string, maximumWidth: number): string {
	if (maximumWidth <= 0) return "";

	let width = 0;
	let result = "";
	for (const character of Array.from(text)) {
		const nextWidth = characterWidth(character);
		if (width + nextWidth > maximumWidth) break;
		result += character;
		width += nextWidth;
	}
	return result;
}

function textWidth(text: string): number {
	let width = 0;
	for (const character of Array.from(text)) {
		width += characterWidth(character);
	}
	return width;
}

function getBaseTitle(pi: ExtensionAPI): string {
	const cwd = process.cwd().split(/[\\/]/).filter(Boolean).at(-1) ?? "pi";
	const session = pi.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

// --- Startup greeting (theme-colored, unchanged) ---

function centeredStyled(theme: Theme, text: string, width: number, color: CialloColor, bold = false): string {
	if (width <= 0) return "";

	const clipped = clipText(text, width);
	const contentWidth = textWidth(clipped);
	const left = Math.max(0, Math.floor((width - contentWidth) / 2));
	const right = Math.max(0, width - left - contentWidth);
	const colored = theme.fg(color, clipped);
	return " ".repeat(left) + (bold ? theme.bold(colored) : colored) + " ".repeat(right);
}

// --- Max ignition effect, faithful to Codex: multi-row glow band + converging label ---

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
	const u = clamp(t);
	return [Math.round(lerp(a[0], b[0], u)), Math.round(lerp(a[1], b[1], u)), Math.round(lerp(a[2], b[2], u))];
}

function blend(hue: RGB, band: RGB, alpha: number): RGB {
	return lerpRgb(hue, band, alpha);
}

/** Position 0 -> purple, 0.5 -> magenta, 1 -> blue. */
function hueAt(u: number): RGB {
	const x = clamp(u);
	return x < 0.5
		? lerpRgb(IGNITION_HUES[0]!, IGNITION_HUES[1]!, x / 0.5)
		: lerpRgb(IGNITION_HUES[1]!, IGNITION_HUES[2]!, (x - 0.5) / 0.5);
}

function easeInOut(progress: number): number {
	const x = clamp(progress);
	return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Codex envelope(): ramp up over fadeIn, hold, ramp down over fadeOut. */
function envelope(elapsed: number, total: number, fadeIn: number, fadeOut: number): number {
	if (elapsed <= 0 || elapsed >= total) return 0;
	return clamp(Math.min(elapsed / Math.max(fadeIn, 1), (total - elapsed) / Math.max(fadeOut, 1)));
}

/** Codex crest(): smooth falloff for a wave band, 1 at the center of the band. */
function crest(distance: number): number {
	return distance >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * distance));
}

type Cell = {
	bg: RGB | null;
	fg: RGB | null;
	ch: string;
	/** Wide glyph continuation column: emit nothing (the glyph spans both cells). */
	cont: boolean;
};

/**
 * One row of the band. Codex tints the whole column, so every row shares the
 * ring geometry; the middle row carries the converging label.
 */
function glowRow(width: number, elapsedMs: number, rowScale: number, withText: boolean): Cell[] {
	const env = easeInOut(envelope(elapsedMs, IGNITION_MS, IGNITION_MS * 0.12, IGNITION_MS * 0.2));
	const center = width / 2;

	// Codex Pulse (Max): launch 0.10, travel 0.60, strength 1.0. The crest sits
	// on the expanding ring only, so the middle goes dark once the wave passes.
	const pulse = clamp((elapsedMs / IGNITION_MS - 0.1) / 0.6);
	const radius = easeInOut(pulse) * (center + 2 * 4.5);

	const cells: Cell[] = [];
	for (let x = 0; x < width; x++) {
		const distance = Math.abs(x + 0.5 - center);
		let alpha = 0;
		if (pulse > 0) {
			const ring = Math.abs(distance - radius);
			// Arrowhead band: sharp leading edge (outer), soft trailing tail (inner).
			const halfWidth = distance > radius ? 2.2 : 5.5;
			if (ring < halfWidth) {
				alpha = crest(ring / halfWidth) * (1 - 0.6 * pulse);
			}
		}
		alpha *= env * rowScale;
		const hue = hueAt(distance / Math.max(1, center));
		cells.push({
			bg: alpha >= 0.03 ? blend(hue, IGNITION_DARK, Math.min(alpha, 0.6)) : null,
			fg: null,
			ch: "",
			cont: false,
		});
	}

	if (withText) {
		// Codex label assembly (effort_status_line.rs): letters start widely
		// spaced (peripheral gaps wider) and converge; center letters appear
		// first, edge letters later.
		const chars = Array.from(WELCOME_TEXT);
		const n = chars.length;
		const charWidths = chars.map(characterWidth);
		const compactWidth = charWidths.reduce((a, b) => a + b, 0) + (n - 1);
		const maxExtra = Math.max(0, Math.floor(width * 0.75 - compactWidth));
		const assemble = easeInOut(clamp((elapsedMs / IGNITION_MS - 0.15) / 0.55));
		const spread = Math.round(maxExtra * (1 - assemble));

		const gapCount = n - 1;
		const gapWeights =
			gapCount === 0
				? []
				: Array.from({ length: gapCount }, (_, i) => {
						const position = i * 2 + 1;
						return Math.abs(position - gapCount) + 1;
					});
		const weightTotal = gapWeights.reduce((a, b) => a + b, 0) || 1;
		const gaps = gapWeights.map((weight) => 1 + Math.floor((spread * weight) / weightTotal));

		const labelWidth =
			charWidths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
		const left = Math.max(0, Math.floor((width - labelWidth) / 2));
		const centerIndex = (n - 1) / 2;
		const opacity = clamp((elapsedMs / IGNITION_MS - 0.15) / (0.55 * 0.6));
		const textEnv = easeInOut(envelope(elapsedMs, IGNITION_MS, IGNITION_MS * 0.12, IGNITION_MS * 0.2));

		let cursor = left;
		for (let i = 0; i < n; i++) {
			if (cursor >= width) break;
			const charWidth = charWidths[i]!;
			const edge = centerIndex === 0 ? 0 : Math.abs(i - centerIndex) / centerIndex;
			const stagger = 0.22 * edge;
			const letterOpacity = clamp((opacity - stagger) / (1 - stagger)) * textEnv;
			if (letterOpacity > 0) {
				const pos = clamp((cursor + charWidth / 2) / Math.max(1, width));
				const target = lerpRgb(hueAt(pos), [255, 255, 255], 0.35);
				cells[cursor]!.fg = lerpRgb(IGNITION_DARK, target, letterOpacity);
				cells[cursor]!.ch = chars[i]!;
				if (charWidth === 2 && cursor + 1 < width) {
					// The wide glyph spans both columns; the second column must emit
					// nothing or the rendered line overflows and pi aborts.
					cells[cursor + 1]!.cont = true;
				}
			}
			cursor += charWidth + (gaps[i] ?? 0);
		}
	}

	return cells;
}

function cellsToLine(cells: Cell[]): string {
	let line = "";
	let activeBg = false;
	for (const cell of cells) {
		if (cell.cont) continue;
		if (cell.bg) {
			if (!activeBg) {
				line += `\x1b[48;2;${cell.bg[0]};${cell.bg[1]};${cell.bg[2]}m`;
			}
			activeBg = true;
		} else if (activeBg) {
			// Reset the background or it leaks into every following cell.
			line += "\x1b[49m";
			activeBg = false;
		}
		if (cell.ch) {
			const fg = cell.fg ?? IGNITION_HUES[0]!;
			line += `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${cell.ch}`;
		} else {
			line += " ";
		}
	}
	line += "\x1b[0m";
	return line;
}

/** Three-row Codex-style ignition: glow band above/below, converging label in the middle. */
function renderIgnition(width: number, elapsedMs: number): string[] {
	if (width <= 0) return ["", "", ""];
	return Array.from({ length: BAND_ROWS }, (_, row) =>
		cellsToLine(glowRow(width, elapsedMs, row === 1 ? 1 : 0.78, row === 1)),
	);
}

/** Transient one-shot Max animation rendered above the editor so it never fights the header/footer. */
class MaxEffect {
	private readonly startedAt = Date.now();
	private timer?: ReturnType<typeof setInterval>;
	private done = false;

	constructor(
		private readonly tui: TuiLike,
		private readonly onDone: () => void,
	) {
		this.timer = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
	}

	private tick(): void {
		if (this.done) return;
		if (Date.now() - this.startedAt >= IGNITION_MS) {
			this.finish();
			return;
		}
		this.tui.requestRender();
	}

	private finish(): void {
		if (this.done) return;
		this.done = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.onDone();
	}

	render(width: number): string[] {
		return renderIgnition(width, Math.min(Date.now() - this.startedAt, IGNITION_MS));
	}

	invalidate(): void {
		// Rendered from current state every frame; nothing to clear.
	}

	dispose(): void {
		this.done = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

export default function cialloMax(pi: ExtensionAPI): void {
	let observedLevel: string | undefined;
	let animating = false;
	let titleTimer: ReturnType<typeof setInterval> | undefined;
	let titleFrameIndex = 0;

	const stopTitleAnimation = (): void => {
		if (titleTimer) {
			clearInterval(titleTimer);
			titleTimer = undefined;
		}
		titleFrameIndex = 0;
	};

	const setTitleSafely = (ui: ExtensionUIContext, title: string): boolean => {
		try {
			ui.setTitle(title);
			return true;
		} catch {
			// A session replacement or reload can invalidate the captured UI context.
			return false;
		}
	};

	const startTitleAnimation = (ui: ExtensionUIContext): void => {
		stopTitleAnimation();

		const renderNextFrame = (): boolean => {
			const frame = TITLE_SPINNER_FRAMES[titleFrameIndex % TITLE_SPINNER_FRAMES.length]!;
			titleFrameIndex++;
			if (!setTitleSafely(ui, `${frame} ${getBaseTitle(pi)}`)) {
				stopTitleAnimation();
				return false;
			}
			return true;
		};

		// Render immediately so short runs still show activity in the title bar.
		if (renderNextFrame()) {
			titleTimer = setInterval(renderNextFrame, TITLE_FRAME_INTERVAL_MS);
		}
	};

	const showCompletedTitle = (ui: ExtensionUIContext): void => {
		stopTitleAnimation();
		setTitleSafely(ui, `${TITLE_DONE_TEXT} · ${getBaseTitle(pi)}`);
	};

	// Startup greeting: a durable, TUI-only entry at the top of the transcript.
	// Using an entry (not the header) lets CialloMax coexist with header/footer extensions.
	pi.registerEntryRenderer(WELCOME_ENTRY_TYPE, (_entry, _options, theme) => ({
		render: (width: number): string[] => ["", centeredStyled(theme, WELCOME_TEXT, width, "accent", true), ""],
		invalidate: () => {},
	}));

	pi.on("session_start", (_event, ctx) => {
		observedLevel = String(ctx.thinkingLevel ?? pi.getThinkingLevel());
		if (ctx.mode !== "tui") return;

		const alreadyShown = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom" && entry.customType === WELCOME_ENTRY_TYPE);
		if (!alreadyShown) {
			pi.appendEntry(WELCOME_ENTRY_TYPE);
		}
	});

	const triggerMaxEffect = (ui: ExtensionUIContext): void => {
		if (animating) return;
		animating = true;

		// If a session replacement/reload happens mid-animation, pi invalidates the
		// captured ctx; cleanup must then be a no-op instead of throwing.
		const clearWidget = (): void => {
			animating = false;
			try {
				ui.setWidget(EFFECT_WIDGET_KEY, undefined);
			} catch {
				// Stale extension ctx after session replacement/reload — widget was
				// already torn down by pi; nothing to clear.
			}
		};

		ui.setWidget(
			EFFECT_WIDGET_KEY,
			(tui) => new MaxEffect(tui, clearWidget),
			{ placement: "aboveEditor" },
		);
	};

	pi.on("thinking_level_select", (event, ctx) => {
		if (ctx.mode !== "tui") return;

		const previousLevel = observedLevel ?? String(event.previousLevel);
		const nextLevel = String(event.level);
		observedLevel = nextLevel;

		if (nextLevel === "max" && previousLevel !== "max") {
			triggerMaxEffect(ctx.ui);
		}
	});

	// Keep the spinner running across tool calls, retries and auto-compaction.
	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		startTitleAnimation(ctx.ui);
	});

	// agent_end can be followed by an automatic retry or queued continuation;
	// agent_settled is the point at which Pi has genuinely finished the run.
	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.hasUI || !ctx.isIdle()) return;
		showCompletedTitle(ctx.ui);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTitleAnimation();
		if (animating) {
			animating = false;
			try {
				ctx.ui.setWidget(EFFECT_WIDGET_KEY, undefined);
			} catch {
				// Best-effort cleanup; the runtime may already be tearing down.
			}
		}
		observedLevel = undefined;
		if (ctx.hasUI) {
			setTitleSafely(ctx.ui, getBaseTitle(pi));
		}
	});

	// Preview the Max effect without changing the active thinking level.
	pi.registerCommand("ciallomax-preview", {
		description: "Preview the CialloMax Max transition effect",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			triggerMaxEffect(ctx.ui);
		},
	});
}
