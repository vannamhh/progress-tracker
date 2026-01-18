/**
 * Progress Tracker Plugin for Obsidian
 * 
 * A plugin that tracks task progress in markdown files and integrates with Kanban boards.
 * Supports custom checkbox states and automatic status updates.
 * 
 * This file re-exports from the modular src/ structure.
 */

// Re-export the default plugin class
export { default } from "./src/main";

// Re-export types for external use
export type { TaskProgressBarSettings } from "./src/interfaces/settings";
export { DEFAULT_SETTINGS } from "./src/interfaces/settings";
export type { DataviewApi, KanbanColumnCheckboxMapping } from "./src/interfaces/types";
export { TaskProgressBarView } from "./src/views/ProgressBarView";
export { TaskProgressBarSettingTab } from "./src/views/SettingsTab";
