const DISCORD_MAX_LENGTH = 2000;

/**
 * Split a message into chunks that fit within Discord's character limit.
 * Respects code block fences — if a split occurs inside a code block,
 * the fence is closed before the break and reopened after.
 */
export function splitMessage(text: string, maxLen = DISCORD_MAX_LENGTH): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }

        // Find the best split point within the limit
        let splitAt = findSplitPoint(remaining, maxLen);

        // Check if we're inside a code block at the split point
        const beforeSplit = remaining.slice(0, splitAt);
        const fenceState = getCodeFenceState(beforeSplit);

        if (fenceState.open) {
            // We're inside a code block — close it before the split
            const closingFence = "\n```";
            const reopeningFence = "```" + (fenceState.lang ?? "") + "\n";

            // Re-find split point with room for the closing fence,
            // ensuring the chunk (including fence) fits within maxLen
            const budget = maxLen - closingFence.length;
            const adjusted = findSplitPoint(remaining, budget);
            const chunk = remaining.slice(0, adjusted) + closingFence;
            chunks.push(chunk);
            remaining = reopeningFence + remaining.slice(adjusted);
        } else {
            chunks.push(remaining.slice(0, splitAt));
            remaining = remaining.slice(splitAt);
        }

        // Trim leading whitespace from next chunk (except inside code blocks)
        if (!getCodeFenceState(remaining).open) {
            remaining = remaining.replace(/^\n{1,2}/, "");
        }
    }

    return chunks;
}

/**
 * Find the best point to split text, preferring natural boundaries.
 * Priority: paragraph break > line break > space > hard cut.
 */
function findSplitPoint(text: string, maxLen: number): number {
    // Search up to maxLen - 1 so that delimiter + 1 never exceeds maxLen
    const searchEnd = maxLen - 1;

    // Try paragraph break (\n\n)
    const paraIdx = text.lastIndexOf("\n\n", searchEnd);
    if (paraIdx > 0) return paraIdx + 1; // keep one \n, next chunk starts after second

    // Try line break (\n)
    const lineIdx = text.lastIndexOf("\n", searchEnd);
    if (lineIdx > 0) return lineIdx + 1;

    // Try space
    const spaceIdx = text.lastIndexOf(" ", searchEnd);
    if (spaceIdx > 0) return spaceIdx + 1;

    // Hard cut
    return maxLen;
}

/**
 * Determine if the end of a text string is inside an open code fence.
 * Returns the state including the language tag if present.
 */
function getCodeFenceState(text: string): { open: boolean; lang?: string } {
    const fencePattern = /^(`{3,})([\w]*)/gm;
    let open = false;
    let lang: string | undefined;
    let match;

    while ((match = fencePattern.exec(text)) !== null) {
        if (!open) {
            open = true;
            lang = match[2] || undefined;
        } else {
            open = false;
            lang = undefined;
        }
    }

    return { open, lang };
}
