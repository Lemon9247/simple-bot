import { Container, Markdown, Text, Spacer } from "@mariozechner/pi-tui";
import { ansi, markdownTheme } from "./theme.js";

/**
 * Format a tool call into a one-line summary, matching the daemon's style.
 */
function formatToolCall(toolName: string, args: Record<string, any>): string {
    switch (toolName) {
        case "read":
            return `📖 Reading \`${args?.path ?? "file"}\``;
        case "bash": {
            const cmd = String(args?.command ?? "");
            const firstLine = cmd.split("\n")[0];
            const display = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
            return `⚡ \`${display}\``;
        }
        case "edit":
            return `✏️ Editing \`${args?.path ?? "file"}\``;
        case "write":
            return `📝 Writing \`${args?.path ?? "file"}\``;
        case "grep":
        case "find":
            return `🔍 ${toolName} ${args?.pattern ?? ""}`;
        default:
            return `🔧 ${toolName}`;
    }
}

/**
 * Chat display component. Renders accumulated messages as a scrollable
 * list of Markdown, Text, and Spacer components.
 *
 * Tracks the current streaming message and updates it on each text delta.
 */
export class ChatDisplay extends Container {
    private currentMarkdown: Markdown | null = null;
    private currentText = "";
    private _streaming = false;

    get streaming(): boolean {
        return this._streaming;
    }

    /** Add a user message to the chat */
    addUserMessage(text: string): void {
        this.addChild(new Spacer(1));
        this.addChild(new Text(ansi.bold(ansi.cyan("You")), 1, 0));
        this.addChild(new Markdown(text, 1, 0, markdownTheme));
    }

    /** Add a system/info message */
    addSystemMessage(text: string): void {
        this.addChild(new Text(ansi.dim(text), 1, 0));
    }

    /** Begin a new assistant message (streaming) */
    startStream(): void {
        this._streaming = true;
        this.currentText = "";
        this.addChild(new Spacer(1));
        this.addChild(new Text(ansi.bold(ansi.magenta("Assistant")), 1, 0));
        this.currentMarkdown = new Markdown("", 1, 0, markdownTheme);
        this.addChild(this.currentMarkdown);
    }

    /** Append a text delta to the current streaming message */
    appendText(delta: string): void {
        if (!this.currentMarkdown) this.startStream();
        this.currentText += delta;
        this.currentMarkdown!.setText(this.currentText);
    }

    /** End the current streaming message */
    endStream(): void {
        this._streaming = false;
        this.currentMarkdown = null;
        this.currentText = "";
    }

    /** Add a tool call start indicator */
    addToolStart(toolName: string, args: Record<string, any>): void {
        const summary = formatToolCall(toolName, args);
        this.addChild(new Text(ansi.dim(summary), 1, 0));
    }

    /** Add a tool call end indicator */
    addToolEnd(toolName: string, isError: boolean): void {
        const icon = isError ? ansi.red("✗") : ansi.green("✓");
        this.addChild(new Text(`  ${icon} ${ansi.dim(toolName)}`, 1, 0));
    }

    /** Show thinking indicator */
    addThinkingStart(): void {
        // Thinking is shown in the footer, but we can add a subtle indicator
    }
}
