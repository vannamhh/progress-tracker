import { App } from "obsidian";

/**
 * Type-safe interface for Dataview API
 * Provides methods for executing JavaScript in Dataview context and accessing page data
 */
export interface DataviewApi {
	executeJs(
		code: string,
		container: HTMLElement,
		sourcePath?: string
	): Promise<any>;
	page(path: string): any;
	pages(source: string): any[];
}

/**
 * Type-safe interface for accessing Obsidian plugins
 * Extended App interface to safely access internal plugin APIs
 */
export interface ObsidianApp extends App {
	plugins?: {
		plugins?: {
			dataview?: {
				api?: DataviewApi;
			};
		};
		enabledPlugins?: Set<string>;
	};
}

/**
 * Extended window interface for Dataview API access
 * Dataview may expose its API on the global window object
 */
declare global {
	interface Window {
		DataviewAPI?: DataviewApi;
	}
}

/**
 * Interface for mapping Kanban column names to checkbox states
 * Allows custom checkbox states for different workflow stages
 */
export interface KanbanColumnCheckboxMapping {
	columnName: string;
	checkboxState: string; // e.g., "[ ]", "[/]", "[x]", "[>]", etc.
}

/**
 * Structure for storing Kanban column data with items
 */
export interface KanbanColumn {
	items: Array<{ text: string }>;
}

/**
 * Type for parsed Kanban board structure
 */
export type KanbanBoard = Record<string, KanbanColumn>;

/**
 * Interface for card movement tracking
 */
export interface CardMovement {
	card: string;
	oldColumn: string;
	newColumn: string;
	cardIndex: number;
}

/**
 * Interface for normalization detection detector state
 */
export interface NormalizationDetectorState {
	preChangeCheckpoints: Map<number, string>;
	lastKanbanUIInteraction: number;
	pendingNormalizationCheck: number | null;
}

/**
 * Interface for checkbox normalization patterns analysis result
 */
export interface CheckboxNormalizationAnalysis {
	hasNormalization: boolean;
	normalizedStates: Array<{ line: number; from: string; to: string }>;
}

/**
 * Interface for extracted Obsidian-style links
 */
export interface ObsidianLink {
	path: string;
	alias?: string;
}

/**
 * Interface for extracted Markdown-style links
 */
export interface MarkdownLink {
	text: string;
	url: string;
}

/**
 * Interface for card content extraction result
 */
export interface CardContent {
	content: string;
	lineCount: number;
}
