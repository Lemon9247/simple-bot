import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { ansi } from "./theme.js";

export type TuiStatus = "idle" | "streaming" | "thinking" | "connecting" | "disconnected";

const STATUS_ICONS: Record<TuiStatus, string> = {
    idle: "●",
    streaming: "⟳",
    thinking: "💭",
    connecting: "⋯",
    disconnected: "○",
};

const STATUS_COLORS: Record<TuiStatus, (s: string) => string> = {
    idle: ansi.green,
    streaming: ansi.cyan,
    thinking: ansi.magenta,
    connecting: ansi.yellow,
    disconnected: ansi.red,
};

/**
 * Footer bar showing model name, streaming status, and context token count.
 * Renders as a single styled line with a dark background.
 */
export class Footer extends Text {
    private model = "unknown";
    private status: TuiStatus = "connecting";
    private contextTokens = 0;

    constructor() {
        super("", 0, 0, ansi.bgDark);
        this.refresh();
    }

    setModel(name: string): void {
        this.model = name;
        this.refresh();
    }

    setStatus(status: TuiStatus): void {
        this.status = status;
        this.refresh();
    }

    setContextTokens(tokens: number): void {
        this.contextTokens = tokens;
        this.refresh();
    }

    private refresh(): void {
        const icon = STATUS_ICONS[this.status];
        const color = STATUS_COLORS[this.status];
        const ctx = this.contextTokens > 0 ? `${Math.round(this.contextTokens / 1000)}k ctx` : "";
        const parts = [
            color(`${icon} ${this.status}`),
            ansi.dim("·"),
            this.model,
        ];
        if (ctx) {
            parts.push(ansi.dim("·"), ansi.dim(ctx));
        }
        this.setText(` ${parts.join(" ")} `);
    }
}
