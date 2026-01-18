/**
 * Safely escape regex special characters in a string
 * Used by multiple methods that need to create regex patterns
 * @param string - String to escape
 * @returns Escaped string safe for use in regex
 */
export function escapeRegExp(string: string): string {
	if (!string) return "";
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate CSS value to prevent XSS injection
 * @param value - CSS value to validate
 * @returns true if value is safe to use
 */
export function isValidCSSValue(value: string): boolean {
	if (!value || typeof value !== "string") return false;

	// Allow specific safe values
	if (value === "auto" || value === "none") return true;

	// Allow valid CSS length values (px, em, rem, vh, %)
	const validCSSPattern = /^(\d+(\.\d+)?)(px|em|rem|vh|%)$/;
	return validCSSPattern.test(value.trim());
}

/**
 * Check if content is safe to process
 * @param content - Content to validate
 * @param maxSize - Maximum allowed content size in bytes (default 5MB)
 * @returns Object with isValid flag and optional error message
 */
export function validateContent(
	content: string,
	maxSize: number = 5 * 1024 * 1024
): { isValid: boolean; error?: string } {
	if (typeof content !== "string") {
		return { isValid: false, error: "Content is not a string" };
	}

	// Check content size
	if (content.length > maxSize) {
		return {
			isValid: false,
			error: `Content too large: ${content.length} characters`,
		};
	}

	// Check for suspicious patterns that might indicate injection
	const suspiciousPatterns = [
		/<script[^>]*>/i,
		/javascript:/i,
		/data:text\/html/i,
		/vbscript:/i,
	];

	for (const pattern of suspiciousPatterns) {
		if (pattern.test(content)) {
			return {
				isValid: false,
				error: "Suspicious content pattern detected",
			};
		}
	}

	return { isValid: true };
}

/**
 * Check if content has tasks using extended pattern
 * Supports custom checkbox states like [/], [-], [~], etc.
 * @param content - Content to check
 * @returns true if content contains tasks
 */
export function hasTasksInContent(content: string): boolean {
	const extendedTaskRegex = /- \[[^\]]*\]/i;
	return extendedTaskRegex.test(content);
}

/**
 * Count tasks with different checkbox states
 * @param content - Content to parse
 * @returns Object with checkbox state as key and count as value
 */
export function countTasksByCheckboxState(content: string): {
	[state: string]: number;
} {
	const taskCounts: { [state: string]: number } = {};
	const lines = content.split("\n");

	for (const line of lines) {
		const match = line.trim().match(/^- \[([^\]]*)\]/);
		if (match) {
			const state = match[1];
			taskCounts[state] = (taskCounts[state] || 0) + 1;
		}
	}

	return taskCounts;
}

/**
 * Check if content changes are related to tasks
 * Supports custom checkbox states like [/], [-], [~], etc.
 * @param oldContent - Previous file content
 * @param newContent - Current file content
 * @returns true if task-related changes detected
 */
export function hasTaskContentChanged(
	oldContent: string,
	newContent: string
): boolean {
	// Split content into lines
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	// Find task lines in both contents - support all checkbox states
	const oldTasks = oldLines.filter((line) =>
		line.trim().match(/^[-*] \[[^\]]*\]/i)
	);
	const newTasks = newLines.filter((line) =>
		line.trim().match(/^[-*] \[[^\]]*\]/i)
	);

	// Compare task count
	if (oldTasks.length !== newTasks.length) {
		return true;
	}

	// Compare each task
	for (let i = 0; i < oldTasks.length; i++) {
		if (oldTasks[i] !== newTasks[i]) {
			return true;
		}
	}

	return false;
}

/**
 * Normalize card content for comparison by removing checkbox states and extra whitespace
 * This allows us to detect card movements regardless of checkbox state changes
 * @param cardContent - Card content to normalize
 * @returns Normalized card content
 */
export function normalizeCardContentForComparison(cardContent: string): string {
	return cardContent
		.replace(/^(\s*- )\[[^\]]*\](.*)$/gm, "$1$2") // Remove checkbox states
		.trim(); // Remove extra whitespace
}

/**
 * Update checkbox state in a single card text
 * Only updates the main card checkbox, preserving sub-items and nested checkboxes
 * @param cardText - Card text to update
 * @param targetCheckboxState - Target checkbox state (e.g., "[x]", "[ ]", "[/]")
 * @returns Updated card text
 */
export function updateCheckboxStateInCardText(
	cardText: string,
	targetCheckboxState: string
): string {
	// Split content into lines to process only the first line (main card)
	const lines = cardText.split("\n");
	if (lines.length === 0) return cardText;

	// Pattern to match various checkbox states: - [ ], - [x], - [/], - [>], etc.
	// Remove global flag to only match once per line
	const checkboxPattern = /^(\s*[-*] )\[[^\]]*\](.*)$/;

	// Only update the first line if it matches the pattern (main card line)
	if (checkboxPattern.test(lines[0])) {
		lines[0] = lines[0].replace(
			checkboxPattern,
			(match, prefix, suffix) => {
				return `${prefix}${targetCheckboxState}${suffix}`;
			}
		);
	}

	// Join lines back together, preserving sub-items unchanged
	return lines.join("\n");
}

/**
 * Extract Obsidian-style links from content
 * @param content - Content to extract links from
 * @returns Array of objects with path and optional alias
 */
export function extractObsidianLinks(
	content: string
): Array<{ path: string; alias?: string }> {
	const links: Array<{ path: string; alias?: string }> = [];
	const linkPattern = /\[\[(.*?)\]\]/g;
	let match;

	while ((match = linkPattern.exec(content)) !== null) {
		const [_, linkContent] = match;
		const [path, alias] = linkContent.split("|").map((s) => s.trim());
		links.push({ path, alias });
	}

	return links;
}

/**
 * Extract Markdown-style links from content
 * @param content - Content to extract links from
 * @returns Array of objects with text and url
 */
export function extractMarkdownLinks(
	content: string
): Array<{ text: string; url: string }> {
	const links: Array<{ text: string; url: string }> = [];
	const linkPattern = /\[(.*?)\]\((.*?)\)/g;
	let match;

	while ((match = linkPattern.exec(content)) !== null) {
		const [_, text, url] = match;
		links.push({ text: text.trim(), url: url.trim() });
	}

	return links;
}

/**
 * Extract the main link content from a card
 * @param cardText - Card text to extract link from
 * @returns Link path or null if not found
 */
export function extractMainLinkFromCard(cardText: string): string | null {
	// Look for [[link]] pattern
	const obsidianMatch = cardText.match(/\[\[([^\]]+)\]\]/);
	if (obsidianMatch) {
		return obsidianMatch[1];
	}

	// Look for [text](url) pattern
	const markdownMatch = cardText.match(/\[([^\]]+)\]\(([^)]+)\)/);
	if (markdownMatch) {
		return markdownMatch[2]; // Return the URL part
	}

	return null;
}
