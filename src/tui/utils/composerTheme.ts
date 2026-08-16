type Rgb = [number, number, number];

const ANSI_16: Rgb[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

function isLight([r, g, b]: Rgb): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return y > 128;
}

function blend(top: Rgb, bg: Rgb, alpha: number): Rgb {
  const r = Math.round(top[0] * alpha + bg[0] * (1 - alpha));
  const g = Math.round(top[1] * alpha + bg[1] * (1 - alpha));
  const b = Math.round(top[2] * alpha + bg[2] * (1 - alpha));
  return [r, g, b];
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function xtermIndexToRgb(index: number): Rgb | null {
  if (index >= 0 && index < 16) return ANSI_16[index] ?? null;

  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const scale = [0, 95, 135, 175, 215, 255];
    return [scale[r]!, scale[g]!, scale[b]!];
  }

  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return [v, v, v];
  }

  return null;
}

function parseDefaultBgFromColorFgBg(raw: string | undefined): Rgb | null {
  if (!raw) return null;
  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const bgIndex = Number.parseInt(parts[parts.length - 1]!, 10);
  if (Number.isNaN(bgIndex)) return null;
  return xtermIndexToRgb(bgIndex);
}

export interface ComposerTheme {
  background: string;
  placeholder: string;
  foreground?: string;
  prompt?: string;
}

/**
 * Mirrors Codex TUI user-message tinting:
 * - dark terminal bg => blend 15% white on top
 * - light terminal bg => blend 4% black on top
 * Falls back to a dark terminal assumption when default bg is unknown.
 */
export function getComposerTheme(): ComposerTheme {
  const terminalBg = parseDefaultBgFromColorFgBg(process.env.COLORFGBG) ?? ([0, 0, 0] as Rgb);
  const light = isLight(terminalBg);
  const top: Rgb = light ? [0, 0, 0] : [255, 255, 255];
  const alpha = light ? 0.04 : 0.15;
  const blended = blend(top, terminalBg, alpha);

  return {
    background: rgbToHex(blended),
    placeholder: 'gray',
    foreground: undefined,
    prompt: undefined,
  };
}
