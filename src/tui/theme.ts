import type { MarkdownTheme, EditorTheme, SelectListTheme } from "@mariozechner/pi-tui";

// ─── ANSI helpers ─────────────────────────────────────────────

export const ansi = {
    bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
    italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
    underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
    strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
    green: (s: string) => `\x1b[32m${s}\x1b[39m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
    red: (s: string) => `\x1b[31m${s}\x1b[39m`,
    blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
    magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
    gray: (s: string) => `\x1b[90m${s}\x1b[39m`,
    white: (s: string) => `\x1b[97m${s}\x1b[39m`,
    bgDark: (s: string) => `\x1b[48;5;236m${s}\x1b[49m`,
};

// ─── Markdown theme ───────────────────────────────────────────

export const markdownTheme: MarkdownTheme = {
    heading: (s) => ansi.bold(ansi.cyan(s)),
    link: (s) => ansi.underline(ansi.blue(s)),
    linkUrl: (s) => ansi.dim(s),
    code: (s) => ansi.yellow(s),
    codeBlock: (s) => s,
    codeBlockBorder: (s) => ansi.dim(s),
    quote: (s) => ansi.dim(s),
    quoteBorder: (s) => ansi.dim(s),
    hr: (s) => ansi.dim(s),
    listBullet: (s) => ansi.cyan(s),
    bold: (s) => ansi.bold(s),
    italic: (s) => ansi.italic(s),
    strikethrough: (s) => ansi.strikethrough(s),
    underline: (s) => ansi.underline(s),
};

// ─── SelectList theme ─────────────────────────────────────────

export const selectListTheme: SelectListTheme = {
    selectedPrefix: (s) => ansi.cyan(s),
    selectedText: (s) => ansi.bold(s),
    description: (s) => ansi.dim(s),
    scrollInfo: (s) => ansi.dim(s),
    noMatch: (s) => ansi.dim(s),
};

// ─── Editor theme ─────────────────────────────────────────────

export const editorTheme: EditorTheme = {
    borderColor: (s) => ansi.dim(s),
    selectList: selectListTheme,
};
