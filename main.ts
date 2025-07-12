import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	TFile,
	MarkdownView,
	ItemView,
	Editor,
	MarkdownPostProcessorContext,
	debounce,
	Notice,
	SuggestModal,
} from "obsidian";

/**
 * Debug logger utility that only logs when debug mode is enabled
 * Prevents console spam in production builds
 */
class DebugLogger {
	private isDebugEnabled: () => boolean;

	constructor(isDebugEnabled: () => boolean) {
		this.isDebugEnabled = isDebugEnabled;
	}

	log(message: string, ...args: any[]): void {
		if (this.isDebugEnabled()) {
			console.log(`[Progress Tracker] ${message}`, ...args);
		}
	}

	error(message: string, error?: Error): void {
		if (this.isDebugEnabled()) {
			console.error(`[Progress Tracker ERROR] ${message}`, error);
		}
	}

	warn(message: string, ...args: any[]): void {
		if (this.isDebugEnabled()) {
			console.warn(`[Progress Tracker WARNING] ${message}`, ...args);
		}
	}
}

/**
 * Type-safe interface for Dataview API
 */
interface DataviewApi {
	executeJs(
		code: string,
		container: HTMLElement,
		sourcePath?: string
	): Promise<any>;
	page(path: string): any;
	pages(source: string): any[];
}

/**
 * Type-safe interface for accessing plugins
 */
interface ObsidianApp extends App {
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
 */
declare global {
	interface Window {
		DataviewAPI?: DataviewApi;
	}
}

/**
 * Safely get Dataview API with proper type checking
 * @param app - Obsidian app instance
 * @returns DataviewApi instance or null if not available
 */
function getDataviewAPI(app: App): DataviewApi | null {
	try {
		// Method 1: Through window object (most reliable)
		if (typeof window !== 'undefined' && window.DataviewAPI) {
			return window.DataviewAPI;
		}

		// Method 2: Through app.plugins with type safety
		const obsidianApp = app as ObsidianApp;
		const dataviewPlugin = obsidianApp.plugins?.plugins?.dataview;
		if (dataviewPlugin?.api) {
			return dataviewPlugin.api;
		}

		// Method 3: Check if plugin is enabled
		const enabledPlugins = obsidianApp.plugins?.enabledPlugins;
		if (enabledPlugins?.has("dataview")) {
			// Plugin is enabled but API not ready yet
			return null;
		}

		return null;
	} catch (error) {
		console.error("Error accessing Dataview API:", error);
		return null;
	}
}

// Define custom checkbox mapping interface
interface KanbanColumnCheckboxMapping {
	columnName: string;
	checkboxState: string; // e.g., "[ ]", "[/]", "[x]", "[>]", etc.
}

interface TaskProgressBarSettings {
	showDebugInfo: boolean;
	progressColorScheme: "default" | "red-orange-green" | "custom";
	lowProgressColor: string;
	mediumProgressColor: string;
	highProgressColor: string;
	completeProgressColor: string;
	lowProgressThreshold: number;
	mediumProgressThreshold: number;
	highProgressThreshold: number;
	showUpdateAnimation: boolean;
	updateAnimationDelay: number;
	editorChangeDelay: number;
	keyboardInputDelay: number;
	checkboxClickDelay: number;
	maxTabsHeight: string;
	autoUpdateMetadata: boolean;
	autoChangeStatus: boolean;
	autoUpdateFinishedDate: boolean;
	autoUpdateKanban: boolean;
	kanbanCompletedColumn: string; // Deprecated but kept for backward compatibility
	statusTodo: string;
	statusInProgress: string;
	statusCompleted: string;
	kanbanAutoDetect: boolean;
	kanbanSpecificFiles: string[];
	kanbanExcludeFiles: string[];
	kanbanSyncWithStatus: boolean;
	autoAddToKanban: boolean;
	autoAddKanbanBoard: string;
	autoAddKanbanColumn: string;
	// New settings for custom checkbox states
	enableCustomCheckboxStates: boolean;
	kanbanColumnCheckboxMappings: KanbanColumnCheckboxMapping[];
	// New setting for reverse Kanban sync
	enableKanbanToFileSync: boolean;
	// New setting for auto-sync checkbox states on Kanban open
	enableKanbanAutoSync: boolean;
	// NEW: Protection from Kanban normalization
	enableKanbanNormalizationProtection: boolean;
}

const DEFAULT_SETTINGS: TaskProgressBarSettings = {
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
	updateAnimationDelay: 150, // Reduced from 300ms to 150ms
	editorChangeDelay: 200, // Reduced from 500ms to 200ms
	keyboardInputDelay: 50, // Reduced from 100ms to 50ms
	checkboxClickDelay: 100, // Reduced from 200ms to 100ms
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

export default class TaskProgressBarPlugin extends Plugin {
	settings: TaskProgressBarSettings;
	dvAPI: DataviewApi | null = null;
	sidebarView: TaskProgressBarView | null = null;
	private lastActiveFile: TFile | null = null;
	private lastFileContent: string = "";
	private dataviewCheckInterval: number | null = null;
	// Debug logger instance
	private logger: DebugLogger;
	// New tracking variables for Kanban-to-file sync
	private lastKanbanContent: Map<string, string> = new Map();
	private isUpdatingFromKanban: boolean = false;
	// Track which Kanban files have been auto-synced to avoid repeat runs
	private autoSyncedFiles: Set<string> = new Set();
	// Track last update time for each file to detect timing conflicts
	private lastFileUpdateMap: Map<string, number> = new Map();
	// NEW: Smart Kanban interaction detection
	private kanbanNormalizationDetector: Map<string, {
		preChangeCheckpoints: Map<number, string>;
		lastKanbanUIInteraction: number;
		pendingNormalizationCheck: number | null;
	}> = new Map();

	async onload() {
		await this.loadSettings();

		// Initialize debug logger
		this.logger = new DebugLogger(() => this.settings.showDebugInfo);

		// Apply the max-height CSS style as soon as the plugin loads
		this.applyMaxTabsHeightStyle();

		// Register view type for the sidebar
		this.registerView(
			"progress-tracker",
			(leaf) => (this.sidebarView = new TaskProgressBarView(leaf, this))
		);

		// Add icon to the left sidebar
		this.addRibbonIcon("bar-chart-horizontal", "Progress Tracker", () => {
			this.activateView();
		});

		// Add settings tab
		this.addSettingTab(new TaskProgressBarSettingTab(this.app, this));

		// Check Dataview API and set up interval to check again if not found
		this.checkDataviewAPI();

		// Register event to update progress bar when file changes
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.lastActiveFile = file;

					// Handle auto-sync for Kanban boards (run once per file per session)
					if (this.settings.enableKanbanAutoSync && 
						this.settings.enableCustomCheckboxStates &&
						this.isKanbanBoard(file) &&
						!this.autoSyncedFiles.has(file.path) &&
						!this.isUpdatingFromKanban) {
						
						this.logger.log(`Auto-syncing Kanban board on open: ${file.path}`);
						
						// Add small delay to ensure file is fully loaded and no other operations are running
						setTimeout(async () => {
							// Triple-check that we're not in the middle of an update and no recent changes
							if (!this.isUpdatingFromKanban && !this.lastKanbanContent.has(file.path)) {
								await this.autoSyncKanbanCheckboxStates(file);
							} else {
								this.logger.log(`Skipping auto-sync - update in progress or file already tracked`);
							}
						}, 800); // Increased delay to avoid conflicts with editor changes
					}

					// Original progress bar update logic
					setTimeout(async () => {
						await this.updateLastFileContent(file);
						if (this.sidebarView) {
							// Pass true to force update even for files without tasks
							this.sidebarView.updateProgressBar(file);
						}
					}, 100);
				}
			})
		);

		// Register event to listen for file modifications (for Kanban UI changes)
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				// Only handle TFile instances that are Kanban boards
				if (file instanceof TFile &&
					this.settings.enableKanbanToFileSync && 
					this.settings.enableCustomCheckboxStates &&
					this.isKanbanBoard(file)) {
					
					this.logger.log(`File modified event for Kanban board: ${file.path}`);
					
					// Skip if we're currently updating to avoid loops
					if (this.isUpdatingFromKanban) {
						this.logger.log('Skipping file modify - currently updating from plugin');
						return;
					}
					
					// Add small delay to ensure content is properly updated
					setTimeout(async () => {
						try {
							const newContent = await this.app.vault.read(file);
							await this.handleKanbanBoardChange(file, newContent);
						} catch (error) {
							if (this.settings.showDebugInfo) {
								console.error("Error handling file modify for Kanban board:", error);
							}
						}
					}, 100);
				}
			})
		);

		// Register event to update progress bar when editor changes
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				debounce(async (editor, view) => {
					if (view instanceof MarkdownView && this.sidebarView) {
						// Skip if we're currently updating from Kanban to avoid loops
						if (this.isUpdatingFromKanban) {
							this.logger.log('Skipping editor-change - currently updating from Kanban');
							return;
						}

						// Get current editor content
						const content = editor.getValue();
						const currentFile = view.file;

						// Check if this is a Kanban board file and handle card checkbox sync (independent feature)
						if (this.settings.enableKanbanToFileSync && 
							this.settings.enableCustomCheckboxStates &&
							currentFile && 
							this.isKanbanBoard(currentFile)) {
							this.logger.log(`Detected Kanban board change: ${currentFile.path}`);
							this.logger.log(`Content length: ${content.length}, lastFileContent length: ${this.lastFileContent.length}`);
							this.logger.log(`isUpdatingFromKanban: ${this.isUpdatingFromKanban}`);
							
							// NEW: Enhanced immediate Kanban normalization protection (runs for ALL Kanban changes)
							if (this.settings.enableKanbanNormalizationProtection) {
								const hasImmediateNormalization = this.detectImmediateKanbanNormalization(this.lastFileContent, content);
								this.logger.log(`Immediate normalization check: ${hasImmediateNormalization}`);
								if (hasImmediateNormalization) {
									this.logger.log('Detected immediate Kanban normalization - reverting unwanted changes');
									// Revert the normalization immediately
									const revertedContent = this.revertKanbanNormalization(this.lastFileContent, content, currentFile);
									if (revertedContent !== content) {
										// Set flag to prevent loops
										this.isUpdatingFromKanban = true;
										// Apply the reverted content and then sync all checkbox states
										setTimeout(async () => {
											// Apply sync to ensure all checkbox states match column mappings
											const syncedContent = await this.syncAllCheckboxStatesToMappings(currentFile, revertedContent);
											await this.app.vault.modify(currentFile, syncedContent);
											this.lastFileContent = syncedContent;
											
											// Try to force refresh Kanban UI
											await this.forceRefreshKanbanUI(currentFile);
											
											// Reset flag
											setTimeout(() => {
												this.isUpdatingFromKanban = false;
											}, 100);
										}, 50);
										return; // Skip further processing
									}
								} else {
									// DEBUG: If no immediate normalization detected, let's see what changed
									const oldLines = this.lastFileContent.split('\n');
									const newLines = content.split('\n');
									let changeCount = 0;
									for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
										const oldMatch = oldLines[i].match(/^(\s*- )\[([^\]]*)\]/);
										const newMatch = newLines[i].match(/^(\s*- )\[([^\]]*)\]/);
										if (oldMatch && newMatch && oldMatch[2] !== newMatch[2]) {
											changeCount++;
											this.logger.log(`Line ${i} checkbox change: [${oldMatch[2]}] → [${newMatch[2]}]`);
										}
									}
									if (changeCount > 0) {
										this.logger.log(`Found ${changeCount} checkbox changes but no immediate normalization detected`);
									}
								}
							}
							
							// Add small delay to ensure content is properly updated after drag/drop
							setTimeout(async () => {
								// Re-read the file content to ensure we have the latest version
								const latestContent = await this.app.vault.read(currentFile);
								await this.handleKanbanBoardChange(currentFile, latestContent);
							}, 200);
							// Don't return here - allow normal processing to continue
						}

						// Original logic for regular file changes (including file-to-kanban sync)
						// Check if content contains tasks (enhanced to support custom checkbox states)
						if (
							content.includes("- [") ||
							this.lastFileContent.includes("- [") ||
							/- \[[^\]]*\]/.test(content) ||
							/- \[[^\]]*\]/.test(this.lastFileContent)
						) {
							// Check if tasks have changed
							if (this.hasTaskContentChanged(this.lastFileContent, content)) {
								if (this.lastActiveFile) {
									// Update last file content before checking changes
									this.lastActiveFile = view.file;

									// Update progress bar immediately
									this.sidebarView.updateProgressBar(
										view.file,
										content
									);

									// Then update last file content
									this.lastFileContent = content;
								}
							} else {
								this.logger.log('Skipping update - no task changes detected');
							}
						}
					}
				}, this.settings.editorChangeDelay)
			)
		);

		// Listen for keydown events to detect when user enters new tasks or checks/unchecks tasks
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			// Check if we're in the editor
			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && activeView.getMode() === "source") {
				// Update immediately when pressing keys related to tasks
				if (
					[
						"Enter",
						"Space",
						"]",
						"x",
						"X",
						"Backspace",
						"Delete",
					].includes(evt.key)
				) {
					// Update immediately
					setTimeout(() => {
						const content = activeView.editor.getValue();
						
						// Check if content contains tasks and if they have changed (enhanced for custom states)
						if (
							(content.includes("- [") ||
							/- \[[^\]]*\]/.test(content)) &&
							this.hasTaskContentChanged(this.lastFileContent, content)
						) {
							this.lastActiveFile = activeView.file;

							// Update progress bar immediately
							if (this.sidebarView) {
								this.sidebarView.updateProgressBar(
									activeView.file,
									content
								);
							}

							// Then update last file content
							this.lastFileContent = content;
						}
					}, this.settings.keyboardInputDelay);
				}
			}
		});

		// Listen for click events in the editor to detect when tasks are checked/unchecked
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;

			// Check if click is on a task checkbox
			if (
				target &&
				target.tagName === "INPUT" &&
				target.classList.contains("task-list-item-checkbox")
			) {
				// Wait a bit for Obsidian to update the task state in the file
				setTimeout(async () => {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile && this.sidebarView) {
						// Read current file content
						const content = await this.app.vault.read(activeFile);

						// Only update if tasks have changed
						if (this.hasTaskContentChanged(this.lastFileContent, content)) {
							// Update progress bar immediately
							this.lastActiveFile = activeFile;
							this.sidebarView.updateProgressBar(activeFile, content);

							// Then update last file content
							this.lastFileContent = content;
						}
					}
				}, this.settings.checkboxClickDelay);
			}
		});

		// Activate view when plugin loads - wait a bit for Obsidian to fully start
		setTimeout(() => {
			this.activateView();

			// We'll use a single delayed update instead of multiple updates
			setTimeout(async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (currentFile && this.sidebarView) {
					this.logger.log("Initial file load after plugin start:", currentFile.path);

					await this.updateLastFileContent(currentFile);
					// Use a flag to indicate this is the initial load
					this.sidebarView.updateProgressBar(
						currentFile,
						undefined,
						true
					);
				}
			}, 1500);
		}, 1000);

		// Register commands
		this.addCommand({
			id: "clear-completed-files-cache",
			name: "Clear completed files cache",
			callback: () => {
				if (this.sidebarView) {
					this.sidebarView.clearCompletedFilesCache();
					new Notice(
						"Completed files cache cleared. Files can trigger completion notifications again."
					);
				}
			},
		});

		// Add debug command for Kanban sync
		this.addCommand({
			id: "debug-kanban-sync",
			name: "Debug Kanban sync status",
			callback: () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				const debugData: Record<string, any> = {
					"Current file": currentFile.path,
					"enableKanbanToFileSync": this.settings.enableKanbanToFileSync,
					"enableCustomCheckboxStates": this.settings.enableCustomCheckboxStates,
					"enableKanbanAutoSync": this.settings.enableKanbanAutoSync,
					"enableKanbanNormalizationProtection": this.settings.enableKanbanNormalizationProtection,
					"isKanbanBoard": this.isKanbanBoard(currentFile),
					"Checkbox mappings": this.settings.kanbanColumnCheckboxMappings,
					"Last Kanban content stored": this.lastKanbanContent.has(currentFile.path),
					"Auto-synced files": Array.from(this.autoSyncedFiles),
					"Current file auto-synced": this.autoSyncedFiles.has(currentFile.path),
					"isUpdatingFromKanban flag": this.isUpdatingFromKanban,
					"lastFileContent length": this.lastFileContent.length,
					"Last file update timestamp": this.lastFileUpdateMap.get(currentFile.path)
				};

				// Show current file content preview
				if (this.lastKanbanContent.has(currentFile.path)) {
					const storedContent = this.lastKanbanContent.get(currentFile.path)!;
					debugData["Stored content preview"] = `${storedContent.substring(0, 200)}...`;
				}

				this.debugOutput("Kanban Sync Debug Info", debugData);
				new Notice("Debug info logged to console. Check Developer Tools.");
			},
		});

		// Add command to reset auto-sync cache
		this.addCommand({
			id: "reset-kanban-autosync-cache",
			name: "Reset Kanban auto-sync cache",
			callback: () => {
				this.autoSyncedFiles.clear();
				new Notice("Auto-sync cache cleared. Kanban boards will be auto-synced again when opened.");
				
				this.logger.log("Auto-sync cache cleared");
			},
		});

		// Add command to test checkbox update function
		this.addCommand({
			id: "test-checkbox-update",
			name: "Test checkbox update function",
			callback: () => {
				if (!this.settings.showDebugInfo) {
					new Notice("Enable debug mode first to use this command.");
					return;
				}

				// Test cases for the fixed function
				const testCases = [
					{
						input: "- [/] Main task\n  - [ ] Sub-task 1\n  - [x] Sub-task 2",
						target: "[x]",
						expected: "- [x] Main task\n  - [ ] Sub-task 1\n  - [x] Sub-task 2"
					},
					{
						input: "- [ ] Simple task",
						target: "[/]",
						expected: "- [/] Simple task"
					}
				];

				console.log("=== Testing Checkbox Update Function ===");
				testCases.forEach((testCase, index) => {
					const result = this.updateCheckboxStateInCardText(testCase.input, testCase.target);
					const passed = result === testCase.expected;
					console.log(`Test ${index + 1}: ${passed ? 'PASSED' : 'FAILED'}`);
					console.log(`Input: ${testCase.input}`);
					console.log(`Expected: ${testCase.expected}`);
					console.log(`Got: ${result}`);
					console.log("---");
				});

				// Test position finding function
				console.log("=== Testing Position Finding Function ===");
				const testContent = [
					"## Todo",
					"- [ ] Task 1",
					"  - Sub item",
					"- [/] Task 2",
					"",
					"## In Progress", 
					"- [/] Task 3",
					"- [x] Task 4"
				];

				const positionTests = [
					{ card: "- [ ] Task 1\n  - Sub item", column: "Todo", expectedPos: 1 },
					{ card: "- [/] Task 3", column: "In Progress", expectedPos: 6 },
					{ card: "- [x] Non-existent", column: "Todo", expectedPos: -1 }
				];

				positionTests.forEach((test, index) => {
					const result = this.findCardPositionInContent(test.card, testContent, test.column);
					const passed = result === test.expectedPos;
					console.log(`Position Test ${index + 1}: ${passed ? 'PASSED' : 'FAILED'}`);
					console.log(`Card: ${test.card}`);
					console.log(`Column: ${test.column}`);
					console.log(`Expected Position: ${test.expectedPos}`);
					console.log(`Got Position: ${result}`);
					console.log("---");
				});

				new Notice("Checkbox update and position finding tests completed. Check console for results.");
			},
		});

		// Add command to reset conflict state
		this.addCommand({
			id: "reset-kanban-conflicts",
			name: "Reset Kanban conflict state",
			callback: () => {
				this.isUpdatingFromKanban = false;
				this.lastKanbanContent.clear();
				this.autoSyncedFiles.clear();
				this.kanbanNormalizationDetector.clear();
				
				new Notice("Kanban conflict state reset. All tracking data cleared.");
				
				if (this.settings.showDebugInfo) {
					console.log("Reset all Kanban conflict tracking:");
					console.log("- isUpdatingFromKanban: false");
					console.log("- lastKanbanContent: cleared");
					console.log("- autoSyncedFiles: cleared");
					console.log("- kanbanNormalizationDetector: cleared");
				}
			},
		});

		// Add command to test normalization detection
		this.addCommand({
			id: "test-kanban-normalization-detection",
			name: "Test Kanban normalization detection",
			callback: async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				if (!this.isKanbanBoard(currentFile)) {
					new Notice("Current file is not a Kanban board");
					return;
				}

				if (!this.settings.showDebugInfo) {
					new Notice("Enable debug mode first to use this command.");
					return;
				}

				const content = await this.app.vault.read(currentFile);
				console.log("=== Kanban Normalization Detection Test ===");
				console.log(`File: ${currentFile.path}`);
				console.log(`Protection enabled: ${this.settings.enableKanbanNormalizationProtection}`);
				
				// Show current detector state
				const detector = this.kanbanNormalizationDetector.get(currentFile.path);
				if (detector) {
					console.log("Detector state:", {
						lastKanbanUIInteraction: new Date(detector.lastKanbanUIInteraction).toISOString(),
						checkpointsCount: detector.preChangeCheckpoints.size,
						pendingCheck: detector.pendingNormalizationCheck !== null
					});
				} else {
					console.log("No detector state found for this file");
				}

				// Test pattern detection with sample content
				const testOldContent = content.replace(/\[\/\]/g, '[/]'); // Ensure we have custom states
				const testNewContent = content.replace(/\[\/\]/g, '[x]'); // Simulate normalization
				
				const patterns = this.analyzeCheckboxNormalizationPatterns(testOldContent, testNewContent);
				console.log("Pattern analysis result:", patterns);

				// Test immediate detection
				const hasImmediate = this.detectImmediateKanbanNormalization(testOldContent, testNewContent);
				console.log("Immediate normalization detection:", hasImmediate);

				// Test revert function
				if (hasImmediate) {
					const reverted = this.revertKanbanNormalization(testOldContent, testNewContent, currentFile);
					console.log("Revert test:", {
						originalLength: testOldContent.length,
						normalizedLength: testNewContent.length,
						revertedLength: reverted.length,
						revertedMatchesOriginal: reverted === testOldContent
					});
				}

				new Notice("Normalization detection test completed. Check console for results.");
			},
		});

		// Add command to test custom checkbox state counting
		this.addCommand({
			id: "test-custom-checkbox-counting",
			name: "Test custom checkbox state counting",
			callback: () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				this.app.vault.read(currentFile).then(content => {
					console.log("=== Custom Checkbox State Test ===");
					console.log(`File: ${currentFile.path}`);
					console.log(`Custom checkbox states enabled: ${this.settings.enableCustomCheckboxStates}`);
					
					if (this.settings.enableCustomCheckboxStates) {
						const taskCounts = this.countTasksByCheckboxState(content);
						console.log("Task counts by checkbox state:", taskCounts);
						
						let incompleteTasks = taskCounts[' '] || 0;
						let completedTasks = taskCounts['x'] || 0;
						let customStateTasks = 0;
						
						for (const [state, count] of Object.entries(taskCounts)) {
							if (state !== ' ' && state !== 'x' && state.trim() !== '') {
								customStateTasks += count;
							}
						}
						
						console.log(`Incomplete: ${incompleteTasks}, Completed: ${completedTasks}, Custom states: ${customStateTasks}`);
						console.log(`Total tasks: ${incompleteTasks + completedTasks + customStateTasks}`);
						console.log(`Progress: ${Math.round((completedTasks / (incompleteTasks + completedTasks + customStateTasks)) * 100)}%`);
					} else {
						console.log("Custom checkbox states are disabled");
						const incompleteTasks = (content.match(/- \[ \]/g) || []).length;
						const completedTasks = (content.match(/- \[x\]/gi) || []).length;
						console.log(`Legacy counting - Incomplete: ${incompleteTasks}, Completed: ${completedTasks}`);
					}
					
					new Notice("Custom checkbox state test completed. Check console for results.");
				});
			},
		});

		// Add command to test card movement detection logic
		this.addCommand({
			id: "test-card-movement-detection",
			name: "Test card movement detection logic",
			callback: () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				if (!this.isKanbanBoard(currentFile)) {
					new Notice("Current file is not a Kanban board");
					return;
				}

				console.log("=== Card Movement Detection Test ===");
				console.log(`File: ${currentFile.path}`);
				console.log(`Last Kanban content stored: ${this.lastKanbanContent.has(currentFile.path)}`);
				console.log(`Auto-synced: ${this.autoSyncedFiles.has(currentFile.path)}`);
				console.log(`isUpdatingFromKanban: ${this.isUpdatingFromKanban}`);
				
				const lastUpdateTime = this.lastFileUpdateMap.get(currentFile.path);
				if (lastUpdateTime) {
					const timeSinceUpdate = Date.now() - lastUpdateTime;
					console.log(`Time since last update: ${timeSinceUpdate}ms`);
				} else {
					console.log(`No last update time recorded`);
				}

				// Test normalize function
				const testCards = [
					"- [x] [[Test Card]]",
					"- [/] [[Another Card]]",
					"- [ ] [[Todo Card]]",
					"- [-] [[Cancelled Card]]"
				];

				console.log("Testing card normalization:");
				testCards.forEach(card => {
					const normalized = this.normalizeCardContentForComparison(card);
					console.log(`"${card}" -> "${normalized}"`);
				});

				new Notice("Card movement detection test completed. Check console for results.");
			},
		});

		// Add command to simulate card movement detection
		this.addCommand({
			id: "simulate-card-movement",
			name: "Simulate card movement detection",
			callback: async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				if (!this.isKanbanBoard(currentFile)) {
					new Notice("Current file is not a Kanban board");
					return;
				}

				const oldContent = this.lastKanbanContent.get(currentFile.path);
				if (!oldContent) {
					new Notice("No previous content stored. Try moving a card first.");
					return;
				}

				const newContent = await this.app.vault.read(currentFile);

				console.log("=== Simulating Card Movement Detection ===");
				console.log(`File: ${currentFile.path}`);

				try {
					const actualMovements = await this.detectActualCardMovements(oldContent, newContent, currentFile);
					console.log(`Detected ${actualMovements.length} actual card movements:`);
					actualMovements.forEach((movement, index) => {
						console.log(`${index + 1}. "${movement.card.substring(0, 40)}..." from "${movement.oldColumn}" to "${movement.newColumn}"`);
					});

					if (actualMovements.length > 0) {
						console.log("Testing updateCardCheckboxStatesInKanban with detected movements...");
						const updatedContent = await this.updateCardCheckboxStatesInKanban(oldContent, newContent, currentFile, actualMovements);
						console.log(`Content updated. Original length: ${newContent.length}, Updated length: ${updatedContent.length}`);
						
						if (updatedContent !== newContent) {
							console.log("Content would be updated with checkbox state changes.");
						} else {
							console.log("No checkbox state changes needed.");
						}
					}

				} catch (error) {
					console.error("Error in simulation:", error);
				}

				new Notice("Card movement simulation completed. Check console for results.");
			},
		});

		// Add command to debug current mappings and board state
		this.addCommand({
			id: "debug-kanban-mappings-and-board-state",
			name: "Debug Kanban mappings and board state",
			callback: async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				if (!this.isKanbanBoard(currentFile)) {
					new Notice("Current file is not a Kanban board");
					return;
				}

				console.log("=== Kanban Mappings and Board State Debug ===");
				console.log(`File: ${currentFile.path}`);
				console.log(`enableCustomCheckboxStates: ${this.settings.enableCustomCheckboxStates}`);
				
				// Show current mappings
				console.log("Current checkbox mappings:");
				this.settings.kanbanColumnCheckboxMappings.forEach((mapping, index) => {
					console.log(`  ${index + 1}. "${mapping.columnName}" → "${mapping.checkboxState}"`);
				});
				
				// Parse and analyze current board state
				const content = await this.app.vault.read(currentFile);
				const kanban = await this.parseKanbanBoardContent(content, currentFile);
				
				console.log("\nCurrent board state analysis:");
				for (const [columnName, columnData] of Object.entries(kanban)) {
					const expectedState = this.getCheckboxStateForColumn(columnName);
					console.log(`\nColumn: "${columnName}" (expected state: "${expectedState}")`);
					console.log(`  Total cards: ${columnData.items.length}`);
					
					// Count checkbox states in this column
					const stateCount: {[state: string]: number} = {};
					let correctCount = 0;
					let incorrectCount = 0;
					
					columnData.items.forEach((item, index) => {
						const match = item.text.match(/^(\s*- )\[([^\]]*)\]/);
						if (match) {
							const currentState = `[${match[2]}]`;
							stateCount[currentState] = (stateCount[currentState] || 0) + 1;
							
							if (currentState === expectedState) {
								correctCount++;
							} else {
								incorrectCount++;
								console.log(`    ${index}: "${item.text.substring(0, 50)}..." has "${currentState}" but should be "${expectedState}"`);
							}
						} else {
							console.log(`    ${index}: "${item.text.substring(0, 50)}..." - no checkbox found`);
						}
					});
					
					console.log(`  State distribution:`, stateCount);
					console.log(`  Correct states: ${correctCount}, Incorrect states: ${incorrectCount}`);
				}
				
				new Notice("Kanban mappings and board state debug completed. Check console for results.");
			},
		});

		// Add command to manually trigger Kanban board change detection
		this.addCommand({
			id: "manual-trigger-kanban-change",
			name: "Manually trigger Kanban board change detection",
			callback: async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				if (!this.isKanbanBoard(currentFile)) {
					new Notice("Current file is not a Kanban board");
					return;
				}

				console.log("=== Manual Kanban Change Trigger ===");
				console.log(`File: ${currentFile.path}`);
				
				try {
					// Read current content
					const currentContent = await this.app.vault.read(currentFile);
					console.log(`Current content length: ${currentContent.length}`);
					
					// Trigger the change detection manually
					await this.handleKanbanBoardChange(currentFile, currentContent);
					
					new Notice("Manually triggered Kanban board change detection. Check console for logs.");
				} catch (error) {
					console.error("Error in manual trigger:", error);
					new Notice(`Error: ${error.message}`);
				}
			},
		});

		// Add command to fix all checkbox states in current Kanban board
		this.addCommand({
			id: "fix-all-checkbox-states",
			name: "Fix all checkbox states in current Kanban board",
			callback: async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				if (!this.isKanbanBoard(currentFile)) {
					new Notice("Current file is not a Kanban board");
					return;
				}

				if (!this.settings.enableCustomCheckboxStates) {
					new Notice("Custom checkbox states are disabled. Enable them first in settings.");
					return;
				}

				try {
					// Set flag to prevent conflicts
					this.isUpdatingFromKanban = true;
					
					console.log("=== Fixing All Checkbox States ===");
					console.log(`File: ${currentFile.path}`);
					
					// Read current file content
					const content = await this.app.vault.read(currentFile);
					const kanban = await this.parseKanbanBoardContent(content, currentFile);
					
					// Split content into lines for position-based replacement
					const lines = content.split('\n');
					let totalChanges = 0;
					
					// Process each column and fix all cards
					for (const [columnName, columnData] of Object.entries(kanban)) {
						const targetCheckboxState = this.getCheckboxStateForColumn(columnName);
						console.log(`Fixing column "${columnName}" to checkbox state "${targetCheckboxState}" (${columnData.items.length} cards)`);
						
						// Update each card in this column
						for (const item of columnData.items) {
							const currentCheckboxMatch = item.text.match(/^(\s*- )\[([^\]]*)\]/);
							const currentCheckboxState = currentCheckboxMatch ? `[${currentCheckboxMatch[2]}]` : null;
							
							// Only update if the current state is different from target state
							if (currentCheckboxState !== targetCheckboxState) {
								const updatedCardText = this.updateCheckboxStateInCardText(item.text, targetCheckboxState);
								
								if (updatedCardText !== item.text) {
									const cardPosition = this.findCardPositionInContent(item.text, lines, columnName);
									if (cardPosition !== -1) {
										// Replace only the specific card at the found position
										const cardLines = item.text.split('\n');
										const updatedCardLines = updatedCardText.split('\n');
										
										// Replace the card lines at the specific position
										lines.splice(cardPosition, cardLines.length, ...updatedCardLines);
										totalChanges++;
										
										console.log(`  Fixed card: "${item.text.substring(0, 30)}..." from "${currentCheckboxState}" to "${targetCheckboxState}"`);
									}
								}
							}
						}
					}
					
					// Update the file if changes were made
					if (totalChanges > 0) {
						const updatedContent = lines.join('\n');
						await this.app.vault.modify(currentFile, updatedContent);
						
						// Update stored content
						this.lastKanbanContent.set(currentFile.path, updatedContent);
						
						console.log(`Fixed ${totalChanges} checkbox states in ${currentFile.basename}`);
						new Notice(`Fixed ${totalChanges} checkbox states in ${currentFile.basename}`);
					} else {
						console.log(`No changes needed - all checkbox states are already correct`);
						new Notice("All checkbox states are already correct");
					}
					
				} catch (error) {
					console.error("Error fixing checkbox states:", error);
					new Notice(`Error fixing checkbox states: ${error.message}`);
				} finally {
					// Reset flag
					setTimeout(() => {
						this.isUpdatingFromKanban = false;
					}, 200);
				}
			},
		});
	}

	/**
	 * Check for Dataview API availability and set up retry interval if not found
	 * This ensures the plugin can integrate with Dataview when it becomes available
	 */
	checkDataviewAPI() {
		// Check immediately
		this.dvAPI = getDataviewAPI(this.app);

		// If not found, set up interval to check again
		if (!this.dvAPI) {
			this.dataviewCheckInterval = window.setInterval(() => {
				this.dvAPI = getDataviewAPI(this.app);
				if (this.dvAPI) {
					// If found, clear interval
					if (this.dataviewCheckInterval) {
						clearInterval(this.dataviewCheckInterval);
						this.dataviewCheckInterval = null;
					}

					// Update sidebar if open
					if (this.sidebarView && this.lastActiveFile) {
						this.sidebarView.updateProgressBar(this.lastActiveFile);
					}
				}
			}, 2000); // Check every 2 seconds
		}
	}

	/**
	 * Update cached file content for comparison in future changes
	 * @param file File to cache content for
	 */
	async updateLastFileContent(file: TFile) {
		if (file) {
			this.lastFileContent = await this.app.vault.read(file);
		}
	}

	async activateView() {
		try {
			const { workspace } = this.app;

			// If view already exists in leaves, show it
			const leaves = workspace.getLeavesOfType("progress-tracker");
			if (leaves.length > 0) {
				workspace.revealLeaf(leaves[0]);
				return;
			}

			// Otherwise, create a new leaf in the left sidebar
			// Check if workspace is ready
			workspace.onLayoutReady(() => {
				const leaf = workspace.getLeftLeaf(false);
				if (leaf) {
					leaf.setViewState({
						type: "progress-tracker",
						active: true,
					});

					// reveal the leaf
					workspace.revealLeaf(leaf);
				}
			});
		} catch (error) {
			console.error("Error activating view:", error);
			new Notice(
				"Error activating Task Progress Bar view. Please try again later."
			);
		}
	}

	/**
	 * Cleanup all resources when plugin is unloaded
	 * Prevents memory leaks and ensures proper cleanup
	 */
	onunload() {
		try {
			// Clear interval if it exists
			if (this.dataviewCheckInterval) {
				clearInterval(this.dataviewCheckInterval);
				this.dataviewCheckInterval = null;
			}

			// Clear any in-memory data
			if (this.sidebarView) {
				this.sidebarView.clearCompletedFilesCache();
			}

			// Clear all Maps and Sets to prevent memory leaks
			this.lastKanbanContent.clear();
			this.autoSyncedFiles.clear();
			this.lastFileUpdateMap.clear();
			this.kanbanNormalizationDetector.clear();
			this.fileOperationLimiter.clear();

			// Reset flags
			this.isUpdatingFromKanban = false;
			this.lastActiveFile = null;
			this.lastFileContent = "";

			// Remove custom CSS styles
			const existingStyle = document.getElementById("progress-tracker-max-tabs-height");
			if (existingStyle) {
				existingStyle.remove();
			}

			this.logger.log("Plugin cleanup completed successfully");
		} catch (error) {
			console.error("Error during plugin cleanup:", error);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		try {
			await this.saveData(this.settings);
			// Apply the max-height style whenever settings are saved
			this.applyMaxTabsHeightStyle();
		} catch (error) {
			console.error("Error saving settings:", error);
			new Notice("Error saving settings. See console for details.");
		}
	}

	/**
	 * Safely apply max-height CSS style with input validation
	 * Prevents XSS by validating CSS values before DOM insertion
	 */
	applyMaxTabsHeightStyle() {
		try {
			// Remove any existing style element first
			const existingStyle = document.getElementById(
				"progress-tracker-max-tabs-height"
			);
			if (existingStyle) {
				existingStyle.remove();
			}

			// Validate CSS value to prevent XSS
			const maxHeight = this.settings.maxTabsHeight;
			if (!this.isValidCSSValue(maxHeight)) {
				this.logger.error(`Invalid CSS value for maxTabsHeight: ${maxHeight}`);
				return;
			}

			// Create a new style element
			const style = document.createElement("style");
			style.id = "progress-tracker-max-tabs-height";

			// Target only workspace-tabs containing our plugin view
			if (!this.settings.showDebugInfo) {
				// Use textContent instead of innerHTML for safety
				style.textContent = `
					.workspace-tabs.mod-top:has(.progress-tracker-leaf) {
						max-height: ${maxHeight} !important;
					}
				`;
				// Add the style to the document head
				document.head.appendChild(style);
			}
			
			this.logger.log(`Applied max-tabs-height: ${maxHeight} to Progress Tracker view`);
		} catch (error) {
			this.logger.error("Error applying max tabs height style", error);
		}
	}

	/**
	 * Validate CSS value to prevent XSS injection
	 * @param value CSS value to validate
	 * @returns true if value is safe to use
	 */
	private isValidCSSValue(value: string): boolean {
		if (!value || typeof value !== 'string') return false;
		
		// Allow specific safe values
		if (value === 'auto' || value === 'none') return true;
		
		// Allow valid CSS length values (px, em, rem, vh, %)
		const validCSSPattern = /^(\d+(\.\d+)?)(px|em|rem|vh|%)$/;
		return validCSSPattern.test(value.trim());
	}

	/**
	 * Safe debug output for commands - only shows when debug is enabled
	 * @param title Debug section title
	 * @param data Debug data to display
	 */
	private debugOutput(title: string, data: Record<string, any>): void {
		if (!this.settings.showDebugInfo) return;
		
		this.logger.log(`=== ${title} ===`);
		Object.entries(data).forEach(([key, value]) => {
			this.logger.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
		});
	}

	/**
	 * Validate file before performing operations
	 * @param file File to validate
	 * @returns true if file is safe to operate on
	 */
	private isValidFile(file: TFile): boolean {
		if (!file) return false;
		
		// Check if file path is safe (no path traversal)
		if (file.path.includes('..') || file.path.includes('//')) {
			this.logger.error(`Unsafe file path detected: ${file.path}`);
			return false;
		}
		
		// Check if file is markdown
		if (!file.path.endsWith('.md')) {
			this.logger.warn(`Non-markdown file: ${file.path}`);
			return false;
		}
		
		// Check file size (prevent processing extremely large files)
		if (file.stat.size > 10 * 1024 * 1024) { // 10MB limit
			this.logger.error(`File too large: ${file.path} (${file.stat.size} bytes)`);
			return false;
		}
		
		return true;
	}

	/**
	 * Validate content before processing
	 * @param content Content to validate
	 * @returns true if content is safe to process
	 */
	private isValidContent(content: string): boolean {
		if (typeof content !== 'string') return false;
		
		// Check content size
		if (content.length > 5 * 1024 * 1024) { // 5MB limit
			this.logger.error(`Content too large: ${content.length} characters`);
			return false;
		}
		
		// Check for suspicious patterns that might indicate injection
		const suspiciousPatterns = [
			/<script[^>]*>/i,
			/javascript:/i,
			/data:text\/html/i,
			/vbscript:/i
		];
		
		for (const pattern of suspiciousPatterns) {
			if (pattern.test(content)) {
				this.logger.error(`Suspicious content pattern detected`);
				return false;
			}
		}
		
		return true;
	}

	/**
	 * Rate limiter for file operations
	 */
	private fileOperationLimiter = new Map<string, number>();
	private readonly FILE_OPERATION_DELAY = 100; // Minimum ms between operations per file

	/**
	 * Check if file operation is rate limited
	 * @param filePath Path of file to check
	 * @returns true if operation should be allowed
	 */
	private checkRateLimit(filePath: string): boolean {
		const now = Date.now();
		const lastOperation = this.fileOperationLimiter.get(filePath);
		
		if (lastOperation && (now - lastOperation) < this.FILE_OPERATION_DELAY) {
			this.logger.warn(`Rate limited file operation: ${filePath}`);
			return false;
		}
		
		this.fileOperationLimiter.set(filePath, now);
		return true;
	}

	/**
	 * Standardized error handler for plugin operations
	 * @param error Error object or message
	 * @param context Context where error occurred
	 * @param showNotice Whether to show user notification
	 */
	private handleError(error: Error | string, context: string, showNotice: boolean = false): void {
		const errorMessage = error instanceof Error ? error.message : error;
		const fullMessage = `${context}: ${errorMessage}`;
		
		this.logger.error(fullMessage, error instanceof Error ? error : undefined);
		
		if (showNotice) {
			new Notice(`Progress Tracker Error: ${errorMessage}`);
		}
	}

	/**
	 * Safe async operation wrapper with error handling
	 * @param operation Async operation to execute
	 * @param context Context description for error handling
	 * @param fallbackValue Value to return on error
	 */
	private async safeAsyncOperation<T>(
		operation: () => Promise<T>,
		context: string,
		fallbackValue: T
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.handleError(error as Error, context, false);
			return fallbackValue;
		}
	}

	/**
	 * Check if content changes are related to tasks
	 * Supports custom checkbox states like [/], [-], [~], etc.
	 * @param oldContent Previous file content
	 * @param newContent Current file content
	 * @returns true if task-related changes detected
	 */
	private hasTaskContentChanged(oldContent: string, newContent: string): boolean {
		// Split content into lines
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');

		// Find task lines in both contents - support all checkbox states
		const oldTasks = oldLines.filter(line => line.trim().match(/^[-*] \[[^\]]*\]/i));
		const newTasks = newLines.filter(line => line.trim().match(/^[-*] \[[^\]]*\]/i));

		// Compare task count
		if (oldTasks.length !== newTasks.length) {
			if (this.settings.showDebugInfo) {
				console.log('Task count changed:', oldTasks.length, '->', newTasks.length);
			}
			return true;
		}

		// Compare each task
		for (let i = 0; i < oldTasks.length; i++) {
			if (oldTasks[i] !== newTasks[i]) {
				if (this.settings.showDebugInfo) {
					console.log('Task content changed:', oldTasks[i], '->', newTasks[i]);
				}
				return true;
			}
		}

		if (this.settings.showDebugInfo) {
			console.log('No task-related changes detected');
		}
		return false;
	}

	/**
	 * Check if a file is a Kanban board
	 * Uses heuristics to detect Kanban structure and plugin metadata
	 * @param file File to check
	 * @returns true if file appears to be a Kanban board
	 */
	public isKanbanBoard(file: TFile): boolean {
		if (!this.sidebarView) return false;
		return (this.sidebarView as any).isKanbanBoard(file);
	}

	/**
	 * Handle changes in Kanban board files to detect card movements and update card checkbox states
	 */
	async handleKanbanBoardChange(kanbanFile: TFile, newContent: string): Promise<void> {
		try {
			// Validate inputs
			if (!this.isValidFile(kanbanFile)) {
				this.logger.error(`Invalid file for Kanban board change: ${kanbanFile?.path}`);
				return;
			}

			if (!this.isValidContent(newContent)) {
				this.logger.error(`Invalid content for Kanban board change`);
				return;
			}

			// Check rate limit
			if (!this.checkRateLimit(kanbanFile.path)) {
				return;
			}

			this.logger.log(`handleKanbanBoardChange called for: ${kanbanFile.path}`);
			this.logger.log(`Settings - enableKanbanToFileSync: ${this.settings.enableKanbanToFileSync}, enableCustomCheckboxStates: ${this.settings.enableCustomCheckboxStates}`);

			if (!this.settings.enableKanbanToFileSync || !this.settings.enableCustomCheckboxStates) {
				if (this.settings.showDebugInfo) {
					console.log('Kanban sync disabled, skipping...');
				}
				return;
			}

			const filePath = kanbanFile.path;
			const oldContent = this.lastKanbanContent.get(filePath) || "";

			// CRITICAL FIX: Check if we're currently updating from auto-sync or other operations
			if (this.isUpdatingFromKanban) {
				if (this.settings.showDebugInfo) {
					console.log('Skipping card movement detection - currently updating from auto-sync or other operations');
				}
				return;
			}

			// CRITICAL FIX: Check if auto-sync recently ran on this file
			if (this.autoSyncedFiles.has(filePath)) {
				const timeSinceLastUpdate = Date.now() - (this.lastFileUpdateMap.get(filePath) || 0);
				if (timeSinceLastUpdate < 2000) { // If auto-sync ran within last 2 seconds
					if (this.settings.showDebugInfo) {
						console.log(`Skipping card movement detection - auto-sync ran recently (${timeSinceLastUpdate}ms ago)`);
					}
					// Still update the stored content for next comparison
					this.lastKanbanContent.set(filePath, newContent);
					return;
				}
			}

			// Update the last file update timestamp
			this.lastFileUpdateMap.set(filePath, Date.now());

			if (this.settings.showDebugInfo) {
				console.log(`Old content length: ${oldContent.length}, New content length: ${newContent.length}`);
			}

			// Store the new content for next comparison
			this.lastKanbanContent.set(filePath, newContent);

			// Skip if this is the first time we see this file
			if (!oldContent) {
				if (this.settings.showDebugInfo) {
					console.log(`First time seeing Kanban board: ${filePath}, storing content for next time`);
				}
				return;
			}

			// Skip if content is identical
			if (oldContent === newContent) {
				if (this.settings.showDebugInfo) {
					console.log('Content unchanged, skipping...');
				}
				return;
			}

			// STEP 1: Detect actual card movements first
			const actualCardMovements = await this.detectActualCardMovements(oldContent, newContent, kanbanFile);
			
			if (this.settings.showDebugInfo) {
				console.log(`Detected ${actualCardMovements.length} actual card movements:`, actualCardMovements);
			}

			// STEP 2: Process legitimate card movements and update their checkbox states
			let finalContent = newContent;
			if (actualCardMovements.length > 0) {
				finalContent = await this.updateCardCheckboxStatesInKanban(oldContent, newContent, kanbanFile, actualCardMovements);
				
				if (this.settings.showDebugInfo) {
					console.log(`Updated content for ${actualCardMovements.length} card movements`);
				}
			}

			// STEP 3: Apply protection for non-moved cards (only if protection is enabled)
			if (this.settings.enableKanbanNormalizationProtection) {
				const isKanbanNormalization = await this.detectKanbanNormalization(kanbanFile, oldContent, finalContent, actualCardMovements);
				if (isKanbanNormalization) {
					if (this.settings.showDebugInfo) {
						console.log('Detected Kanban plugin normalization - protecting custom checkbox states for non-moved cards');
					}
					finalContent = await this.protectCustomCheckboxStatesSelective(kanbanFile, oldContent, finalContent, actualCardMovements);
				}
			}

			// STEP 4: Proactively sync all checkbox states to match column mappings
			finalContent = await this.syncAllCheckboxStatesToMappings(kanbanFile, finalContent);

			// STEP 5: Update the Kanban board file if content changed
			if (finalContent !== newContent) {
				if (this.settings.showDebugInfo) {
					console.log(`Content will be updated. Original length: ${newContent.length}, Final length: ${finalContent.length}`);
				}

				// Set flag to prevent infinite loops
				this.isUpdatingFromKanban = true;
				
				await this.app.vault.modify(kanbanFile, finalContent);
				
				// Update our stored content
				this.lastKanbanContent.set(filePath, finalContent);

				// Try to force refresh Kanban UI
				await this.forceRefreshKanbanUI(kanbanFile);

				if (this.settings.showDebugInfo) {
					console.log(`Successfully updated checkbox states in Kanban board: ${kanbanFile.basename}`);
				}

				// Reset flag after a short delay
				setTimeout(() => {
					this.isUpdatingFromKanban = false;
				}, 300);
			} else {
				if (this.settings.showDebugInfo) {
					console.log('No checkbox state changes needed');
				}
			}

		} catch (error) {
			this.handleError(error as Error, "handleKanbanBoardChange", false);
		}
	}

	/**
	 * Detect actual card movements between columns (not just checkbox state changes)
	 * Returns array of card movements with old and new column information
	 */
	private async detectActualCardMovements(
		oldContent: string, 
		newContent: string, 
		kanbanFile: TFile
	): Promise<Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}>> {
		try {
			const movements: Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}> = [];
			
			// Parse both old and new Kanban structures
			const oldKanban = await this.parseKanbanBoardContent(oldContent, kanbanFile);
			const newKanban = await this.parseKanbanBoardContent(newContent, kanbanFile);

			// Create more precise card tracking with position information
			const oldCardPositions = new Map<string, Array<{column: string, index: number, originalText: string}>>();
			const newCardPositions = new Map<string, Array<{column: string, index: number, originalText: string}>>();

			// Populate old card positions map
			for (const [columnName, columnData] of Object.entries(oldKanban)) {
				columnData.items.forEach((item, index) => {
					const normalizedCard = this.normalizeCardContentForComparison(item.text);
					if (!oldCardPositions.has(normalizedCard)) {
						oldCardPositions.set(normalizedCard, []);
					}
					oldCardPositions.get(normalizedCard)!.push({
						column: columnName,
						index: index,
						originalText: item.text
					});
				});
			}

			// Populate new card positions and detect movements
			for (const [columnName, columnData] of Object.entries(newKanban)) {
				columnData.items.forEach((item, index) => {
					const normalizedCard = this.normalizeCardContentForComparison(item.text);
					if (!newCardPositions.has(normalizedCard)) {
						newCardPositions.set(normalizedCard, []);
					}
					newCardPositions.get(normalizedCard)!.push({
						column: columnName,
						index: index,
						originalText: item.text
					});
				});
			}

			// Detect movements by comparing card distributions across columns
			for (const [normalizedCard, newPositions] of newCardPositions) {
				const oldPositions = oldCardPositions.get(normalizedCard) || [];
				
				// Check for cards that appear in new columns where they weren't before
				for (const newPos of newPositions) {
					const wasInThisColumn = oldPositions.some(oldPos => oldPos.column === newPos.column);
					
					if (!wasInThisColumn && oldPositions.length > 0) {
						// This card appears in a new column - it's a movement
						// Find the most likely source column (the one that lost a card)
						const oldColumnCounts = new Map<string, number>();
						const newColumnCounts = new Map<string, number>();
						
						// Count cards in each column
						oldPositions.forEach(pos => {
							oldColumnCounts.set(pos.column, (oldColumnCounts.get(pos.column) || 0) + 1);
						});
						newPositions.forEach(pos => {
							newColumnCounts.set(pos.column, (newColumnCounts.get(pos.column) || 0) + 1);
						});
						
						// Find column that lost a card
						for (const [oldColumn, oldCount] of oldColumnCounts) {
							const newCount = newColumnCounts.get(oldColumn) || 0;
							if (newCount < oldCount) {
								// This column lost a card - it's likely the source
								movements.push({
									card: normalizedCard,
									oldColumn: oldColumn,
									newColumn: newPos.column,
									cardIndex: newPos.index
								});
								
								if (this.settings.showDebugInfo) {
									console.log(`Detected card movement: "${normalizedCard.substring(0, 30)}..." from "${oldColumn}" to "${newPos.column}"`);
								}
								break; // Only record one movement per card instance
							}
						}
					}
				}
			}

			return movements;
		} catch (error) {
			this.handleError(error as Error, "detectActualCardMovements", false);
			return [];
		}
	}

	/**
	 * Normalize card content for comparison by removing checkbox states and extra whitespace
	 * This allows us to detect card movements regardless of checkbox state changes
	 */
	private normalizeCardContentForComparison(cardContent: string): string {
		return cardContent
			.replace(/^(\s*- )\[[^\]]*\](.*)$/gm, '$1$2') // Remove checkbox states
			.trim(); // Remove extra whitespace
	}

	/**
	 * Update checkbox states in Kanban board based on card movements
	 * Uses position-based replacement to avoid affecting wrong cards
	 */
	private async updateCardCheckboxStatesInKanban(
		oldContent: string, 
		newContent: string, 
		kanbanFile: TFile,
		actualCardMovements: Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}>
	): Promise<string> {
		try {
			if (this.settings.showDebugInfo) {
				console.log('Starting card checkbox state update process...');
				console.log(`Processing ${actualCardMovements.length} actual card movements`);
			}

			// If no actual card movements, return original content
			if (actualCardMovements.length === 0) {
				if (this.settings.showDebugInfo) {
					console.log('No actual card movements to process, returning original content');
				}
				return newContent;
			}

			// Parse new Kanban structure to find cards to update
			const newKanban = await this.parseKanbanBoardContent(newContent, kanbanFile);

			// Split content into lines for position-based replacement
			const lines = newContent.split('\n');
			let changesFound = 0;

			// Process only the cards that actually moved
			for (const movement of actualCardMovements) {
				const { card: normalizedCard, oldColumn, newColumn, cardIndex } = movement;

				if (this.settings.showDebugInfo) {
					console.log(`Processing movement: "${normalizedCard.substring(0, 30)}..." from "${oldColumn}" to "${newColumn}"`);
				}

				// Find the actual card in the new content using the specific index
				const targetColumn = newKanban[newColumn];
				if (!targetColumn) {
					if (this.settings.showDebugInfo) {
						console.log(`Target column "${newColumn}" not found in new content`);
					}
					continue;
				}

				// Use the specific card index to get the exact card that moved
				if (cardIndex >= targetColumn.items.length) {
					if (this.settings.showDebugInfo) {
						console.log(`Card index ${cardIndex} out of range for column "${newColumn}" (has ${targetColumn.items.length} items)`);
					}
					continue;
				}

				const foundCard = targetColumn.items[cardIndex];
				
				// Double-check that this is the right card
				const itemNormalized = this.normalizeCardContentForComparison(foundCard.text);
				if (itemNormalized !== normalizedCard) {
					if (this.settings.showDebugInfo) {
						console.log(`Card at index ${cardIndex} doesn't match expected content. Expected: "${normalizedCard}", Found: "${itemNormalized}"`);
					}
					continue;
				}

				// Update the checkbox state for this card
				const targetCheckboxState = this.getCheckboxStateForColumn(newColumn);
				const updatedCardText = this.updateCheckboxStateInCardText(foundCard.text, targetCheckboxState);

				if (this.settings.showDebugInfo) {
					console.log(`Target checkbox state: "${targetCheckboxState}"`);
					console.log(`Original card: ${foundCard.text}`);
					console.log(`Updated card: ${updatedCardText}`);
				}

				// Use position-based replacement to update only this specific card
				if (updatedCardText !== foundCard.text) {
					// Use the specific card index to find the exact position in the content
					const cardPosition = this.findCardPositionByIndex(lines, newColumn, cardIndex);
					if (cardPosition !== -1) {
						// Replace only the specific card at the found position
						const cardLines = foundCard.text.split('\n');
						const updatedCardLines = updatedCardText.split('\n');
						
						// Replace the card lines at the specific position
						lines.splice(cardPosition, cardLines.length, ...updatedCardLines);
						changesFound++;

						if (this.settings.showDebugInfo) {
							console.log(`Successfully updated card checkbox state at position ${cardPosition} (index ${cardIndex}) from "${oldColumn}" to "${newColumn}": ${targetCheckboxState}`);
						}
					} else {
						if (this.settings.showDebugInfo) {
							console.log(`Could not find position for card at index ${cardIndex} in column "${newColumn}"`);
						}
					}
				} else {
					if (this.settings.showDebugInfo) {
						console.log(`No changes needed for card (already has correct checkbox state)`);
					}
				}
			}

			if (this.settings.showDebugInfo) {
				console.log(`Card checkbox update complete. Changes found: ${changesFound} out of ${actualCardMovements.length} movements`);
			}

			return lines.join('\n');

		} catch (error) {
			this.handleError(error as Error, "updateCardCheckboxStatesInKanban", false);
			return newContent; // Return original content if there's an error
		}
	}

	/**
	 * Parse Kanban board content into structure (simplified implementation)
	 */
	private async parseKanbanBoardContent(
		content: string, 
		file: TFile
	): Promise<Record<string, { items: Array<{ text: string }> }>> {
		const kanban: Record<string, { items: Array<{ text: string }> }> = {};

		try {
			if (this.settings.showDebugInfo) {
				console.log(`Parsing Kanban content for: ${file.path}`);
			}

			// Split content into lines
			const lines = content.split('\n');
			let currentColumn = '';

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];

				// Check for column header (## Column Name)
				if (line.startsWith('## ')) {
					currentColumn = line.substring(3).trim();
					if (!kanban[currentColumn]) {
						kanban[currentColumn] = { items: [] };
					}
					if (this.settings.showDebugInfo) {
						console.log(`Found column: ${currentColumn}`);
					}
					continue;
				}

				// Check for list item (starts with "- ")
				if (currentColumn && line.trim().startsWith('- ')) {
					// Get complete card content including sub-items
					let cardText = line;
					let j = i + 1;
					
					// Include indented sub-items
					while (j < lines.length && (lines[j].startsWith('  ') || lines[j].startsWith('\t') || lines[j].trim() === '')) {
						cardText += '\n' + lines[j];
						j++;
					}
					
					kanban[currentColumn].items.push({ text: cardText });
					
					if (this.settings.showDebugInfo) {
						console.log(`Found card in ${currentColumn}: ${cardText.substring(0, 50)}...`);
					}
					
					// Skip the lines we already processed
					i = j - 1;
				}
			}

			if (this.settings.showDebugInfo) {
				console.log(`Parsed ${Object.keys(kanban).length} columns:`, Object.keys(kanban));
				Object.entries(kanban).forEach(([col, data]) => {
					console.log(`  ${col}: ${data.items.length} items`);
					data.items.forEach((item, index) => {
						console.log(`    ${index}: ${item.text.substring(0, 50)}...`);
					});
				});
			}

		} catch (error) {
			console.error('Error parsing Kanban content:', error);
			if (this.settings.showDebugInfo) {
				console.error('Error details:', error);
			}
		}

		return kanban;
	}

	/**
	 * Find which column a card is in within a Kanban structure
	 */
	private findCardInKanban(
		cardText: string, 
		kanban: Record<string, { items: Array<{ text: string }> }>
	): string | null {
		const trimmedCardText = cardText.trim();
		
		for (const [columnName, columnData] of Object.entries(kanban)) {
			for (const item of columnData.items) {
				const trimmedItemText = item.text.trim();
				if (trimmedItemText === trimmedCardText) {
					if (this.settings.showDebugInfo) {
						console.log(`Found exact match for card "${trimmedCardText.substring(0, 30)}..." in column "${columnName}"`);
					}
					return columnName;
				}
			}
		}
		
		// Try fuzzy matching if exact match fails
		for (const [columnName, columnData] of Object.entries(kanban)) {
			for (const item of columnData.items) {
				const trimmedItemText = item.text.trim();
				// Check if the core content matches (ignoring potential whitespace differences)
				if (this.areCardsEquivalent(trimmedCardText, trimmedItemText)) {
					if (this.settings.showDebugInfo) {
						console.log(`Found fuzzy match for card "${trimmedCardText.substring(0, 30)}..." in column "${columnName}"`);
					}
					return columnName;
				}
			}
		}
		
		if (this.settings.showDebugInfo) {
			console.log(`No match found for card "${trimmedCardText.substring(0, 30)}..." in any column`);
		}
		return null;
	}

	/**
	 * Check if two cards are equivalent (accounting for minor formatting differences)
	 */
	private areCardsEquivalent(card1: string, card2: string): boolean {
		// Extract the main link content from both cards
		const link1 = this.extractMainLinkFromCard(card1);
		const link2 = this.extractMainLinkFromCard(card2);
		
		return !!(link1 && link2 && link1 === link2);
	}

	/**
	 * Extract the main link content from a card
	 */
	private extractMainLinkFromCard(cardText: string): string | null {
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



	/**
	 * Extract Obsidian-style links from content (reused logic)
	 */
	private extractObsidianLinks(content: string): Array<{path: string, alias?: string}> {
		const links: Array<{path: string, alias?: string}> = [];
		const linkPattern = /\[\[(.*?)\]\]/g;
		let match;

		while ((match = linkPattern.exec(content)) !== null) {
			const [_, linkContent] = match;
			const [path, alias] = linkContent.split("|").map(s => s.trim());
			links.push({ path, alias });
		}

		return links;
	}

	/**
	 * Extract Markdown-style links from content (reused logic)
	 */
	private extractMarkdownLinks(content: string): Array<{text: string, url: string}> {
		const links: Array<{text: string, url: string}> = [];
		const linkPattern = /\[(.*?)\]\((.*?)\)/g;
		let match;

		while ((match = linkPattern.exec(content)) !== null) {
			const [_, text, url] = match;
			links.push({ text: text.trim(), url: url.trim() });
		}

		return links;
	}



	/**
	 * Get checkbox state for a specific kanban column (reused logic)
	 */
	private getCheckboxStateForColumn(columnName: string): string {
		if (!this.settings.enableCustomCheckboxStates) {
			return "[ ]"; // Default unchecked state
		}

		const mapping = this.settings.kanbanColumnCheckboxMappings.find(
			m => m.columnName.toLowerCase() === columnName.toLowerCase()
		);

		return mapping ? mapping.checkboxState : "[ ]";
	}

	/**
	 * Find the exact position of a card within content lines under a specific column
	 */
	private findCardPositionInContent(cardText: string, lines: string[], targetColumn: string): number {
		let currentColumn = '';
		let inTargetColumn = false;
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			
			// Check for column header
			if (line.startsWith('## ')) {
				currentColumn = line.substring(3).trim();
				inTargetColumn = currentColumn.toLowerCase() === targetColumn.toLowerCase();
				continue;
			}
			
			// Only check for cards when we're in the target column
			if (inTargetColumn && line.trim().startsWith('- ')) {
				// Get complete card content including sub-items
				let completeCardText = line;
				let j = i + 1;
				
				// Include indented sub-items
				while (j < lines.length && (lines[j].startsWith('  ') || lines[j].startsWith('\t') || lines[j].trim() === '')) {
					completeCardText += '\n' + lines[j];
					j++;
				}
				
				// Check if this matches our target card
				if (completeCardText.trim() === cardText.trim()) {
					if (this.settings.showDebugInfo) {
						console.log(`Found card at position ${i} in column "${targetColumn}"`);
					}
					return i;
				}
				
				// Skip the lines we already processed
				i = j - 1;
			}
		}
		
		if (this.settings.showDebugInfo) {
			console.log(`Card not found in column "${targetColumn}"`);
		}
		return -1;
	}

	/**
	 * Find the exact position of a card by its index within a specific column
	 * This is more precise than content matching for avoiding duplicates
	 */
	private findCardPositionByIndex(lines: string[], targetColumn: string, cardIndex: number): number {
		let currentColumn = '';
		let inTargetColumn = false;
		let cardCount = 0;
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			
			// Check for column header
			if (line.startsWith('## ')) {
				currentColumn = line.substring(3).trim();
				inTargetColumn = currentColumn.toLowerCase() === targetColumn.toLowerCase();
				cardCount = 0; // Reset card count for new column
				continue;
			}
			
			// Only check for cards when we're in the target column
			if (inTargetColumn && line.trim().startsWith('- ')) {
				// Check if this is the card we're looking for
				if (cardCount === cardIndex) {
					if (this.settings.showDebugInfo) {
						console.log(`Found card at position ${i} (index ${cardIndex}) in column "${targetColumn}"`);
					}
					return i;
				}
				
				cardCount++;
				
				// Skip sub-items to avoid counting them as separate cards
				let j = i + 1;
				while (j < lines.length && (lines[j].startsWith('  ') || lines[j].startsWith('\t') || lines[j].trim() === '')) {
					j++;
				}
				i = j - 1;
			}
		}
		
		if (this.settings.showDebugInfo) {
			console.log(`Card at index ${cardIndex} not found in column "${targetColumn}" (found ${cardCount} cards total)`);
		}
		return -1;
	}

	/**
	 * Update checkbox state in a single card text
	 * Only updates the main card checkbox, preserving sub-items and nested checkboxes
	 */
	private updateCheckboxStateInCardText(cardText: string, targetCheckboxState: string): string {
		// Split content into lines to process only the first line (main card)
		const lines = cardText.split('\n');
		if (lines.length === 0) return cardText;

		// Pattern to match various checkbox states: - [ ], - [x], - [/], - [>], etc.
		// Remove global flag to only match once per line
		const checkboxPattern = /^(\s*[-*] )\[[^\]]*\](.*)$/;
		
		// Only update the first line if it matches the pattern (main card line)
		if (checkboxPattern.test(lines[0])) {
			lines[0] = lines[0].replace(checkboxPattern, (match, prefix, suffix) => {
				return `${prefix}${targetCheckboxState}${suffix}`;
			});
		}

		// Join lines back together, preserving sub-items unchanged
		return lines.join('\n');
	}

	/**
	 * Count tasks with different checkbox states
	 */
	private countTasksByCheckboxState(content: string): { [state: string]: number } {
		const taskCounts: { [state: string]: number } = {};
		const lines = content.split('\n');
		
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
	 * NEW: Detect if a change is caused by Kanban plugin normalization
	 * Returns true if this appears to be a normalization rather than user-intended change
	 */
	private async detectKanbanNormalization(
		kanbanFile: TFile, 
		oldContent: string, 
		newContent: string,
		knownMovements: Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}> = []
	): Promise<boolean> {
		try {
			const filePath = kanbanFile.path;
			const now = Date.now();

			// Initialize detector state if not exists
			if (!this.kanbanNormalizationDetector.has(filePath)) {
				this.kanbanNormalizationDetector.set(filePath, {
					preChangeCheckpoints: new Map(),
					lastKanbanUIInteraction: 0,
					pendingNormalizationCheck: null
				});
			}

			const detector = this.kanbanNormalizationDetector.get(filePath)!;

			// Analyze the pattern of changes first
			const normalizationPatterns = this.analyzeCheckboxNormalizationPatterns(oldContent, newContent);

					// Enhanced detection logic - focus on content patterns rather than timing
		const hasUnwantedNormalization = this.detectUnwantedKanbanNormalization(oldContent, newContent, knownMovements);

			// Update interaction timestamp for future detections
			detector.lastKanbanUIInteraction = now;

			if (this.settings.showDebugInfo) {
				console.log(`Kanban normalization analysis for ${filePath}:`, {
					normalizationPatterns,
					hasUnwantedNormalization,
					contentLengthSame: oldContent.length === newContent.length
				});
			}

			// Return true if this looks like unwanted Kanban normalization
			return hasUnwantedNormalization || normalizationPatterns.hasNormalization;

		} catch (error) {
			console.error("Error detecting Kanban normalization:", error);
			return false;
		}
	}

	/**
	 * NEW: Detect unwanted Kanban normalization based on content patterns
	 */
	private detectUnwantedKanbanNormalization(
		oldContent: string, 
		newContent: string,
		knownMovements: Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}> = []
	): boolean {
		// Check if this is a case where custom states are being converted to [x] inappropriately
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');
		
		// Look for patterns where custom states in non-completed columns get converted to [x]
		for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
			const oldLine = oldLines[i];
			const newLine = newLines[i];
			
			// Find what column this line is in
			let currentColumn = '';
			for (let j = i; j >= 0; j--) {
				if (oldLines[j].startsWith('## ')) {
					currentColumn = oldLines[j].substring(3).trim();
					break;
				}
			}
			
			// Check for unwanted normalization
			const oldMatch = oldLine.match(/^(\s*- )\[([^\]]*)\]/);
			const newMatch = newLine.match(/^(\s*- )\[([^\]]*)\]/);
			
			if (oldMatch && newMatch && currentColumn) {
				const oldState = oldMatch[2];
				const newState = newMatch[2];
				
				// Get expected state for this column
				const expectedState = this.getCheckboxStateForColumn(currentColumn);
				const expectedStateChar = expectedState.replace(/[\[\]]/g, '');
				
				// Check if this change is part of a legitimate movement
				const isLegitimateMovement = knownMovements.some(movement => 
					movement.newColumn.toLowerCase() === currentColumn.toLowerCase()
				);

				// Detect unwanted conversion: custom state → [x] when it should be something else
				// BUT only if it's not part of a legitimate movement
				if (oldState === expectedStateChar && // old state was correct for column
					newState === 'x' && // new state is [x] 
					expectedStateChar !== 'x' && // but column shouldn't be [x]
					!isLegitimateMovement) { // and it's not a legitimate movement
					
					if (this.settings.showDebugInfo) {
						console.log(`Detected unwanted normalization in column "${currentColumn}": [${oldState}] → [${newState}] (expected: ${expectedState})`);
					}
					return true;
				}
			}
		}
		
		return false;
	}

	/**
	 * NEW: Analyze checkbox normalization patterns
	 */
	private analyzeCheckboxNormalizationPatterns(oldContent: string, newContent: string): {
		hasNormalization: boolean;
		normalizedStates: Array<{line: number, from: string, to: string}>;
	} {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');
		const normalizedStates: Array<{line: number, from: string, to: string}> = [];

		for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
			const oldLine = oldLines[i];
			const newLine = newLines[i];

			// Check if this line had a custom checkbox state that got normalized
			const oldCheckboxMatch = oldLine.match(/^(\s*- )\[([^\]]*)\]/);
			const newCheckboxMatch = newLine.match(/^(\s*- )\[([^\]]*)\]/);

			if (oldCheckboxMatch && newCheckboxMatch) {
				const oldState = oldCheckboxMatch[2];
				const newState = newCheckboxMatch[2];

				// Detect normalization: custom state → standard state
				if (oldState !== newState && 
					oldState !== ' ' && oldState !== 'x' && // old was custom
					(newState === 'x' || newState === ' ')) { // new is standard
					normalizedStates.push({
						line: i,
						from: `[${oldState}]`,
						to: `[${newState}]`
					});
				}
			}
		}

		return {
			hasNormalization: normalizedStates.length > 0,
			normalizedStates
		};
	}

	/**
	 * NEW: Protect custom checkbox states from unwanted normalization
	 * Restores custom states while preserving legitimate changes
	 */
	private async protectCustomCheckboxStates(
		kanbanFile: TFile, 
		oldContent: string, 
		newContent: string
	): Promise<void> {
		try {
			const filePath = kanbanFile.path;
			
			// Analyze what was normalized
			const analysis = this.analyzeCheckboxNormalizationPatterns(oldContent, newContent);
			
			if (!analysis.hasNormalization) {
				if (this.settings.showDebugInfo) {
					console.log('No normalization detected, no protection needed');
				}
				return;
			}

			// Create protected content by restoring custom states
			const protectedContent = this.restoreCustomCheckboxStates(
				oldContent, 
				newContent, 
				analysis.normalizedStates,
				kanbanFile
			);

			if (protectedContent !== newContent) {
				if (this.settings.showDebugInfo) {
					console.log(`Protecting ${analysis.normalizedStates.length} custom checkbox states from normalization`);
					analysis.normalizedStates.forEach(state => {
						console.log(`  Line ${state.line}: ${state.from} → ${state.to} (restoring ${state.from})`);
					});
				}

				// Set flag to prevent infinite loops
				this.isUpdatingFromKanban = true;
				
				// Apply protection
				await this.app.vault.modify(kanbanFile, protectedContent);
				
				// Update stored content
				this.lastKanbanContent.set(filePath, protectedContent);

				// Reset flag after delay
				setTimeout(() => {
					this.isUpdatingFromKanban = false;
				}, 300);

				if (this.settings.showDebugInfo) {
					console.log(`Successfully protected custom checkbox states in: ${kanbanFile.basename}`);
				}
			}

		} catch (error) {
			console.error("Error protecting custom checkbox states:", error);
			if (this.settings.showDebugInfo) {
				console.error("Protection error details:", error);
			}
		}
	}

	/**
	 * NEW: Selective protection that only protects non-moved cards from unwanted normalization
	 * Allows legitimate checkbox state changes for moved cards while protecting others
	 */
	private async protectCustomCheckboxStatesSelective(
		kanbanFile: TFile, 
		oldContent: string, 
		newContent: string,
		knownMovements: Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}>
	): Promise<string> {
		try {
			// Analyze what was normalized
			const analysis = this.analyzeCheckboxNormalizationPatterns(oldContent, newContent);
			
			if (!analysis.hasNormalization) {
				if (this.settings.showDebugInfo) {
					console.log('No normalization detected, no selective protection needed');
				}
				return newContent;
			}

			// Filter out normalizations that correspond to legitimate movements
			const legitimateNormalizations = this.filterLegitimateNormalizations(
				analysis.normalizedStates, 
				knownMovements, 
				newContent, 
				kanbanFile
			);

			// Only protect states that are NOT part of legitimate movements
			const statesNeedingProtection = analysis.normalizedStates.filter((state: {line: number, from: string, to: string}) => 
				!legitimateNormalizations.includes(state)
			);

			if (statesNeedingProtection.length === 0) {
				if (this.settings.showDebugInfo) {
					console.log('All normalizations are legitimate movements, no protection needed');
				}
				return newContent;
			}

			// Create protected content by restoring only non-legitimate changes
			const protectedContent = this.restoreCustomCheckboxStates(
				oldContent, 
				newContent, 
				statesNeedingProtection,
				kanbanFile
			);

			if (this.settings.showDebugInfo) {
				console.log(`Selectively protecting ${statesNeedingProtection.length} out of ${analysis.normalizedStates.length} normalized states`);
				console.log(`Allowing ${legitimateNormalizations.length} legitimate state changes from card movements`);
				statesNeedingProtection.forEach((state: {line: number, from: string, to: string}) => {
					console.log(`  Protecting line ${state.line}: ${state.from} → ${state.to} (restoring ${state.from})`);
				});
				legitimateNormalizations.forEach((state: {line: number, from: string, to: string}) => {
					console.log(`  Allowing line ${state.line}: ${state.from} → ${state.to} (legitimate movement)`);
				});
			}

			return protectedContent;

		} catch (error) {
			console.error("Error in selective protection:", error);
			if (this.settings.showDebugInfo) {
				console.error("Selective protection error details:", error);
			}
			return newContent; // Return original content if there's an error
		}
	}

	/**
	 * NEW: Restore custom checkbox states while preserving other changes
	 */
	private restoreCustomCheckboxStates(
		oldContent: string, 
		newContent: string, 
		normalizedStates: Array<{line: number, from: string, to: string}>,
		kanbanFile: TFile
	): string {
		const lines = newContent.split('\n');
		let restoredCount = 0;

		for (const normalizedState of normalizedStates) {
			const lineIndex = normalizedState.line;
			
			if (lineIndex < lines.length) {
				const line = lines[lineIndex];
				
				// Only restore if the column mapping supports this custom state
				const columnName = this.findLineColumn(line, lines, lineIndex);
				if (columnName) {
					const expectedState = this.getCheckboxStateForColumn(columnName);
					
					// If the old state matches what we expect for this column, restore it
					if (normalizedState.from === expectedState) {
						lines[lineIndex] = line.replace(
							normalizedState.to, 
							normalizedState.from
						);
						restoredCount++;
						
						if (this.settings.showDebugInfo) {
							console.log(`Restored line ${lineIndex}: ${normalizedState.to} → ${normalizedState.from} for column "${columnName}"`);
						}
					}
				}
			}
		}

		if (this.settings.showDebugInfo) {
			console.log(`Restored ${restoredCount} out of ${normalizedStates.length} normalized states`);
		}

		return lines.join('\n');
	}

	/**
	 * NEW: Filter out normalizations that correspond to legitimate card movements
	 */
	private filterLegitimateNormalizations(
		normalizedStates: Array<{line: number, from: string, to: string}>,
		knownMovements: Array<{card: string, oldColumn: string, newColumn: string, cardIndex: number}>,
		newContent: string,
		kanbanFile: TFile
	): Array<{line: number, from: string, to: string}> {
		const legitimateNormalizations: Array<{line: number, from: string, to: string}> = [];
		const lines = newContent.split('\n');

		for (const normalizedState of normalizedStates) {
			const lineIndex = normalizedState.line;
			
			if (lineIndex < lines.length) {
				const line = lines[lineIndex];
				
				// Find which column this line is in
				const columnName = this.findLineColumn(line, lines, lineIndex);
				if (columnName) {
					// Check if there's a known movement to this column
					const hasMovementToColumn = knownMovements.some(movement => 
						movement.newColumn.toLowerCase() === columnName.toLowerCase()
					);
					
					if (hasMovementToColumn) {
						// Get expected state for this column
						const expectedState = this.getCheckboxStateForColumn(columnName);
						
						// If the normalization results in the expected state for this column, it's legitimate
						if (normalizedState.to === expectedState) {
							legitimateNormalizations.push(normalizedState);
							
							if (this.settings.showDebugInfo) {
								console.log(`Legitimate normalization at line ${lineIndex}: ${normalizedState.from} → ${normalizedState.to} for column "${columnName}"`);
							}
						}
					}
				}
			}
		}

		return legitimateNormalizations;
	}

	/**
	 * NEW: Check if card movements would cause unwanted normalization
	 */
	private checkMovementsForUnwantedNormalization(
		cardMovements: Array<{card: string, oldColumn: string, newColumn: string}>,
		newContent: string,
		kanbanFile: TFile
	): boolean {
		for (const movement of cardMovements) {
			const { newColumn } = movement;
			
			// Get expected checkbox state for target column
			const expectedState = this.getCheckboxStateForColumn(newColumn);
			const expectedStateChar = expectedState.replace(/[\[\]]/g, '');
			
			// Check if the current content already has cards with correct states for this column
			const lines = newContent.split('\n');
			let inTargetColumn = false;
			let currentColumn = '';
			
			for (const line of lines) {
				if (line.startsWith('## ')) {
					currentColumn = line.substring(3).trim();
					inTargetColumn = currentColumn === newColumn;
					continue;
				}
				
				if (inTargetColumn && line.trim().startsWith('- [')) {
					const match = line.match(/^(\s*- )\[([^\]]*)\]/);
					if (match) {
						const currentState = match[2];
						
						// If we find cards in target column that already have the expected state,
						// and they would be changed to [x], this is unwanted normalization
						if (currentState === expectedStateChar && expectedStateChar !== 'x') {
							if (this.settings.showDebugInfo) {
								console.log(`Movement to column "${newColumn}" would cause unwanted normalization: [${currentState}] → [x] (expected: ${expectedState})`);
							}
							return true;
						}
					}
				}
			}
		}
		
		return false;
	}

	/**
	 * NEW: Find which column a line belongs to
	 */
	private findLineColumn(line: string, allLines: string[], lineIndex: number): string | null {
		// Search backwards from current line to find the column header
		for (let i = lineIndex; i >= 0; i--) {
			const currentLine = allLines[i];
			if (currentLine.startsWith('## ')) {
				return currentLine.substring(3).trim();
			}
		}
		return null;
	}

	/**
	 * NEW: Detect immediate Kanban normalization (real-time detection)
	 * Enhanced to detect multiple-line normalization patterns
	 */
	private detectImmediateKanbanNormalization(oldContent: string, newContent: string): boolean {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');
		let normalizationCount = 0;
		let customToXConversions = 0;
		
		// Look for lines where custom checkbox states were converted to [x]
		for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
			const oldLine = oldLines[i];
			const newLine = newLines[i];
			
			const oldMatch = oldLine.match(/^(\s*- )\[([^\]]*)\]/);
			const newMatch = newLine.match(/^(\s*- )\[([^\]]*)\]/);
			
			if (oldMatch && newMatch) {
				const oldState = oldMatch[2];
				const newState = newMatch[2];
				
				// Count any checkbox state changes
				if (oldState !== newState) {
					normalizationCount++;
					
					// Specifically track custom state → [x] conversions
					if (oldState !== ' ' && oldState !== 'x' && newState === 'x') {
						customToXConversions++;
						
						if (this.settings.showDebugInfo) {
							console.log(`Immediate normalization detected: [${oldState}] → [${newState}] on line ${i}`);
						}
					}
				}
			}
		}
		
		// Enhanced detection criteria:
		// 1. Multiple custom states converted to [x] (strong indicator of Kanban normalization)
		// 2. High ratio of custom→[x] conversions vs total changes
		const hasMultipleCustomToX = customToXConversions >= 2;
		const hasHighCustomToXRatio = normalizationCount > 0 && (customToXConversions / normalizationCount) >= 0.5;
		
		if (this.settings.showDebugInfo) {
			console.log(`Enhanced normalization detection: ${customToXConversions} custom→[x] out of ${normalizationCount} total changes`);
			console.log(`hasMultipleCustomToX: ${hasMultipleCustomToX}, hasHighCustomToXRatio: ${hasHighCustomToXRatio}`);
		}
		
		return hasMultipleCustomToX || hasHighCustomToXRatio;
	}

	/**
	 * NEW: Revert Kanban normalization by restoring custom states
	 * Enhanced to handle multiple normalizations and better column detection
	 */
	private revertKanbanNormalization(oldContent: string, newContent: string, kanbanFile: TFile): string {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');
		const revertedLines = [...newLines];
		let revertCount = 0;
		let totalNormalizations = 0;
		
		// Find and revert unwanted normalizations
		for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
			const oldLine = oldLines[i];
			const newLine = newLines[i];
			
			const oldMatch = oldLine.match(/^(\s*- )\[([^\]]*)\]/);
			const newMatch = newLine.match(/^(\s*- )\[([^\]]*)\]/);
			
			if (oldMatch && newMatch) {
				const oldState = oldMatch[2];
				const newState = newMatch[2];
				
				// Check if this is any normalization (not just custom → [x])
				if (oldState !== newState) {
					totalNormalizations++;
					
					// Find which column this line is in
					let currentColumn = '';
					for (let j = i; j >= 0; j--) {
						if (newLines[j].startsWith('## ')) { // Use newLines to get current column structure
							currentColumn = newLines[j].substring(3).trim();
							break;
						}
					}
					
					if (currentColumn) {
						// Get expected state for this column
						const expectedState = this.getCheckboxStateForColumn(currentColumn);
						const expectedStateChar = expectedState.replace(/[\[\]]/g, '');
						
						// Revert if:
						// 1. Old state was correct for this column AND
						// 2. New state is wrong for this column
						if (oldState === expectedStateChar && newState !== expectedStateChar) {
							// CRITICAL FIX: Only change the checkbox state, preserve the card content
							const newPrefix = newMatch[1]; // "- " part
							const newSuffix = newLine.substring(newMatch[0].length); // Everything after checkbox
							revertedLines[i] = `${newPrefix}[${oldState}]${newSuffix}`;
							revertCount++;
							
							if (this.settings.showDebugInfo) {
								console.log(`Reverted line ${i} in column "${currentColumn}": [${newState}] → [${oldState}] (preserving content)`);
							}
						} else if (this.settings.showDebugInfo) {
							console.log(`Line ${i} in column "${currentColumn}": [${oldState}] → [${newState}] (not reverting - expected: [${expectedStateChar}])`);
						}
					}
				}
			}
		}
		
		if (this.settings.showDebugInfo) {
			console.log(`Reverted ${revertCount} out of ${totalNormalizations} normalizations`);
		}
		
		return revertedLines.join('\n');
	}

	/**
	 * Proactively sync all checkbox states in Kanban board to match column mappings
	 * This ensures all cards have the correct checkbox state for their column
	 */
	private async syncAllCheckboxStatesToMappings(kanbanFile: TFile, content: string): Promise<string> {
		try {
			if (this.settings.showDebugInfo) {
				console.log(`Syncing all checkbox states to mappings for: ${kanbanFile.path}`);
			}

			// Parse Kanban board structure
			const kanban = await this.parseKanbanBoardContent(content, kanbanFile);
			if (!kanban || Object.keys(kanban).length === 0) {
				if (this.settings.showDebugInfo) {
					console.log(`Could not parse Kanban board structure, returning original content`);
				}
				return content;
			}

			// Split content into lines for position-based replacement
			const lines = content.split('\n');
			let totalChanges = 0;

			// Process each column and sync all cards to have correct checkbox states
			for (const [columnName, columnData] of Object.entries(kanban)) {
				const targetCheckboxState = this.getCheckboxStateForColumn(columnName);

				if (this.settings.showDebugInfo) {
					console.log(`Syncing column "${columnName}" to checkbox state "${targetCheckboxState}" (${columnData.items.length} cards)`);
				}

				// Update each card in this column using position-based replacement
				for (const item of columnData.items) {
					// Check if the card already has the correct checkbox state
					const currentCheckboxMatch = item.text.match(/^(\s*- )\[([^\]]*)\]/);
					const currentCheckboxState = currentCheckboxMatch ? `[${currentCheckboxMatch[2]}]` : null;
					
					// Only update if the current state is different from target state
					if (currentCheckboxState !== targetCheckboxState) {
						const updatedCardText = this.updateCheckboxStateInCardText(item.text, targetCheckboxState);
						
						if (updatedCardText !== item.text) {
							const cardPosition = this.findCardPositionInContent(item.text, lines, columnName);
							if (cardPosition !== -1) {
								// Replace only the specific card at the found position
								const cardLines = item.text.split('\n');
								const updatedCardLines = updatedCardText.split('\n');
								
								// Replace the card lines at the specific position
								lines.splice(cardPosition, cardLines.length, ...updatedCardLines);
								totalChanges++;

								if (this.settings.showDebugInfo) {
									console.log(`  Synced card at position ${cardPosition}: ${item.text.substring(0, 30)}... → ${targetCheckboxState} (was ${currentCheckboxState})`);
								}
							}
						}
					} else {
						if (this.settings.showDebugInfo) {
							console.log(`  Skipping card (already has correct state ${targetCheckboxState}): ${item.text.substring(0, 30)}...`);
						}
					}
				}
			}

			if (this.settings.showDebugInfo) {
				console.log(`Sync complete: ${totalChanges} cards updated to match column mappings`);
			}

			return lines.join('\n');

		} catch (error) {
			console.error("Error syncing checkbox states to mappings:", error);
			if (this.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			return content; // Return original content if there's an error
		}
	}

	/**
	 * Auto-sync all checkbox states in a Kanban board to match column mappings
	 * Runs once per file per session for performance optimization
	 * Uses position-based replacement to avoid conflicts
	 */
	private async autoSyncKanbanCheckboxStates(kanbanFile: TFile): Promise<void> {
		try {
			// Check if we're already updating to prevent conflicts
			if (this.isUpdatingFromKanban) {
				if (this.settings.showDebugInfo) {
					console.log(`Auto-sync skipped - update already in progress for: ${kanbanFile.path}`);
				}
				return;
			}

			if (this.settings.showDebugInfo) {
				console.log(`Starting auto-sync for Kanban board: ${kanbanFile.path}`);
			}

			// Set flag to prevent conflicts
			this.isUpdatingFromKanban = true;

			// Mark this file as auto-synced to prevent repeat runs
			this.autoSyncedFiles.add(kanbanFile.path);

			// Update timestamp to track when auto-sync ran
			this.lastFileUpdateMap.set(kanbanFile.path, Date.now());

			// Store initial content for comparison
			const initialContent = await this.app.vault.read(kanbanFile);
			this.lastKanbanContent.set(kanbanFile.path, initialContent);

			// Read current file content
			const content = await this.app.vault.read(kanbanFile);

			// Parse Kanban board structure
			const kanban = await this.parseKanbanBoardContent(content, kanbanFile);

			// Split content into lines for position-based replacement
			const lines = content.split('\n');
			let totalChanges = 0;

			// Process each column and update all cards to have correct checkbox states
			for (const [columnName, columnData] of Object.entries(kanban)) {
				const targetCheckboxState = this.getCheckboxStateForColumn(columnName);

				if (this.settings.showDebugInfo) {
					console.log(`Auto-syncing column "${columnName}" to checkbox state "${targetCheckboxState}" (${columnData.items.length} cards)`);
				}

				// Update each card in this column using position-based replacement
				for (const item of columnData.items) {
					// Check if the card already has the correct checkbox state
					const currentCheckboxMatch = item.text.match(/^(\s*- )\[([^\]]*)\]/);
					const currentCheckboxState = currentCheckboxMatch ? `[${currentCheckboxMatch[2]}]` : null;
					
					// Only update if the current state is different from target state
					if (currentCheckboxState !== targetCheckboxState) {
						const updatedCardText = this.updateCheckboxStateInCardText(item.text, targetCheckboxState);
						
						if (updatedCardText !== item.text) {
							const cardPosition = this.findCardPositionInContent(item.text, lines, columnName);
							if (cardPosition !== -1) {
								// Replace only the specific card at the found position
								const cardLines = item.text.split('\n');
								const updatedCardLines = updatedCardText.split('\n');
								
								// Replace the card lines at the specific position
								lines.splice(cardPosition, cardLines.length, ...updatedCardLines);
								totalChanges++;

								if (this.settings.showDebugInfo) {
									console.log(`  Updated card at position ${cardPosition}: ${item.text.substring(0, 30)}... → ${targetCheckboxState} (was ${currentCheckboxState})`);
								}
							}
						}
					} else {
						if (this.settings.showDebugInfo) {
							console.log(`  Skipping card (already has correct state ${targetCheckboxState}): ${item.text.substring(0, 30)}...`);
						}
					}
				}
			}

			// Update the file if changes were made
			if (totalChanges > 0) {
				const updatedContent = lines.join('\n');
				await this.app.vault.modify(kanbanFile, updatedContent);

				// CRITICAL: Update lastKanbanContent to prevent conflicts with card movement detection
				this.lastKanbanContent.set(kanbanFile.path, updatedContent);

				if (this.settings.showDebugInfo) {
					console.log(`Auto-sync complete: ${totalChanges} cards updated in ${kanbanFile.basename}`);
					console.log(`Updated lastKanbanContent for ${kanbanFile.path} to prevent conflicts`);
				}

				// Show notification to user
				new Notice(`Auto-synced ${totalChanges} card checkbox states in ${kanbanFile.basename}`);
			} else {
				if (this.settings.showDebugInfo) {
					console.log(`Auto-sync complete: No changes needed for ${kanbanFile.basename}`);
				}
			}

		} catch (error) {
			console.error("Error in auto-sync Kanban checkbox states:", error);
			if (this.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			// Remove from auto-synced set so it can be retried
			this.autoSyncedFiles.delete(kanbanFile.path);
		} finally {
			// Always reset flag after operation completes
			setTimeout(() => {
				this.isUpdatingFromKanban = false;
				if (this.settings.showDebugInfo) {
					console.log(`Auto-sync flag reset for: ${kanbanFile.path}`);
				}
			}, 200); // Slightly longer delay to ensure all operations complete
		}
	}

	/**
	 * Force refresh Kanban UI after modifying file content
	 * Tries multiple approaches to ensure UI reflects the updated checkbox states
	 */
	private async forceRefreshKanbanUI(kanbanFile: TFile): Promise<void> {
		try {
			if (this.settings.showDebugInfo) {
				console.log(`Attempting to force refresh Kanban UI for: ${kanbanFile.path}`);
			}

			// Method 1: Skip MetadataCache trigger to avoid conflicts
			// this.app.metadataCache.trigger("changed", kanbanFile); // Can cause errors

			// Method 2: If this is the currently active file, try to refresh the view
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.path === kanbanFile.path) {
				// Try to refresh the active view
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					// Force re-render by triggering a view update
					setTimeout(() => {
						activeView.requestSave();
					}, 100);
				}
			}

			// Method 3: Trigger workspace layout change to force refresh
			setTimeout(() => {
				this.app.workspace.trigger("layout-change");
			}, 150);

			// Method 4: If file is open in a leaf, try to refresh that leaf
			const leaves = this.app.workspace.getLeavesOfType("markdown");
			for (const leaf of leaves) {
				const view = leaf.view as MarkdownView;
				if (view.file && view.file.path === kanbanFile.path) {
					setTimeout(() => {
						// Force view to re-read file content
						view.load();
					}, 200);
					break;
				}
			}

			if (this.settings.showDebugInfo) {
				console.log(`Force refresh attempts completed for: ${kanbanFile.path}`);
			}

		} catch (error) {
			if (this.settings.showDebugInfo) {
				console.error("Error forcing Kanban UI refresh:", error);
			}
		}
	}
}

class TaskProgressBarView extends ItemView {
	plugin: TaskProgressBarPlugin;
	currentFile: TFile | null = null;
	isVisible: boolean = false;
	lastUpdateTime: number = 0;
	lastFileUpdateMap: Map<string, number> = new Map(); // Track last update time per file
	initialLoadComplete: boolean = false; // Track if initial load is complete
	completedFilesMap: Map<string, boolean> = new Map(); // Track which files have been marked as completed

	constructor(leaf: WorkspaceLeaf, plugin: TaskProgressBarPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return "progress-tracker";
	}

	getDisplayText(): string {
		return "Task progress bar";
	}

	getIcon(): string {
		return "bar-chart-horizontal";
	}

	async onOpen() {
		this.isVisible = true;
		this.initialLoadComplete = false;

		// Add custom class to parent workspace-leaf
		const leaf = this.leaf as any;
		if (leaf && leaf.containerEl) {
			leaf.containerEl.addClass("progress-tracker-leaf");
		}

		const container = this.containerEl.children[1];
		container.empty();

		// Create progress container
		const progressContainer = container.createDiv({
			cls: "task-progress-container",
		});

		// Add loading indicator that we'll keep until the first real data loads
		progressContainer.createEl("p", {
			text: "Loading task progress...",
			cls: "loading-indicator",
		});
	}

	async updateProgressBar(
		file: TFile | null,
		content?: string,
		isInitialLoad: boolean = false
	) {
		if (!file) return;

		// Track the update time for this file
		this.lastFileUpdateMap.set(file.path, Date.now());

		// Avoid updating too quickly
		const now = Date.now();
		if (!isInitialLoad && now - this.lastUpdateTime < 100) return;
		this.lastUpdateTime = now;

		this.currentFile = file;

		const container = this.containerEl.children[1];
		const progressContainer = container.querySelector(
			".task-progress-container"
		) as HTMLElement;
		if (!progressContainer) return;

		// Clear the container once at the start if this is initial load
		// This prevents showing the loading indicator and then progress bar
		if (isInitialLoad || !this.initialLoadComplete) {
			progressContainer.empty();
			this.initialLoadComplete = true;
		}

		// Add class to show animation only when showUpdateAnimation setting is enabled
		if (this.plugin.settings.showUpdateAnimation) {
			progressContainer.classList.add("updating");
		}

		try {
			// Update immediately if content is provided
			if (content) {
				if (!this.hasTasksInContentExtended(content)) {
					// Only clear if not already showing "no tasks" message
					if (!progressContainer.querySelector(".no-tasks-message")) {
						progressContainer.empty();
						progressContainer.createEl("p", {
							text: "No tasks found in this file",
							cls: "no-tasks-message",
						});
					}
				} else {
					// Create/update progress bar with content
					this.createProgressBarFromString(
						progressContainer,
						content,
						file
					);
				}
			} else {
				// Read file content
				const fileContent = await this.plugin.app.vault.read(file);

				if (!this.hasTasksInContentExtended(fileContent)) {
					// Only clear if not already showing "no tasks" message
					if (!progressContainer.querySelector(".no-tasks-message")) {
						progressContainer.empty();
						progressContainer.createEl("p", {
							text: "No tasks found in this file",
							cls: "no-tasks-message",
						});
					}
					if (this.plugin.settings.showDebugInfo) {
						console.log("No tasks found in file:", file.path);
					}
				} else {
					// Create/update progress bar with content
					this.createProgressBarFromString(
						progressContainer,
						fileContent,
						file
					);
				}
			}
		} catch (error) {
			console.error("Error updating progress bar:", error);
			progressContainer.empty();
			progressContainer.createEl("p", {
				text: `Error updating progress bar: ${error.message}`,
			});
		} finally {
			// Remove class after update completes, only if animation is enabled
			if (this.plugin.settings.showUpdateAnimation) {
				setTimeout(() => {
					progressContainer.classList.remove("updating");
				}, this.plugin.settings.updateAnimationDelay); // Use configurable delay
			}
		}
	}

	// Helper method to quickly check if content has tasks
	hasTasksInContentExtended(content: string): boolean {
		// Extended pattern to match custom checkbox states
		const extendedTaskRegex = /- \[[^\]]*\]/i;
		return extendedTaskRegex.test(content);
	}

	// Method to create progress bar from string content
	async createProgressBarFromString(
		container: HTMLElement,
		content: string,
		file: TFile
	) {
		try {
			// Log for debugging if enabled
			if (this.plugin.settings.showDebugInfo) {
				console.log(`Creating progress bar for file: ${file.path}`);
				console.log(`Content length: ${content.length}`);
			}

			// Get Dataview API - only check for warning display
			const dvAPI = this.plugin.dvAPI;
			if (!dvAPI) {
				// Only clear and create warning if not already showing dataview warning
				if (!container.querySelector(".dataview-warning-compact")) {
					container.empty();
					const dataviewWarning = container.createDiv({
						cls: "dataview-warning-compact",
					});
					dataviewWarning.createEl("span", {
						text: "Dataview not available",
						cls: "dataview-warning-text",
					});
				}
				return;
			}

			// Count tasks with support for custom checkbox states
			let incompleteTasks = 0;
			let completedTasks = 0;
			let customStateTasks = 0;
			
			if (this.plugin.settings.enableCustomCheckboxStates) {
				// When custom checkbox states are enabled, use enhanced counting
				const taskCounts = this.countTasksByCheckboxState(content);
				
				// Count standard states
				incompleteTasks = taskCounts[' '] || 0; // [ ]
				completedTasks = taskCounts['x'] || 0; // [x]
				
				// Count all custom states as tasks in progress
				for (const [state, count] of Object.entries(taskCounts)) {
					if (state !== ' ' && state !== 'x' && state.trim() !== '') {
						customStateTasks += count;
					}
				}
				
				if (this.plugin.settings.showDebugInfo) {
					console.log('Custom checkbox state counts:', taskCounts);
					console.log(`Incomplete: ${incompleteTasks}, Completed: ${completedTasks}, Custom states: ${customStateTasks}`);
				}
			} else {
				// Legacy counting - only [ ] and [x]
				incompleteTasks = (content.match(/- \[ \]/g) || []).length;
				completedTasks = (content.match(/- \[x\]/gi) || []).length;
			}
			
			let totalTasks = incompleteTasks + completedTasks + customStateTasks;

			// Try with relaxed regex if needed (for legacy compatibility)
			let relaxedIncompleteTasks = 0;
			let relaxedCompletedTasks = 0;
			if (totalTasks === 0) {
				relaxedIncompleteTasks = (content.match(/[-*] \[ \]/g) || [])
					.length;
				relaxedCompletedTasks = (content.match(/[-*] \[x\]/gi) || [])
					.length;
				totalTasks = relaxedIncompleteTasks + relaxedCompletedTasks;
			}

			// Log task counts for debugging
			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Task counts - incomplete: ${incompleteTasks}, completed: ${completedTasks}, custom states: ${customStateTasks}, total: ${totalTasks}`
				);
				if (relaxedIncompleteTasks > 0 || relaxedCompletedTasks > 0) {
					console.log(
						`Using relaxed regex - found tasks: ${
							relaxedIncompleteTasks + relaxedCompletedTasks
						}`
					);
				}
			}

			if (totalTasks === 0) {
				// No tasks found, show message - but only if not already showing the message
				if (!container.querySelector(".no-tasks-message")) {
					container.empty();
					container.createEl("p", {
						text: "No tasks found in this file",
						cls: "no-tasks-message",
					});
				}
				return;
			}

			// Calculate percentage based on which regex found tasks
			let completedCount =
				incompleteTasks > 0 || completedTasks > 0 || customStateTasks > 0
					? completedTasks
					: relaxedCompletedTasks;

			const percentage = Math.round((completedCount / totalTasks) * 100);

			// Update UI first for better responsiveness
			this.updateProgressBarUI(container, percentage, completedCount, totalTasks);

			// Then process status and Kanban updates asynchronously
			this.processStatusAndKanbanUpdates(file, percentage, completedCount, totalTasks);

		} catch (error) {
			console.error("Error creating progress bar from string:", error);
			container.empty();
			container.createEl("p", {
				text: `Error creating progress bar: ${error.message}`,
			});
		}
	}

	/**
	 * Update UI elements first for better responsiveness, then process status and Kanban updates asynchronously
	 */
	private updateProgressBarUI(
		container: HTMLElement,
		percentage: number,
		completedCount: number,
		totalTasks: number
	) {
		// Check if we already have progress elements
		let progressLayout = container.querySelector(
			".progress-layout"
		) as HTMLElement;
		let statsContainer = container.querySelector(
			".progress-stats-compact"
		) as HTMLElement;

		// If no existing elements, create container structure
		if (!progressLayout || !statsContainer) {
			container.empty();

			// Create a more compact layout
			progressLayout = container.createDiv({
				cls: "progress-layout",
			});

			// Create percentage text element
			progressLayout.createEl("div", {
				cls: "progress-percentage-small",
			});

			// Create HTML5-like progress bar
			const progressBarContainer = progressLayout.createDiv({
				cls: "pt-progress-bar-container",
			});

			// Create the outer progress element
			const progressElement = progressBarContainer.createDiv({
				cls: "progress-element",
			});

			// Create the inner value element that will be animated
			progressElement.createDiv({
				cls: "progress-value",
			});

			// Create stats container at the bottom
			statsContainer = container.createDiv({
				cls: "progress-stats-compact",
			});
		}

		// Update percentage text
		const percentageElement = progressLayout.querySelector(
			".progress-percentage-small"
		) as HTMLElement;
		if (percentageElement) {
			percentageElement.setText(`${percentage}%`);
		}

		// Update progress bar width with smooth transition
		const progressValue = container.querySelector(
			".progress-value"
		) as HTMLElement;
		if (progressValue) {
			// Add transition style if not already present
			if (!progressValue.hasAttribute("data-has-transition")) {
				progressValue.style.transition =
					"width 0.3s ease-in-out, background-color 0.3s ease";
				progressValue.setAttribute("data-has-transition", "true");
			}
			progressValue.style.width = `${percentage}%`;
			this.applyProgressColor(progressValue, percentage);
		}

		// Update progress element data attribute
		const progressElement = container.querySelector(
			".progress-element"
		) as HTMLElement;
		if (progressElement) {
			progressElement.setAttribute(
				"data-percentage",
				percentage.toString()
			);
		}

		// Update stats text
		if (statsContainer) {
			statsContainer.empty();
			statsContainer.createSpan({
				text: `${completedCount}/${totalTasks} tasks`,
			});
		}

		// Update debug info if needed
		if (this.plugin.settings.showDebugInfo) {
			let debugInfo = container.querySelector(
				".debug-info"
			) as HTMLElement;
			if (!debugInfo) {
				debugInfo = container.createDiv({ cls: "debug-info" });
			} else {
				debugInfo.empty();
			}

			debugInfo.createEl("p", { text: `Debug info:` });
			debugInfo.createEl("p", {
				text: `File: ${this.currentFile?.path}`,
			});
			debugInfo.createEl("p", {
				text: `Incomplete tasks: ${totalTasks - completedCount}`,
			});
			debugInfo.createEl("p", {
				text: `Completed tasks: ${completedCount}`,
			});
			debugInfo.createEl("p", { text: `Total tasks: ${totalTasks}` });
			debugInfo.createEl("p", { text: `Percentage: ${percentage}%` });
			debugInfo.createEl("p", {
				text: `Update time: ${new Date().toISOString()}`,
			});
			debugInfo.createEl("p", {
				text: `Color scheme: ${this.plugin.settings.progressColorScheme}`,
			});
		} else {
			// Remove debug info if it exists but debug is disabled
			const debugInfo = container.querySelector(".debug-info");
			if (debugInfo) debugInfo.remove();
		}
	}

	/**
	 * Process status and Kanban updates asynchronously
	 */
	private async processStatusAndKanbanUpdates(
		file: TFile,
		percentage: number,
		completedCount: number,
		totalTasks: number
	) {
		// Use setTimeout to process these updates in the next tick
		setTimeout(async () => {
			try {
				// Update status based on progress percentage
				let statusChanged = false;
				if (this.plugin.settings.autoChangeStatus) {
					statusChanged = await this.updateStatusBasedOnProgress(
						file,
						percentage
					);
				}

				// Update Kanban boards based on task progress
				if (
					this.plugin.settings.autoUpdateKanban &&
					(statusChanged || !this.completedFilesMap.has(file.path))
				) {
					await this.updateKanbanBoards(file, completedCount, totalTasks);
				}

				// Additional special handling for 100% completion
				if (percentage === 100 && this.plugin.settings.autoUpdateMetadata) {
					// Only update metadata and show notification if this file hasn't been marked as completed yet
					if (!this.completedFilesMap.has(file.path)) {
						await this.updateFileMetadata(file);
						// Mark this file as completed to avoid repeated updates
						this.completedFilesMap.set(file.path, true);
					}
				} else if (percentage < 100) {
					// If percentage is less than 100%, remove from completed files map
					if (this.completedFilesMap.has(file.path)) {
						this.completedFilesMap.delete(file.path);
					}
				}

				// Auto-add to Kanban board if enabled and file has tasks
				if (
					this.plugin.settings.autoAddToKanban &&
					this.plugin.settings.autoAddKanbanBoard &&
					totalTasks > 0 &&
					!this.completedFilesMap.has(file.path)
				) {
					await this.addFileToKanbanBoard(file);
				}
			} catch (error) {
				console.error("Error in status and Kanban updates:", error);
				if (this.plugin.settings.showDebugInfo) {
					console.error("Error details:", error);
				}
			}
		}, 0);
	}

	// Method to apply color based on percentage and settings - keep logic but add smooth transition
	applyProgressColor(progressElement: HTMLElement, percentage: number) {
		const settings = this.plugin.settings;

		// If using default color scheme, let CSS handle it
		if (settings.progressColorScheme === "default") {
			// Remove any previously set inline colors
			progressElement.style.backgroundColor = "";
			return;
		}

		// Apply custom color based on percentage
		let newColor = "";
		if (percentage === 100) {
			// Complete - green
			newColor = settings.completeProgressColor;
		} else if (percentage >= settings.mediumProgressThreshold) {
			// High progress (66-99%) - blue
			newColor = settings.highProgressColor;
		} else if (percentage >= settings.lowProgressThreshold) {
			// Medium progress (34-65%) - orange/yellow
			newColor = settings.mediumProgressColor;
		} else {
			// Low progress (0-33%) - red
			newColor = settings.lowProgressColor;
		}

		// Only update if color has changed
		if (progressElement.style.backgroundColor !== newColor) {
			progressElement.style.backgroundColor = newColor;
		}

		// Add debug log if needed
		if (this.plugin.settings.showDebugInfo) {
			console.log(`Applied color for ${percentage}%: 
				Color scheme: ${settings.progressColorScheme},
				Low threshold: ${settings.lowProgressThreshold}%, 
				Medium threshold: ${settings.mediumProgressThreshold}%, 
				High threshold: ${settings.highProgressThreshold}%,
				Applied color: ${newColor}`);
		}
	}

	/**
	 * Clear the completed files cache
	 * Used to reset notifications for completed files
	 */
	clearCompletedFilesCache() {
		this.completedFilesMap.clear();
		if (this.plugin.settings.showDebugInfo) {
			console.log("Cleared completed files cache");
		}
	}

	async updateStatusBasedOnProgress(
		file: TFile,
		progressPercentage: number
	): Promise<boolean> {
		if (!file || !this.plugin.settings.autoChangeStatus) return false;

		try {
			let needsUpdate = false;

			// Determine target status based on progress percentage
			let targetStatus = this.plugin.settings.statusInProgress;
			if (progressPercentage === 0) {
				targetStatus = this.plugin.settings.statusTodo;
			} else if (progressPercentage === 100) {
				targetStatus = this.plugin.settings.statusCompleted;
			}

			// Use processFrontMatter API to update frontmatter
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					// Check current status
					const currentStatus = frontmatter["status"];

					// Update if status is different
					if (currentStatus !== targetStatus) {
						frontmatter["status"] = targetStatus;
						needsUpdate = true;
					}

					// Remove finished date if progress is less than 100%
					if (
						progressPercentage < 100 &&
						this.plugin.settings.autoUpdateFinishedDate
					) {
						if (frontmatter["finished"]) {
							delete frontmatter["finished"];
							needsUpdate = true;
						}
					}
				}
			);

			if (needsUpdate && this.plugin.settings.showDebugInfo) {
				console.log(
					`Updated status to "${targetStatus}" based on progress ${progressPercentage}% for file:`,
					file.path
				);
			}

			return needsUpdate;
		} catch (error) {
			console.error("Error updating status based on progress:", error);
			return false;
		}
	}

	// New method to update file metadata when tasks are completed
	async updateFileMetadata(file: TFile) {
		try {
			// use processFrontMatter API to update metadata
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					let needsUpdate = false;
					const today = new Date().toISOString().split("T")[0]; // Format: YYYY-MM-DD

					// update status if it enabled
					if (this.plugin.settings.autoChangeStatus) {
						const targetStatus =
							this.plugin.settings.statusCompleted;
						if (frontmatter["status"] !== targetStatus) {
							frontmatter["status"] = targetStatus;
							needsUpdate = true;

							if (this.plugin.settings.showDebugInfo) {
								console.log(
									`Updating status to ${targetStatus} in file:`,
									file.path
								);
							}
						}
					}

					// update finished date if enabled
					if (this.plugin.settings.autoUpdateFinishedDate) {
						if (frontmatter["finished"] !== today) {
							frontmatter["finished"] = today;
							needsUpdate = true;

							if (this.plugin.settings.showDebugInfo) {
								console.log(
									`Updating finished date to ${today} in file:`,
									file.path
								);
							}
						}
					}

					return needsUpdate;
				}
			);
		} catch (error) {
			console.error("Error updating file metadata:", error);
			if (this.plugin.settings.showDebugInfo) {
				new Notice(
					`Error updating metadata for ${file.basename}: ${error.message}`
				);
			}
		}
	}

	/**
	 * Handle Kanban board integration with files
	 * Updates the position of a note card in Kanban boards when tasks are completed or status changes
	 */
	async updateKanbanBoards(
		file: TFile,
		completedTasks: number,
		totalTasks: number
	) {
		try {
			// Only proceed if Kanban integration is enabled
			if (!this.plugin.settings.autoUpdateKanban || totalTasks === 0) {
				return;
			}

			// Calculate the current status based on progress
			let currentStatus = this.calculateStatusFromProgress(
				completedTasks,
				totalTasks
			);

			// Wait for MetadataCache to update
			await this.waitForCacheUpdate(file);
			// Get status from YAML frontmatter if available - more accurate
			let statusFromYaml = await this.getStatusFromYaml(file);
			if (statusFromYaml) {
				currentStatus = statusFromYaml;

				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Using status from YAML: ${currentStatus} instead of calculated status`
					);
				}
			}

			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Searching for Kanban boards that might contain ${file.path}...`
				);
				console.log(
					`Current status is: ${currentStatus} (${completedTasks}/${totalTasks} tasks)`
				);
			}

			// Get and process Kanban boards
			const updatedBoardCount = await this.processKanbanBoards(
				file,
				currentStatus
			);

			if (updatedBoardCount > 0) {
				new Notice(
					`Updated ${updatedBoardCount} Kanban board${
						updatedBoardCount > 1 ? "s" : ""
					} to move ${file.basename} to ${currentStatus} column`
				);
			}
		} catch (error) {
			console.error("Error updating Kanban boards:", error);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
				new Notice(`Error updating Kanban boards: ${error.message}`);
			}
		}
	}

	/**
	 * Calculate status based on task progress
	 */
	private calculateStatusFromProgress(
		completedTasks: number,
		totalTasks: number
	): string {
		if (totalTasks === 0) {
			return this.plugin.settings.statusTodo;
		} else if (completedTasks === 0) {
			return this.plugin.settings.statusTodo;
		} else if (completedTasks === totalTasks) {
			return this.plugin.settings.statusCompleted;
		} else {
			return this.plugin.settings.statusInProgress;
		}
	}

	/**
	 * Process all Kanban boards that might reference the target file
	 * Returns the number of boards that were updated
	 */
	private async processKanbanBoards(
		file: TFile,
		currentStatus: string
	): Promise<number> {
		// Skip plugin files and obvious Kanban files to avoid self-reference issues
		const filePath = file.path.toLowerCase();
		const configDir = this.plugin.app.vault.configDir.toLowerCase();
		if (
			filePath.includes(`${configDir}/plugins/progress-tracker`) ||
			filePath.includes("kanban")
		) {
			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Skipping plugin or kanban file for kanban processing: ${file.path}`
				);
			}
			return 0;
		}

		let updatedBoardCount = 0;

		// If there is a target board selected in settings, only process that board
		if (this.plugin.settings.autoAddKanbanBoard) {
			const targetBoard = this.plugin.app.vault.getAbstractFileByPath(
				this.plugin.settings.autoAddKanbanBoard
			);

			if (targetBoard instanceof TFile) {
				// Skip if trying to update the target file itself
				if (targetBoard.path === file.path) {
					if (this.plugin.settings.showDebugInfo) {
						console.log(
							`Skipping target board as it's the file being updated: ${file.path}`
						);
					}
					return 0;
				}

				// Read and process the target board
				const boardContent = await this.plugin.app.vault.read(targetBoard);

				// Skip if not a Kanban board or doesn't reference our file
				if (
					!this.isKanbanBoard(targetBoard) ||
					!this.containsFileReference(boardContent, file)
				) {
					if (this.plugin.settings.showDebugInfo) {
						console.log(
							`Target board ${targetBoard.path} is not a valid Kanban board or doesn't reference ${file.path}`
						);
					}
					return 0;
				}

				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Processing target Kanban board: ${targetBoard.path}`
					);
				}

				// Update the Kanban board
				const updatedContent = await this.moveCardInKanbanBoard(
					targetBoard,
					boardContent,
					file,
					currentStatus
				);

				// If the board was updated, increment the counter
				if (updatedContent !== boardContent) {
					updatedBoardCount++;
				}

				return updatedBoardCount;
			} else {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Target board not found: ${this.plugin.settings.autoAddKanbanBoard}`
					);
				}
				return 0;
			}
		}

		// If no target board is set, search all possible boards
		if (this.plugin.settings.showDebugInfo) {
			console.log(
				`No target board set, searching all potential Kanban boards...`
			);
		}

		// Get all markdown files that might be Kanban boards
		const markdownFiles = this.plugin.app.vault.getMarkdownFiles();

		// Check each potential Kanban board file
		for (const boardFile of markdownFiles) {
			// Skip checking the current file itself
			if (boardFile.path === file.path) continue;

			// Read the content of the potential Kanban board
			const boardContent = await this.plugin.app.vault.read(boardFile);

			// Skip if not a Kanban board or doesn't reference our file
			if (
				!this.isKanbanBoard(boardFile) ||
				!this.containsFileReference(boardContent, file)
			)
				continue;

			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Found Kanban board "${boardFile.path}" that references "${file.path}"`
				);
			}

			// Update the Kanban board by moving the card
			const updatedContent = await this.moveCardInKanbanBoard(
				boardFile,
				boardContent,
				file,
				currentStatus
			);

			// If the board was updated, increment the counter
			if (updatedContent !== boardContent) {
				updatedBoardCount++;
			}
		}

		return updatedBoardCount;
	}

	/**
	 * Safely escape regex special characters in a string
	 * Used by multiple methods that need to create regex patterns
	 */
	private escapeRegExp(string: string): string {
		if (!string) return "";
		return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/**
	 * Check if a Kanban board content contains a reference to the given file
	 */
	private containsFileReference(boardContent: string, file: TFile): boolean {
		// Different ways a file might be referenced in a Kanban board
		const filePath = file.path;
		const filePathWithoutExtension = filePath.replace(/\.md$/, "");
		const fileName = file.basename;

		// First try to find exact matches in Obsidian-style links
		const obsidianLinks = this.extractObsidianLinks(boardContent);
		for (const link of obsidianLinks) {
			const { path, alias } = link;
			if (path === fileName || path === filePathWithoutExtension || path === filePath) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Found exact Obsidian link match for ${fileName}: ${path}`);
				}
				return true;
			}
		}

		// Then check for Markdown-style links
		const markdownLinks = this.extractMarkdownLinks(boardContent);
		for (const link of markdownLinks) {
			const { text, url } = link;
			if (url === filePath || url === filePathWithoutExtension) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Found exact Markdown link match for ${fileName}: ${url}`);
				}
				return true;
			}
		}

		// Finally check for exact filepath mentions (with strict boundaries)
		const filepathPattern = new RegExp(`(?:^|\\s|\\()${this.escapeRegExp(filePath)}(?:$|\\s|\\))`, "i");
		if (filepathPattern.test(boardContent)) {
			if (this.plugin.settings.showDebugInfo) {
				console.log(`Found exact filepath match for ${filePath}`);
			}
			return true;
		}

		return false;
	}

	/**
	 * Extract all Obsidian-style links from content
	 * Returns array of {path, alias} objects
	 */
	private extractObsidianLinks(content: string): Array<{path: string, alias?: string}> {
		const links: Array<{path: string, alias?: string}> = [];
		const linkPattern = /\[\[(.*?)\]\]/g;
		let match;

		while ((match = linkPattern.exec(content)) !== null) {
			const [_, linkContent] = match;
			const [path, alias] = linkContent.split("|").map(s => s.trim());
			links.push({ path, alias });
		}

		if (this.plugin.settings.showDebugInfo) {
			console.log("Extracted Obsidian links:", links);
		}

		return links;
	}

	/**
	 * Extract all Markdown-style links from content
	 * Returns array of {text, url} objects
	 */
	private extractMarkdownLinks(content: string): Array<{text: string, url: string}> {
		const links: Array<{text: string, url: string}> = [];
		const linkPattern = /\[(.*?)\]\((.*?)\)/g;
		let match;

		while ((match = linkPattern.exec(content)) !== null) {
			const [_, text, url] = match;
			links.push({ text: text.trim(), url: url.trim() });
		}

		if (this.plugin.settings.showDebugInfo) {
			console.log("Extracted Markdown links:", links);
		}

		return links;
	}

	/**
	 * Move a card in a Kanban board to the appropriate column based on status
	 */
	async moveCardInKanbanBoard(
		boardFile: TFile,
		boardContent: string,
		fileToMove: TFile,
		targetStatus: string
	): Promise<string> {
		try {
			// Wait for MetadataCache to update
			await this.waitForCacheUpdate(fileToMove);
			// Parse the Kanban board structure
			const kanbanColumns = await this.parseKanbanBoard(boardFile);
			if (!kanbanColumns || Object.keys(kanbanColumns).length === 0) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Could not parse Kanban board structure in ${boardFile.path}`
					);
				}
				return boardContent;
			}

			// Determine the target column name based on settings
			let targetColumnName: string | undefined;

			if (this.plugin.settings.kanbanSyncWithStatus) {
				// When syncing with status, use exact status name as the column name
				targetColumnName = Object.keys(kanbanColumns).find(
					(name) => name.toLowerCase() === targetStatus.toLowerCase()
				);

				// If the exact status name isn't found, try a fuzzy match
				if (!targetColumnName) {
					targetColumnName = this.findClosestColumnName(
						Object.keys(kanbanColumns),
						targetStatus
					);
				}
			} else {
				// Legacy behavior: When not syncing, use the completed column setting, but only for completed tasks
				if (targetStatus === this.plugin.settings.statusCompleted) {
					targetColumnName = Object.keys(kanbanColumns).find(
						(name) =>
							name.toLowerCase() ===
							this.plugin.settings.kanbanCompletedColumn.toLowerCase()
					);
				}
			}

			// If no matching column found, log and return original content
			if (!targetColumnName) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Could not find column for status "${targetStatus}" in Kanban board ${boardFile.path}`
					);
					console.log(
						`Available columns: ${Object.keys(kanbanColumns).join(
							", "
						)}`
					);
				}
				return boardContent;
			}

			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Target column for status "${targetStatus}" is "${targetColumnName}"`
				);
			}

			// Process each column to find and move the card
			let cardMoved = false;
			let newContent = boardContent;

			// Split content into lines for more accurate processing
			const lines = newContent.split("\n");
			let currentColumn = "";
			let cardStartIndex = -1;
			let cardEndIndex = -1;

			// First pass: Find the exact card that references our file
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];

				// Check for column header
				if (line.startsWith("## ")) {
					currentColumn = line.substring(3).trim();
					continue;
				}

				// Skip if we're already in target column
				if (currentColumn.toLowerCase() === targetColumnName.toLowerCase()) {
					continue;
				}

				// Check if line is a card (starts with "- ")
				if (line.trim().startsWith("- ")) {
					// Extract the card content
					const cardContent = this.getCompleteCardContent(lines, i);
					
					// Check if this card references our file
					if (this.isExactCardForFile(cardContent.content, fileToMove)) {
						cardStartIndex = i;
						cardEndIndex = i + cardContent.lineCount - 1;
						break;
					}
					
					// Skip to end of card
					i += cardContent.lineCount - 1;
				}
			}

			// If we found the card, move it
			if (cardStartIndex !== -1 && cardEndIndex !== -1) {
				// Extract the card content
				let cardLines = lines.slice(cardStartIndex, cardEndIndex + 1);
				
				// Update checkbox states in the card if custom checkbox states are enabled
				if (this.plugin.settings.enableCustomCheckboxStates && targetColumnName) {
					const columnName = targetColumnName; // Type assertion for TypeScript
					cardLines = cardLines.map(line => {
						return this.updateCheckboxStatesInCard(line, columnName);
					});
				}
				
				// Remove the card from its current position
				lines.splice(cardStartIndex, cardEndIndex - cardStartIndex + 1);

				// Find the target column and insert the card
				let targetInsertIndex = -1;
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].startsWith(`## ${targetColumnName}`)) {
						targetInsertIndex = i + 1;
						break;
					}
				}

				if (targetInsertIndex !== -1) {
					// Insert the card at the beginning of the target column
					lines.splice(targetInsertIndex, 0, ...cardLines);
					cardMoved = true;

					if (this.plugin.settings.showDebugInfo) {
						console.log(
							`Moved card for ${fileToMove.path} to column "${targetColumnName}" in ${boardFile.path}`
						);
						if (this.plugin.settings.enableCustomCheckboxStates) {
							const targetCheckboxState = this.getCheckboxStateForColumn(targetColumnName);
							console.log(`Applied checkbox state "${targetCheckboxState}" to card`);
						}
					}
				}
			}

			// If card was moved, update the file
			if (cardMoved) {
				newContent = lines.join("\n");
				await this.plugin.app.vault.modify(boardFile, newContent);
			}

			return newContent;
		} catch (error) {
			console.error("Error moving card in Kanban board:", error);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			return boardContent;
		}
	}

	/**
	 * Get the complete content of a card, including any sub-items
	 */
	private getCompleteCardContent(lines: string[], startIndex: number): { content: string, lineCount: number } {
		let content = lines[startIndex];
		let lineCount = 1;
		
		// Check subsequent lines for sub-items (indented)
		for (let i = startIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "" || line.startsWith("  ") || line.startsWith("\t")) {
				content += "\n" + line;
				lineCount++;
			} else {
				break;
			}
		}
		
		return { content, lineCount };
	}

	/**
	 * Check if a card content exactly matches a file reference
	 */
	private isExactCardForFile(cardContent: string, file: TFile): boolean {
		// Extract all links from the card
		const obsidianLinks = this.extractObsidianLinks(cardContent);
		const markdownLinks = this.extractMarkdownLinks(cardContent);

		const fileName = file.basename;
		const filePath = file.path;
		const filePathWithoutExtension = filePath.replace(/\.md$/, "");

		// Check Obsidian links first
		for (const link of obsidianLinks) {
			const { path } = link;
			// Only match if it's an exact match with the full path or filename
			if (path === fileName || path === filePathWithoutExtension || path === filePath) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Found exact Obsidian link match in card: ${path} for file: ${fileName}`);
				}
				return true;
			}
		}

		// Then check Markdown links
		for (const link of markdownLinks) {
			const { url } = link;
			if (url === filePath || url === filePathWithoutExtension) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Found exact Markdown link match in card: ${url} for file: ${fileName}`);
				}
				return true;
			}
		}

		return false;
	}

	/**
	 * Find the closest column name match for a given status
	 * This helps when Kanban columns don't exactly match status names
	 */
	findClosestColumnName(
		columnNames: string[],
		targetStatus: string
	): string | undefined {
		const targetLower = targetStatus.toLowerCase();

		// Define common variants of status names and their corresponding column names
		const statusVariants: Record<string, string[]> = {
			todo: [
				"to do",
				"todo",
				"backlog",
				"new",
				"not started",
				"pending",
				"open",
				"to-do",
			],
			"in progress": [
				"progress",
				"doing",
				"working",
				"ongoing",
				"started",
				"in work",
				"active",
				"current",
				"wip",
			],
			completed: [
				"done",
				"complete",
				"finished",
				"closed",
				"resolved",
				"ready",
				"completed",
			],
		};

		// First try exact match (case-insensitive)
		const exactMatch = columnNames.find(
			(name) => name.toLowerCase() === targetLower
		);
		if (exactMatch) return exactMatch;

		// Special handling for common status values
		if (targetLower === this.plugin.settings.statusTodo.toLowerCase()) {
			for (const colName of columnNames) {
				const colNameLower = colName.toLowerCase();
				if (
					statusVariants["todo"].some(
						(v) => colNameLower.includes(v) || v === colNameLower
					)
				) {
					return colName;
				}
			}
		} else if (
			targetLower === this.plugin.settings.statusInProgress.toLowerCase()
		) {
			for (const colName of columnNames) {
				const colNameLower = colName.toLowerCase();
				if (
					statusVariants["in progress"].some(
						(v) => colNameLower.includes(v) || v === colNameLower
					)
				) {
					return colName;
				}
			}
		} else if (
			targetLower === this.plugin.settings.statusCompleted.toLowerCase()
		) {
			for (const colName of columnNames) {
				const colNameLower = colName.toLowerCase();
				if (
					statusVariants["completed"].some(
						(v) => colNameLower.includes(v) || v === colNameLower
					)
				) {
					return colName;
				}
			}
		}

		// Then try fuzzy variant matching if status is not a standard one
		for (const [status, variants] of Object.entries(statusVariants)) {
			if (
				variants.some(
					(v) => targetLower.includes(v) || v.includes(targetLower)
				)
			) {
				for (const colName of columnNames) {
					const colNameLower = colName.toLowerCase();
					if (
						variants.some(
							(v) =>
								colNameLower.includes(v) ||
								v.includes(colNameLower)
						)
					) {
						return colName;
					}
				}
			}
		}

		// If there's a direct word match, use that
		for (const colName of columnNames) {
			if (colName.toLowerCase() === targetLower) {
				return colName;
			}
		}

		// If no matches are found, try to find any column with a partial match
		for (const colName of columnNames) {
			if (
				colName.toLowerCase().includes(targetLower) ||
				targetLower.includes(colName.toLowerCase())
			) {
				return colName;
			}
		}

		// If still no matches, and this is a "Todo" status with no matching column,
		// return the first column as a likely match for the starting column
		if (
			targetLower === this.plugin.settings.statusTodo.toLowerCase() &&
			columnNames.length > 0
		) {
			return columnNames[0]; // First column is often the "Todo" equivalent
		}

		// If no matches are found, return undefined
		return undefined;
	}

	/**
	 * Get the status from the file's YAML frontmatter
	 */
	async getStatusFromYaml(file: TFile): Promise<string | null> {
		// Get the file cache from MetadataCache
		let fileCache = this.app.metadataCache.getFileCache(file);

		// If no cache or frontmatter, log and return null
		if (!fileCache?.frontmatter) {
			if (this.plugin.settings.showDebugInfo) {
				console.log(`No frontmatter found for file: ${file.path}`);
			}
			return null;
		}

		try {
			// Retrieve status from frontmatter
			const status = fileCache.frontmatter["status"];
			if (typeof status === "string" && status.trim()) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Status found for ${file.path}: ${status}`);
				}
				return status.trim();
			}

			// Log if no valid status is found
			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`No valid status in frontmatter for file: ${file.path}`
				);
			}
		} catch (error) {
			// Log any errors during frontmatter access
			console.error(
				`Error accessing frontmatter for ${file.path}:`,
				error
			);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
		}

		return null;
	}

	// Utility function to wait for MetadataCache to update for a specific file
	async waitForCacheUpdate(
		file: TFile,
		timeoutMs: number = 1000
	): Promise<void> {
		return new Promise((resolve, reject) => {
			// Set a timeout to prevent hanging
			const timeout = setTimeout(() => {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Timeout waiting for cache update for ${file.path}`
					);
				}
				resolve();
			}, timeoutMs);

			// Listen for cache changes
			const handler = (updatedFile: TFile) => {
				if (updatedFile.path === file.path) {
					// Cache updated, cleanup and resolve
					this.app.metadataCache.off("changed", handler);
					clearTimeout(timeout);
					if (this.plugin.settings.showDebugInfo) {
						console.log(`Cache updated for ${file.path}`);
					}
					resolve();
				}
			};

			// Register the listener
			this.app.metadataCache.on("changed", handler);

			// Trigger a cache refresh (optional, depends on Obsidian version)
			// this.app.metadataCache.trigger("changed", file);
		});
	}

	/**
	 * Parse Kanban board structure into columns and items with improved accuracy
	 */
	private async parseKanbanBoard(
		file: TFile
	): Promise<Record<string, { items: Array<{ text: string }> }>> {
		const kanban: Record<string, { items: Array<{ text: string }> }> = {};

		try {
			// Use MetadataCache to get frontmatter and headers
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (!fileCache) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`No cache found for file: ${file.path}`);
				}
				return kanban;
			}

			// Check if this is a Kanban plugin file using frontmatter
			const isKanbanPlugin =
				fileCache.frontmatter?.["kanban-plugin"] === "basic";

			// Get H2 headers (level 2) to identify columns
			const columnHeaders =
				fileCache.headings?.filter((h) => h.level === 2) || [];
			if (columnHeaders.length < 1) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`No H2 headers found in file: ${file.path}`);
				}
				return kanban;
			}

			// Read file content only when necessary to extract items
			const content = await this.plugin.app.vault.read(file);

			// Process each column
			for (let i = 0; i < columnHeaders.length; i++) {
				const columnHeader = columnHeaders[i];
				const columnName = columnHeader.heading.trim();
				kanban[columnName] = { items: [] };

				// Determine column boundaries using header positions
				const columnStart = columnHeader.position.start.offset;
				const columnEnd =
					i < columnHeaders.length - 1
						? columnHeaders[i + 1].position.start.offset
						: content.length;

				// Extract column content
				const columnContent = content
					.substring(
						columnStart + columnHeader.heading.length + 4,
						columnEnd
					)
					.trim(); // +4 accounts for "## " and newline

				// Extract items based on format
				if (isKanbanPlugin) {
					this.extractKanbanPluginItems(
						columnContent,
						kanban[columnName].items
					);
				} else {
					this.extractMarkdownItems(
						columnContent,
						kanban[columnName].items
					);
				}
			}

			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Parsed Kanban board ${file.path} with columns:`,
					Object.keys(kanban)
				);
				Object.entries(kanban).forEach(([column, data]) => {
					console.log(
						`Column "${column}" has ${data.items.length} items`
					);
				});
			}
		} catch (error) {
			console.error(`Error parsing Kanban board ${file.path}:`, error);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
		}

		return kanban;
	}

	/**
	 * Extract items from Kanban plugin format
	 */
	private extractKanbanPluginItems(
		columnContent: string,
		items: Array<{ text: string }>
	) {
		// Split by top-level list items (those that start with "- " at beginning of line)
		const listItemsRaw = columnContent.split(/^- /m).slice(1);

		for (const rawItem of listItemsRaw) {
			const itemText = "- " + rawItem.trim();
			items.push({ text: itemText });
		}
	}

	/**
	 * Extract items from regular markdown format
	 */
	private extractMarkdownItems(
		columnContent: string,
		items: Array<{ text: string }>
	) {
		// Each item starts with "- " at the beginning of a line
		// And continues until the next item or end of content
		let lines = columnContent.split("\n");
		let currentItem = "";
		let inItem = false;

		for (const line of lines) {
			if (line.trim().startsWith("- ")) {
				// If we were already in an item, save the previous one
				if (inItem) {
					items.push({ text: currentItem.trim() });
				}

				// Start a new item
				currentItem = line;
				inItem = true;
			} else if (inItem) {
				// Continue current item
				currentItem += "\n" + line;
			}
		}

		// Add the last item if there is one
		if (inItem) {
			items.push({ text: currentItem.trim() });
		}
	}

	/**
	 * Check if content appears to be a Kanban board
	 * This method is necessary for the processKanbanBoards function
	 */
	private isKanbanBoard(file: TFile): boolean {
		try {
			// Use MetadataCache to get file cache
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (!fileCache) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`No cache found for file: ${file.path}`);
				}
				return false;
			}

			// Check for Kanban plugin frontmatter
			if (fileCache.frontmatter?.["kanban-plugin"] === "basic") {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Detected Kanban plugin board: ${file.path}`);
				}
				return true;
			}

			// Check for Kanban-like structure via headers
			const headers = fileCache.headings || [];
			if (headers.length < 2) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Insufficient headers in file: ${file.path}`);
				}
				return false;
			}

			const commonKanbanNames = [
				"todo",
				"to do",
				"to-do",
				"backlog",
				"new",
				"ideas",
				"inbox",
				"in progress",
				"doing",
				"working",
				"current",
				"ongoing",
				"done",
				"complete",
				"completed",
				"finished",
				"blocked",
				"waiting",
			];

			let kanbanColumnCount = 0;
			const completedColumnLower =
				this.plugin.settings.kanbanCompletedColumn.toLowerCase();

			for (const header of headers) {
				if (header.level !== 2) continue;
				const columnName = header.heading.toLowerCase();

				if (
					commonKanbanNames.some((name) =>
						columnName.includes(name)
					) ||
					columnName === completedColumnLower
				) {
					kanbanColumnCount++;
				}
			}

			const isKanban = kanbanColumnCount >= 2;
			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`File ${file.path} is ${
						isKanban ? "" : "not "
					}a Kanban board ` +
						`(columns detected: ${kanbanColumnCount})`
				);
			}

			return isKanban;
		} catch (error) {
			console.error(
				`Error checking if ${file.path} is a Kanban board:`,
				error
			);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			return false;
		}
	}

	/**
	 * Add a file to the specified Kanban board if it's not already there
	 */
	async addFileToKanbanBoard(file: TFile): Promise<boolean> {
		try {
			// Skip if auto-add setting is disabled or board path is empty
			if (
				!this.plugin.settings.autoAddToKanban ||
				!this.plugin.settings.autoAddKanbanBoard
			) {
				return false;
			}

			// Skip plugin files and Kanban board files to avoid self-reference
			const filePath = file.path.toLowerCase();
			const configDir = this.plugin.app.vault.configDir.toLowerCase();
			if (
				filePath.includes(`${configDir}/plugins/progress-tracker`) ||
				filePath.includes("kanban") ||
				filePath === this.plugin.settings.autoAddKanbanBoard
			) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Skipping plugin or kanban file: ${file.path}`);
				}
				return false;
			}

			// Get the Kanban board file
			const boardPath = this.plugin.settings.autoAddKanbanBoard;
			const kanbanFile =
				this.plugin.app.vault.getAbstractFileByPath(boardPath);

			if (!kanbanFile || !(kanbanFile instanceof TFile)) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Could not find Kanban board at path: ${boardPath}`
					);
				}
				return false;
			}

			// Skip if trying to add the kanban board to itself
			if (file.path === kanbanFile.path) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Skipping adding kanban board to itself: ${file.path}`
					);
				}
				return false;
			}

			// Read the board content
			const boardContent = await this.plugin.app.vault.read(kanbanFile);

			// Skip if this is not a Kanban board
			if (!this.isKanbanBoard(kanbanFile)) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`File at path ${boardPath} is not a Kanban board`
					);
				}
				return false;
			}

			// Check if the file is already referenced in the board
			if (this.containsFileReference(boardContent, file)) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`File ${file.path} is already in Kanban board ${boardPath}`
					);
				}
				return false;
			}

			// Get the target column name
			const targetColumn =
				this.plugin.settings.autoAddKanbanColumn || "Todo";

			// Wait for MetadataCache to update
			await this.waitForCacheUpdate(file);
			// Parse the Kanban board to find the column
			const kanbanColumns = await this.parseKanbanBoard(kanbanFile);
			if (!kanbanColumns || Object.keys(kanbanColumns).length === 0) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Could not parse Kanban board structure in ${boardPath}`
					);
				}
				return false;
			}

			// Find the exact or closest column match
			let targetColumnName = Object.keys(kanbanColumns).find(
				(name) => name.toLowerCase() === targetColumn.toLowerCase()
			);

			if (!targetColumnName) {
				targetColumnName = this.findClosestColumnName(
					Object.keys(kanbanColumns),
					targetColumn
				);
			}

			if (!targetColumnName) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Could not find column "${targetColumn}" in Kanban board ${boardPath}`
					);
				}
				return false;
			}

			// Find the position to insert the card
			const columnRegex = new RegExp(
				`## ${this.escapeRegExp(targetColumnName)}\\s*\\n`
			);
			const columnMatch = boardContent.match(columnRegex);

			if (!columnMatch) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Could not find column "${targetColumnName}" in Kanban board content`
					);
				}
				return false;
			}

			const insertPosition = columnMatch.index! + columnMatch[0].length;

			// Create card text with link to the file
			let cardText = `- [[${file.basename}]]\n`;
			
			// Apply custom checkbox state if enabled
			if (this.plugin.settings.enableCustomCheckboxStates) {
				const checkboxState = this.getCheckboxStateForColumn(targetColumnName);
				cardText = `- ${checkboxState} [[${file.basename}]]\n`;
			}

			// Insert the card
			const newContent =
				boardContent.substring(0, insertPosition) +
				cardText +
				boardContent.substring(insertPosition);

			// Update the file
			await this.plugin.app.vault.modify(kanbanFile, newContent);

			// Show notice
			new Notice(
				`Added ${file.basename} to "${targetColumnName}" column in ${kanbanFile.basename}`
			);

			return true;
		} catch (error) {
			console.error("Error adding file to Kanban board:", error);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			return false;
		}
	}

	/**
	 * Get checkbox state for a specific kanban column
	 */
	private getCheckboxStateForColumn(columnName: string): string {
		if (!this.plugin.settings.enableCustomCheckboxStates) {
			return "[ ]"; // Default unchecked state
		}

		const mapping = this.plugin.settings.kanbanColumnCheckboxMappings.find(
			m => m.columnName.toLowerCase() === columnName.toLowerCase()
		);

		return mapping ? mapping.checkboxState : "[ ]";
	}

	/**
	 * Update checkbox states in card content based on target column
	 * Only updates the main card checkbox, preserving sub-items and nested checkboxes
	 */
	private updateCheckboxStatesInCard(cardContent: string, targetColumnName: string): string {
		if (!this.plugin.settings.enableCustomCheckboxStates) {
			return cardContent;
		}

		const targetCheckboxState = this.getCheckboxStateForColumn(targetColumnName);
		
		// Split content into lines to process only the first line (main card)
		const lines = cardContent.split('\n');
		if (lines.length === 0) return cardContent;

		// Pattern to match various checkbox states: - [ ], - [x], - [/], - [>], etc.
		// Remove global flag to only match once per line
		const checkboxPattern = /^(\s*- )\[[^\]]*\](.*)$/;
		
		// Only update the first line if it matches the pattern (main card line)
		if (checkboxPattern.test(lines[0])) {
			const originalFirstLine = lines[0];
			lines[0] = lines[0].replace(checkboxPattern, (match, prefix, suffix) => {
				return `${prefix}${targetCheckboxState}${suffix}`;
			});

			if (this.plugin.settings.showDebugInfo && lines[0] !== originalFirstLine) {
				console.log(`Updated checkbox states in card for column "${targetColumnName}":`, {
					original: originalFirstLine,
					updated: lines[0],
					targetState: targetCheckboxState
				});
			}
		}

		// Join lines back together, preserving sub-items unchanged
		return lines.join('\n');
	}

	/**
	 * Count tasks with different checkbox states
	 */
	private countTasksByCheckboxState(content: string): { [state: string]: number } {
		const taskCounts: { [state: string]: number } = {};
		const lines = content.split('\n');
		
		for (const line of lines) {
			const match = line.trim().match(/^- \[([^\]]*)\]/);
			if (match) {
				const state = match[1];
				taskCounts[state] = (taskCounts[state] || 0) + 1;
			}
		}

		return taskCounts;
	}
}

class TaskProgressBarSettingTab extends PluginSettingTab {
	plugin: TaskProgressBarPlugin;

	constructor(app: App, plugin: TaskProgressBarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Add Dataview status information
		const dataviewStatus = containerEl.createDiv({
			cls: "dataview-status",
		});
		if (this.plugin.dvAPI) {
			dataviewStatus.createEl("p", {
				text: "✅ Dataview API is available",
				cls: "dataview-available",
			});
		} else {
			dataviewStatus.createEl("p", {
				text: "❌ Dataview API is not available",
				cls: "dataview-unavailable",
			});

			// Add button to check for Dataview again
			const checkButton = dataviewStatus.createEl("button", {
				text: "Check for Dataview",
				cls: "mod-cta",
			});
			checkButton.addEventListener("click", () => {
				this.plugin.checkDataviewAPI();
				if (this.plugin.dvAPI) {
					new Notice("Dataview API found!");
					this.display(); // Refresh settings tab
				} else {
					new Notice(
						"Dataview API not found. Make sure Dataview plugin is installed and enabled."
					);
				}
			});
		}

		new Setting(containerEl)
			.setName("Show debug info")
			.setDesc(
				"Show debug information in the sidebar to help troubleshoot task counting issues"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDebugInfo)
					.onChange(async (value) => {
						this.plugin.settings.showDebugInfo = value;
						await this.plugin.saveSettings();

						// Update sidebar if open - use public method
						const currentFile = this.app.workspace.getActiveFile();
						if (currentFile) {
							// Use public method to update UI
							this.plugin.checkDataviewAPI();
						}
					})
			);

		// Animation settings section
		new Setting(containerEl).setName("Animation").setHeading();

		// Add new setting for animation
		new Setting(containerEl)
			.setName("Show update animation")
			.setDesc("Show a brief animation when updating the progress bar")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showUpdateAnimation)
					.onChange(async (value) => {
						this.plugin.settings.showUpdateAnimation = value;
						await this.plugin.saveSettings();

						// No need to update the view here as it will only affect future updates
					})
			);

		// Performance settings section
		new Setting(containerEl).setName("Performance").setHeading();

		new Setting(containerEl)
			.setName("Editor change delay")
			.setDesc(
				"Delay before updating after editor content changes (lower = more responsive, higher = better performance)"
			)
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50) // From 100ms to 1000ms in steps of 50ms
					.setValue(this.plugin.settings.editorChangeDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.editorChangeDelay = value;
						await this.plugin.saveSettings();
						// Note: This will take effect after plugin reload
						new Notice(
							"Editor change delay updated. Restart plugin to apply changes."
						);
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip("Reset to default (500ms)")
					.onClick(async () => {
						this.plugin.settings.editorChangeDelay = 500;
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings panel to update the slider
						new Notice(
							"Editor change delay reset. Restart plugin to apply changes."
						);
					})
			);

		new Setting(containerEl)
			.setName("Keyboard input delay")
			.setDesc(
				"Delay after keyboard input before updating progress (in milliseconds)"
			)
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50) // From 0ms to 100ms in steps of 5ms
					.setValue(this.plugin.settings.keyboardInputDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.keyboardInputDelay = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip("Reset to default (100ms)")
					.onClick(async () => {
						this.plugin.settings.keyboardInputDelay = 100;
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings panel to update the slider
					})
			);

		new Setting(containerEl)
			.setName("Checkbox click delay")
			.setDesc(
				"Delay after checkbox click before updating progress (in milliseconds)"
			)
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50) // From 10ms to 200ms in steps of 10ms
					.setValue(this.plugin.settings.checkboxClickDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.checkboxClickDelay = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip("Reset to default (200ms)")
					.onClick(async () => {
						this.plugin.settings.checkboxClickDelay = 200;
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings panel to update the slider
					})
			);

		// Add color scheme settings
		new Setting(containerEl).setName("Progress bar colors").setHeading();

		new Setting(containerEl)
			.setName("Color scheme")
			.setDesc("Choose a color scheme for the progress bar")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("default", "Default (Theme Colors)")
					.addOption("red-orange-green", "Red-Orange-Blue-Green")
					.addOption("custom", "Custom Colors")
					.setValue(this.plugin.settings.progressColorScheme)
					.onChange(
						async (
							value: "default" | "red-orange-green" | "custom"
						) => {
							this.plugin.settings.progressColorScheme = value;

							// Set preset colors if red-orange-green is selected
							if (value === "red-orange-green") {
								// Reset color values and thresholds
								this.plugin.settings.lowProgressColor =
									"#e06c75"; // Red
								this.plugin.settings.mediumProgressColor =
									"#e5c07b"; // Orange/Yellow
								this.plugin.settings.highProgressColor =
									"#61afef"; // Blue
								this.plugin.settings.completeProgressColor =
									"#98c379"; // Green

								// Reset thresholds
								this.plugin.settings.lowProgressThreshold = 30;
								this.plugin.settings.mediumProgressThreshold = 60;
								this.plugin.settings.highProgressThreshold = 99;

								// Show notice to confirm changes
								new Notice(
									"Applied Red-Orange-Blue-Green color scheme"
								);
							}

							await this.plugin.saveSettings();
							this.display(); // Refresh to show/hide custom color options

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						}
					)
			);

		// Only show custom color settings if custom is selected
		if (this.plugin.settings.progressColorScheme === "custom") {
			new Setting(containerEl)
				.setName("Low progress color")
				.setDesc(
					`Color for progress below ${this.plugin.settings.lowProgressThreshold}%`
				)
				.addText((text) =>
					text
						.setValue(this.plugin.settings.lowProgressColor)
						.onChange(async (value) => {
							this.plugin.settings.lowProgressColor = value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);

			new Setting(containerEl)
				.setName("Medium progress color")
				.setDesc(
					`Color for progress between ${this.plugin.settings.lowProgressThreshold}% and ${this.plugin.settings.mediumProgressThreshold}%`
				)
				.addText((text) =>
					text
						.setValue(this.plugin.settings.mediumProgressColor)
						.onChange(async (value) => {
							this.plugin.settings.mediumProgressColor = value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);

			new Setting(containerEl)
				.setName("High progress color")
				.setDesc(
					`Color for progress between ${this.plugin.settings.mediumProgressThreshold}% and ${this.plugin.settings.highProgressThreshold}%`
				)
				.addText((text) =>
					text
						.setValue(this.plugin.settings.highProgressColor)
						.onChange(async (value) => {
							this.plugin.settings.highProgressColor = value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);

			new Setting(containerEl)
				.setName("Complete progress color")
				.setDesc("Color for 100% progress")
				.addText((text) =>
					text
						.setValue(this.plugin.settings.completeProgressColor)
						.onChange(async (value) => {
							this.plugin.settings.completeProgressColor = value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);

			// Add threshold settings
			new Setting(containerEl)
				.setName("Low progress threshold")
				.setDesc("Percentage below which progress is considered low")
				.addSlider((slider) =>
					slider
						.setLimits(1, 99, 1)
						.setValue(this.plugin.settings.lowProgressThreshold)
						.setDynamicTooltip()
						.onChange(async (value) => {
							// Ensure thresholds don't overlap
							if (
								value >=
								this.plugin.settings.mediumProgressThreshold
							) {
								value =
									this.plugin.settings
										.mediumProgressThreshold - 1;
							}
							this.plugin.settings.lowProgressThreshold = value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);

			new Setting(containerEl)
				.setName("Medium progress threshold")
				.setDesc("Percentage below which progress is considered medium")
				.addSlider((slider) =>
					slider
						.setLimits(1, 99, 1)
						.setValue(this.plugin.settings.mediumProgressThreshold)
						.setDynamicTooltip()
						.onChange(async (value) => {
							// Ensure thresholds don't overlap
							if (
								value <=
								this.plugin.settings.lowProgressThreshold
							) {
								value =
									this.plugin.settings.lowProgressThreshold +
									1;
							}
							if (
								value >=
								this.plugin.settings.highProgressThreshold
							) {
								value =
									this.plugin.settings.highProgressThreshold -
									1;
							}
							this.plugin.settings.mediumProgressThreshold =
								value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);

			new Setting(containerEl)
				.setName("High progress threshold")
				.setDesc(
					"Percentage below which progress is considered high (but not complete)"
				)
				.addSlider((slider) =>
					slider
						.setLimits(1, 99, 1)
						.setValue(this.plugin.settings.highProgressThreshold)
						.setDynamicTooltip()
						.onChange(async (value) => {
							// Ensure thresholds don't overlap
							if (
								value <=
								this.plugin.settings.mediumProgressThreshold
							) {
								value =
									this.plugin.settings
										.mediumProgressThreshold + 1;
							}
							this.plugin.settings.highProgressThreshold = value;
							await this.plugin.saveSettings();

							// Update the view if open
							const currentFile =
								this.app.workspace.getActiveFile();
							if (currentFile && this.plugin.sidebarView) {
								this.plugin.sidebarView.updateProgressBar(
									currentFile
								);
							}
						})
				);
		}

		// Interface settings section (Add this before or after Animation Settings)
		new Setting(containerEl).setName("Interface").setHeading();

		// Fix the Max Tabs Height setting to allow proper input
		new Setting(containerEl)
			.setName("Max tabs height")
			.setDesc(
				"Maximum height for workspace tabs (e.g., 110px, 200px, auto)"
			)
			.addText((text) => {
				// Set initial value
				text.setValue(this.plugin.settings.maxTabsHeight);

				// Apply improved validation only when the field loses focus
				// This allows typing intermediary values that may not be valid yet
				text.inputEl.addEventListener("blur", async () => {
					const value = text.inputEl.value;
					// Validate only when user is done editing
					const isValid =
						value === "auto" ||
						value === "none" ||
						/^\d+(\.\d+)?(px|em|rem|vh|%)$/.test(value);

					if (isValid) {
						// Only update if changed to avoid unnecessary saves
						if (this.plugin.settings.maxTabsHeight !== value) {
							this.plugin.settings.maxTabsHeight = value;
							await this.plugin.saveSettings();
							new Notice(`Max tabs height updated to ${value}`);
						}
					} else {
						new Notice(
							"Please enter 'auto', 'none' or a valid CSS length value (e.g., 110px)"
						);
						// Reset to previous valid value
						text.setValue(this.plugin.settings.maxTabsHeight);
					}
				});

				// Add Enter key handling
				text.inputEl.addEventListener("keydown", async (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						text.inputEl.blur(); // Trigger the blur event to validate
					}
				});

				// Improve UX
				text.inputEl.style.width = "120px";
				text.inputEl.placeholder = "auto";

				return text;
			})
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip("Reset to default (auto)")
					.onClick(async () => {
						this.plugin.settings.maxTabsHeight = "auto";
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings panel
						new Notice("Max tabs height reset to 'auto'");
					})
			);

		// Add Metadata Auto-Update Settings
		new Setting(containerEl).setName("Metadata auto-update").setHeading();

		new Setting(containerEl)
			.setName("Auto-update metadata")
			.setDesc(
				"Automatically update metadata when all tasks are completed"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoUpdateMetadata)
					.onChange(async (value) => {
						this.plugin.settings.autoUpdateMetadata = value;
						await this.plugin.saveSettings();
						// Refresh the display to show/hide related settings
						this.display();
					})
			);

		// Only show these settings if auto-update is enabled
		if (this.plugin.settings.autoUpdateMetadata) {
			new Setting(containerEl)
				.setName("Change status")
				.setDesc(
					"Change 'status: In Progress' to 'status: Completed' when tasks reach 100%"
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.autoChangeStatus)
						.onChange(async (value) => {
							this.plugin.settings.autoChangeStatus = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Update finished date")
				.setDesc(
					"Set 'finished: ' to today's date when tasks reach 100%"
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.autoUpdateFinishedDate)
						.onChange(async (value) => {
							this.plugin.settings.autoUpdateFinishedDate = value;
							await this.plugin.saveSettings();
						})
				);

			// Show status label settings if status changing is enabled
			if (this.plugin.settings.autoChangeStatus) {
				new Setting(containerEl)
					.setName("Todo status label")
					.setDesc("Status label for files with 0% progress")
					.addText((text) =>
						text
							.setPlaceholder("Todo")
							.setValue(this.plugin.settings.statusTodo)
							.onChange(async (value) => {
								this.plugin.settings.statusTodo = value;
								await this.plugin.saveSettings();
							})
					)
					.addExtraButton((button) =>
						button
							.setIcon("reset")
							.setTooltip("Reset to default")
							.onClick(async () => {
								this.plugin.settings.statusTodo = "Todo";
								await this.plugin.saveSettings();
								this.display();
							})
					);

				new Setting(containerEl)
					.setName("In progress status label")
					.setDesc("Status label for files with 1-99% progress")
					.addText((text) =>
						text
							.setPlaceholder("In Progress")
							.setValue(this.plugin.settings.statusInProgress)
							.onChange(async (value) => {
								this.plugin.settings.statusInProgress = value;
								await this.plugin.saveSettings();
							})
					)
					.addExtraButton((button) =>
						button
							.setIcon("reset")
							.setTooltip("Reset to default")
							.onClick(async () => {
								this.plugin.settings.statusInProgress =
									"In Progress";
								await this.plugin.saveSettings();
								this.display();
							})
					);

				new Setting(containerEl)
					.setName("Completed status label")
					.setDesc("Status label for files with 100% progress")
					.addText((text) =>
						text
							.setPlaceholder("Completed")
							.setValue(this.plugin.settings.statusCompleted)
							.onChange(async (value) => {
								this.plugin.settings.statusCompleted = value;
								await this.plugin.saveSettings();
							})
					)
					.addExtraButton((button) =>
						button
							.setIcon("reset")
							.setTooltip("Reset to default")
							.onClick(async () => {
								this.plugin.settings.statusCompleted =
									"Completed";
								await this.plugin.saveSettings();
								this.display();
							})
					);
			}

			// Add Kanban integration settings
			new Setting(containerEl).setName("Kanban integration").setHeading();

			new Setting(containerEl)
				.setName("Update Kanban boards")
				.setDesc(
					"Automatically move cards in Kanban boards based on task status"
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.autoUpdateKanban)
						.onChange(async (value) => {
							this.plugin.settings.autoUpdateKanban = value;
							await this.plugin.saveSettings();
							// Refresh to show/hide related settings
							this.display();
						})
				);

			if (this.plugin.settings.autoUpdateKanban) {
				new Setting(containerEl)
					.setName("Sync Kanban columns with status")
					.setDesc(
						"Match Kanban column names to status values (Todo, In Progress, Completed)"
					)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.kanbanSyncWithStatus)
							.onChange(async (value) => {
								this.plugin.settings.kanbanSyncWithStatus =
									value;
								await this.plugin.saveSettings();
								this.display(); // Refresh settings
							})
					);

				// Only show this if sync with status is disabled (legacy mode)
				if (!this.plugin.settings.kanbanSyncWithStatus) {
					new Setting(containerEl)
						.setName("Completed column name")
						.setDesc(
							"The name of the column where completed items should be moved to (e.g., 'Complete', 'Done', 'Finished')"
						)
						.addText((text) =>
							text
								.setPlaceholder("Complete")
								.setValue(
									this.plugin.settings.kanbanCompletedColumn
								)
								.onChange(async (value) => {
									this.plugin.settings.kanbanCompletedColumn =
										value;
									await this.plugin.saveSettings();
								})
						)
						.addExtraButton((button) =>
							button
								.setIcon("reset")
								.setTooltip("Reset to default (Complete)")
								.onClick(async () => {
									this.plugin.settings.kanbanCompletedColumn =
										"Complete";
									await this.plugin.saveSettings();
									this.display();
								})
						);
				}

				// Add Auto-detect settings and other Kanban settings
				new Setting(containerEl)
					.setName("Auto-detect Kanban boards")
					.setDesc(
						"Automatically detect files that appear to be Kanban boards"
					)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.kanbanAutoDetect)
							.onChange(async (value) => {
								this.plugin.settings.kanbanAutoDetect = value;
								await this.plugin.saveSettings();
								this.display(); // Refresh settings
							})
					);

				// Note about column naming
				const infoDiv = containerEl.createDiv({
					cls: "kanban-info",
					attr: {
						style: "background: var(--background-secondary-alt); padding: 10px; border-radius: 5px; margin-top: 10px;",
					},
				});

				infoDiv.createEl("p", {
					text: "ℹ️ Column naming tip:",
					attr: {
						style: "font-weight: bold; margin: 0 0 5px 0;",
					},
				});

				infoDiv.createEl("p", {
					text: `To get the best results, name your Kanban columns to match the status values: "${this.plugin.settings.statusTodo}", "${this.plugin.settings.statusInProgress}", and "${this.plugin.settings.statusCompleted}".`,
					attr: {
						style: "margin: 0;",
					},
				});

				// Keep the remaining Kanban settings (specific files, exclude files, file picker)
				// ...existing code...
			}
		}

		// Add new section for auto-add to Kanban
		new Setting(containerEl)
			.setName("Auto-add files to Kanban board")
			.setDesc(
				"Automatically add files with tasks to a specified Kanban board if they're not already there"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoAddToKanban)
					.onChange(async (value) => {
						this.plugin.settings.autoAddToKanban = value;
						await this.plugin.saveSettings();
						// Refresh to show/hide related settings
						this.display();
					})
			);

		if (this.plugin.settings.autoAddToKanban) {
			new Setting(containerEl)
				.setName("Target Kanban board")
				.setDesc(
					"The path to the Kanban board where files should be added"
				)
				.addText((text) =>
					text
						.setPlaceholder("path/to/kanban.md")
						.setValue(this.plugin.settings.autoAddKanbanBoard)
						.onChange(async (value) => {
							this.plugin.settings.autoAddKanbanBoard = value;
							await this.plugin.saveSettings();
						})
				);

			// Add file picker button
			containerEl.createEl("div", {
				text: "Select Kanban board file:",
				attr: { style: "margin-left: 36px; margin-bottom: 8px;" },
			});

			const filePickerContainer = containerEl.createEl("div", {
				attr: { style: "margin-left: 36px; margin-bottom: 12px;" },
			});

			const filePickerButton = filePickerContainer.createEl("button", {
				text: "Browse...",
				cls: "mod-cta",
			});

			filePickerButton.addEventListener("click", async () => {
				// Remove the problematic code that references app.plugins
				try {
					const modal = new FileSuggestModal(this.app, this.plugin);
					modal.onChooseItem = (file: TFile) => {
						if (file) {
							this.plugin.settings.autoAddKanbanBoard = file.path;
							this.plugin.saveSettings().then(() => {
								this.display();
							});
						}
					};
					modal.open();
				} catch (error) {
					new Notice(
						"Error opening file picker. Please enter the path manually."
					);
					console.error("File picker error:", error);
				}
			});

			new Setting(containerEl)
				.setName("Target column")
				.setDesc(
					"The column where new files should be added (e.g., 'Todo', 'Backlog')"
				)
				.addText((text) =>
					text
						.setPlaceholder("Todo")
						.setValue(this.plugin.settings.autoAddKanbanColumn)
						.onChange(async (value) => {
							this.plugin.settings.autoAddKanbanColumn = value;
							await this.plugin.saveSettings();
						})
				)
				.addExtraButton((button) =>
					button
						.setIcon("reset")
						.setTooltip("Reset to default (Todo)")
						.onClick(async () => {
							this.plugin.settings.autoAddKanbanColumn = "Todo";
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}

		// Add new section for custom checkbox states
		new Setting(containerEl)
			.setName("Custom Checkbox States")
			.setDesc("Configure custom checkbox states for different Kanban columns")
			.setHeading();

		new Setting(containerEl)
			.setName("Enable custom checkbox states")
			.setDesc(
				"When enabled, cards will automatically update their checkbox states when moved between Kanban columns"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableCustomCheckboxStates)
					.onChange(async (value) => {
						this.plugin.settings.enableCustomCheckboxStates = value;
						await this.plugin.saveSettings();
						// Refresh to show/hide related settings
						this.display();
					})
			);

		if (this.plugin.settings.enableCustomCheckboxStates) {
			// Add new setting for Kanban card checkbox sync
			new Setting(containerEl)
				.setName("Enable Kanban card checkbox sync")
				.setDesc(
					"When enabled, dragging cards between Kanban columns will automatically update checkbox states of the cards in the Kanban board"
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enableKanbanToFileSync)
						.onChange(async (value) => {
							this.plugin.settings.enableKanbanToFileSync = value;
							await this.plugin.saveSettings();
						})
				);

			// Add new setting for auto-sync on Kanban open
			new Setting(containerEl)
				.setName("Auto-sync checkbox states on Kanban open")
				.setDesc(
					"When enabled, automatically sync all card checkbox states to match their columns when opening a Kanban board (runs once per session for performance)"
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enableKanbanAutoSync)
						.onChange(async (value) => {
							this.plugin.settings.enableKanbanAutoSync = value;
							await this.plugin.saveSettings();
						})
				);

			// NEW: Add setting for Kanban normalization protection
			new Setting(containerEl)
				.setName("Protect custom checkbox states from Kanban normalization")
				.setDesc(
					"When enabled, prevents the Kanban plugin from automatically converting custom checkbox states (like [/], [~]) to standard states ([x]). This preserves your custom state mappings."
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enableKanbanNormalizationProtection)
						.onChange(async (value) => {
							this.plugin.settings.enableKanbanNormalizationProtection = value;
							await this.plugin.saveSettings();
						})
				);

			// Add explanation
			const infoDiv = containerEl.createDiv({
				cls: "custom-checkbox-info",
				attr: {
					style: "background: var(--background-secondary-alt); padding: 10px; border-radius: 5px; margin: 10px 0;",
				},
			});

			infoDiv.createEl("p", {
				text: "ℹ️ Custom Checkbox States Configuration:",
				attr: {
					style: "font-weight: bold; margin: 0 0 5px 0;",
				},
			});

			infoDiv.createEl("p", {
				text: "Define which checkbox state should be used for each Kanban column. Common states include: [ ] (todo), [/] (in progress), [x] (completed), [>] (forwarded), [-] (cancelled).",
				attr: {
					style: "margin: 0 0 5px 0;",
				},
			});

			// Display current mappings
			this.plugin.settings.kanbanColumnCheckboxMappings.forEach((mapping, index) => {
				const mappingContainer = containerEl.createDiv({
					cls: "checkbox-mapping-container",
					attr: {
						style: "display: flex; gap: 10px; align-items: center; margin: 10px 0; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 5px;",
					},
				});

				// Column name input
				const columnInput = mappingContainer.createEl("input", {
					type: "text",
					value: mapping.columnName,
					attr: {
						placeholder: "Column Name",
						style: "flex: 1; padding: 5px;",
					},
				});

				// Checkbox state input
				const checkboxInput = mappingContainer.createEl("input", {
					type: "text",
					value: mapping.checkboxState,
					attr: {
						placeholder: "[ ]",
						style: "width: 60px; padding: 5px; text-align: center;",
					},
				});

				// Delete button
				const deleteButton = mappingContainer.createEl("button", {
					text: "Remove",
					cls: "mod-warning",
					attr: {
						style: "padding: 5px 10px;",
					},
				});

				// Event listeners
				columnInput.addEventListener("change", async () => {
					this.plugin.settings.kanbanColumnCheckboxMappings[index].columnName = columnInput.value;
					await this.plugin.saveSettings();
				});

				checkboxInput.addEventListener("change", async () => {
					this.plugin.settings.kanbanColumnCheckboxMappings[index].checkboxState = checkboxInput.value;
					await this.plugin.saveSettings();
				});

				deleteButton.addEventListener("click", async () => {
					this.plugin.settings.kanbanColumnCheckboxMappings.splice(index, 1);
					await this.plugin.saveSettings();
					this.display(); // Refresh the settings panel
				});
			});

			// Add new mapping button
			const addMappingButton = containerEl.createEl("button", {
				text: "Add Column Mapping",
				cls: "mod-cta",
				attr: {
					style: "margin: 10px 0;",
				},
			});

			addMappingButton.addEventListener("click", async () => {
				this.plugin.settings.kanbanColumnCheckboxMappings.push({
					columnName: "",
					checkboxState: "[ ]",
				});
				await this.plugin.saveSettings();
				this.display(); // Refresh the settings panel
			});

			// Reset to defaults button
			const resetButton = containerEl.createEl("button", {
				text: "Reset to Defaults",
				cls: "mod-warning",
				attr: {
					style: "margin: 10px 0;",
				},
			});

			resetButton.addEventListener("click", async () => {
				this.plugin.settings.kanbanColumnCheckboxMappings = [
					{ columnName: "Todo", checkboxState: "[ ]" },
					{ columnName: "In Progress", checkboxState: "[/]" },
					{ columnName: "Complete", checkboxState: "[x]" },
					{ columnName: "Done", checkboxState: "[x]" },
				];
				await this.plugin.saveSettings();
				this.display(); // Refresh the settings panel
			});
		}
	}
}

// Helper class for file picking
class FileSuggestModal extends SuggestModal<TFile> {
	plugin: TaskProgressBarPlugin;
	onChooseItem: (file: TFile) => void;

	constructor(app: App, plugin: TaskProgressBarPlugin) {
		super(app);
		this.plugin = plugin;
		this.onChooseItem = () => {}; // Default empty implementation
	}

	getSuggestions(query: string): TFile[] {
		const files = this.app.vault.getMarkdownFiles();
		// Filter to only show potential Kanban board files
		const kanbanFiles = files.filter((file) => {
			// Show all Markdown files when no query
			if (!query) return true;
			// Otherwise filter by name/path containing the query
			return file.path.toLowerCase().includes(query.toLowerCase());
		});
		return kanbanFiles;
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		el.createEl("div", { text: file.path });
	}

	// Implement the required abstract method
	onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
		if (this.onChooseItem) {
			this.onChooseItem(file);
		}
	}
}
