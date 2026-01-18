import { KanbanColumnCheckboxMapping } from "./types";

/**
 * Main settings interface for the Task Progress Bar plugin
 * Contains all configurable options for the plugin behavior
 */
export interface TaskProgressBarSettings {
	// Debug settings
	showDebugInfo: boolean;

	// Progress bar color settings
	progressColorScheme: "default" | "red-orange-green" | "custom";
	lowProgressColor: string;
	mediumProgressColor: string;
	highProgressColor: string;
	completeProgressColor: string;
	lowProgressThreshold: number;
	mediumProgressThreshold: number;
	highProgressThreshold: number;

	// Animation settings
	showUpdateAnimation: boolean;
	updateAnimationDelay: number;

	// Performance settings
	editorChangeDelay: number;
	keyboardInputDelay: number;
	checkboxClickDelay: number;

	// Interface settings
	maxTabsHeight: string;

	// Metadata auto-update settings
	autoUpdateMetadata: boolean;
	autoChangeStatus: boolean;
	autoUpdateFinishedDate: boolean;

	// Kanban integration settings
	autoUpdateKanban: boolean;
	kanbanCompletedColumn: string; // Deprecated but kept for backward compatibility
	statusTodo: string;
	statusInProgress: string;
	statusCompleted: string;
	kanbanAutoDetect: boolean;
	kanbanSpecificFiles: string[];
	kanbanExcludeFiles: string[];
	kanbanSyncWithStatus: boolean;

	// Auto-add to Kanban settings
	autoAddToKanban: boolean;
	autoAddKanbanBoard: string;
	autoAddKanbanColumn: string;

	// Custom checkbox states settings
	enableCustomCheckboxStates: boolean;
	kanbanColumnCheckboxMappings: KanbanColumnCheckboxMapping[];

	// Kanban sync settings
	enableKanbanToFileSync: boolean;
	enableKanbanAutoSync: boolean;
	enableKanbanNormalizationProtection: boolean;
}

/**
 * Default settings values for the plugin
 * Used when no saved settings exist or for resetting to defaults
 */
export const DEFAULT_SETTINGS: TaskProgressBarSettings = {
	showDebugInfo: false,
	progressColorScheme: "default",
	lowProgressColor: "#e06c75", // Red
	mediumProgressColor: "#e5c07b", // Orange/Yellow
	highProgressColor: "#61afef", // Blue
	completeProgressColor: "#98c379", // Green
	lowProgressThreshold: 33,
	mediumProgressThreshold: 66,
	highProgressThreshold: 99,
	showUpdateAnimation: true,
	updateAnimationDelay: 150,
	editorChangeDelay: 200,
	keyboardInputDelay: 50,
	checkboxClickDelay: 100,
	maxTabsHeight: "auto",
	autoUpdateMetadata: true,
	autoChangeStatus: true,
	autoUpdateFinishedDate: true,
	autoUpdateKanban: true,
	kanbanCompletedColumn: "Complete", // Deprecated
	statusTodo: "Todo",
	statusInProgress: "In Progress",
	statusCompleted: "Completed",
	kanbanAutoDetect: true,
	kanbanSpecificFiles: [],
	kanbanExcludeFiles: [],
	kanbanSyncWithStatus: true,
	autoAddToKanban: false,
	autoAddKanbanBoard: "",
	autoAddKanbanColumn: "Todo",
	enableCustomCheckboxStates: false,
	kanbanColumnCheckboxMappings: [
		{ columnName: "Todo", checkboxState: "[ ]" },
		{ columnName: "In Progress", checkboxState: "[/]" },
		{ columnName: "Complete", checkboxState: "[x]" },
		{ columnName: "Done", checkboxState: "[x]" },
	],
	enableKanbanToFileSync: false,
	enableKanbanAutoSync: false,
	enableKanbanNormalizationProtection: true,
};
