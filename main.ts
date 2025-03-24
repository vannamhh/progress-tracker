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
	SuggestModal  // Add this import
} from "obsidian";

// Define DataviewAPI interface
interface DataviewApi {
	executeJs(
		code: string,
		container: HTMLElement,
		sourcePath?: string
	): Promise<any>;
	page(path: string): any;
	pages(source: string): any[];
	// Not using eval as it might not exist in some Dataview versions
}

// Define window object interface to access Dataview plugin
declare global {
	interface Window {
		DataviewAPI?: DataviewApi;
	}
}

// Helper function to get Dataview API
function getDataviewAPI(app: App): DataviewApi | null {
	// Method 1: Through window object
	// @ts-ignore
	if (window.DataviewAPI) {
		return window.DataviewAPI;
	}

	// Method 2: Through app.plugins
	// @ts-ignore
	const dataviewPlugin = app.plugins?.plugins?.dataview;
	if (dataviewPlugin && dataviewPlugin.api) {
		return dataviewPlugin.api;
	}

	// Method 3: Check if plugin is enabled
	// @ts-ignore
	if (app.plugins.enabledPlugins.has("dataview")) {
		console.log("Dataview plugin is enabled but API is not available yet");
		return null;
	}

	console.log("Dataview plugin is not enabled");
	return null;
}

interface TaskProgressBarSettings {
	mySetting: string; // Appears unused - could be removed in the future
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
}

const DEFAULT_SETTINGS: TaskProgressBarSettings = {
	mySetting: "default",
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
	updateAnimationDelay: 300,
	editorChangeDelay: 500,
	keyboardInputDelay: 100,
	checkboxClickDelay: 200,
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
};

export default class TaskProgressBarPlugin extends Plugin {
	settings: TaskProgressBarSettings;
	dvAPI: DataviewApi | null = null;
	sidebarView: TaskProgressBarView | null = null;
	private lastActiveFile: TFile | null = null;
	private lastFileContent: string = "";
	private dataviewCheckInterval: number | null = null;

	async onload() {
		await this.loadSettings();

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

					// Always update when file changes to ensure accurate display
					setTimeout(async () => {
						await this.updateLastFileContent(file);
						if (this.sidebarView) {
							// Pass true to force update even for files without tasks
							this.sidebarView.updateProgressBar(file);
						}
					}, 300);
				}
			})
		);

		// Register event to update progress bar when editor changes
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				debounce(async (editor, view) => {
					if (view instanceof MarkdownView && this.sidebarView) {
						// Get current editor content
						const content = editor.getValue();

						// Check if content has changed and contains tasks or old content contains tasks
						if (
							content.includes("- [") ||
							content.includes("- [ ]") ||
							content.includes("- [x]") ||
							this.lastFileContent.includes("- [") ||
							this.lastFileContent.includes("- [ ]") ||
							this.lastFileContent.includes("- [x]")
						) {
							// Update immediately
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
						}
					}
				}, this.settings.editorChangeDelay)
			) // Use configurable delay
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
						if (
							content.includes("- [") ||
							content.includes("- [ ]") ||
							content.includes("- [x]")
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
					}, this.settings.keyboardInputDelay); // Use configurable delay
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

						// Update progress bar immediately
						this.lastActiveFile = activeFile;
						this.sidebarView.updateProgressBar(activeFile, content);

						// Then update last file content
						this.lastFileContent = content;
					}
				}, this.settings.checkboxClickDelay); // Use configurable delay
			}
		});

		// Activate view when plugin loads - wait a bit for Obsidian to fully start
		setTimeout(() => {
			this.activateView();

			// We'll use a single delayed update instead of multiple updates
			setTimeout(async () => {
				const currentFile = this.app.workspace.getActiveFile();
				if (currentFile && this.sidebarView) {
					if (this.settings.showDebugInfo) {
						console.log(
							"Initial file load after plugin start:",
							currentFile.path
						);
					}

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
			name: "Clear Completed Files Cache",
			callback: () => {
				if (this.sidebarView) {
					this.sidebarView.clearCompletedFilesCache();
					new Notice(
						"Completed files cache cleared. Files can trigger completion notifications again."
					);
				}
			},
		});
	}

	// Check Dataview API and set up interval to check again if not found
	checkDataviewAPI() {
		// Check immediately
		this.dvAPI = getDataviewAPI(this.app);

		// If not found, set up interval to check again
		if (!this.dvAPI) {
			this.dataviewCheckInterval = window.setInterval(() => {
				this.dvAPI = getDataviewAPI(this.app);
				if (this.dvAPI) {
					console.log("Dataview API found");
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

	// Update last file content
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
			if (!workspace.leftSplit) {
				console.log("Workspace not ready yet, retrying in 500ms");
				setTimeout(() => this.activateView(), 500);
				return;
			}

			// Use getLeaf instead of createLeaf
			const leaf = workspace.getLeftLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: "progress-tracker",
					active: true,
				});

				// Reveal the leaf
				workspace.revealLeaf(leaf);
			}
		} catch (error) {
			console.error("Error activating view:", error);
			new Notice(
				"Error activating Task Progress Bar view. Please try again later."
			);
		}
	}

	onunload() {
		// Clear interval if it exists
		if (this.dataviewCheckInterval) {
			clearInterval(this.dataviewCheckInterval);
			this.dataviewCheckInterval = null;
		}

		// Clear any in-memory data
		if (this.sidebarView) {
			this.sidebarView.clearCompletedFilesCache();
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

	// Improved method to apply the max-height style
	applyMaxTabsHeightStyle() {
		try {
			// Remove any existing style element first
			const existingStyle = document.getElementById(
				"progress-tracker-max-tabs-height"
			);
			if (existingStyle) {
				existingStyle.remove();
			}

			// Create a new style element
			const style = document.createElement("style");
			style.id = "progress-tracker-max-tabs-height";

			// Set the CSS rule with the user's preference
			style.textContent = `
				.workspace-tabs.mod-top.mod-top-right-space:not(.mod-top-left-space) {
					max-height: ${this.settings.maxTabsHeight} !important;
					transition: max-height 0.3s ease;
				}
			`;

			// Add the style to the document head
			document.head.appendChild(style);

			// Debug info
			if (this.settings.showDebugInfo) {
				console.log(
					`Applied max-tabs-height: ${this.settings.maxTabsHeight}`
				);
			}
		} catch (error) {
			console.error("Error applying max tabs height style:", error);
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
		return "Task Progress Bar";
	}

	getIcon(): string {
		return "bar-chart-horizontal";
	}

	async onOpen() {
		this.isVisible = true;
		this.initialLoadComplete = false;
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

		// For initial load, we'll wait for the main plugin to trigger the update
		// rather than trying to load here, to avoid duplicate loading issues
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
				if (!this.hasTasksInContent(content)) {
					// Only clear if not already showing "no tasks" message
					if (!progressContainer.querySelector(".no-tasks-message")) {
						progressContainer.empty();
						progressContainer.createEl("p", {
							text: "No tasks found in this file",
							cls: "no-tasks-message"
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

				if (!this.hasTasksInContent(fileContent)) {
					// Only clear if not already showing "no tasks" message
					if (!progressContainer.querySelector(".no-tasks-message")) {
						progressContainer.empty();
						progressContainer.createEl("p", {
							text: "No tasks found in this file",
							cls: "no-tasks-message"
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
	hasTasksInContent(content: string): boolean {
		// Improved and more accurate task detection
		const standardTaskRegex = /- \[[x ]\]/i;
		const relaxedTaskRegex = /[-*] \[[x ]\]/i;

		// Return true if either regex matches
		return (
			standardTaskRegex.test(content) || relaxedTaskRegex.test(content)
		);
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

			// Use more accurate regex to count tasks
			const incompleteTasks = (content.match(/- \[ \]/g) || []).length;
			const completedTasks = (content.match(/- \[x\]/gi) || []).length;
			let totalTasks = incompleteTasks + completedTasks;

			// Try with relaxed regex if needed
			let relaxedIncompleteTasks = 0;
			let relaxedCompletedTasks = 0;
			if (totalTasks === 0) {
				relaxedIncompleteTasks = (content.match(/[-*] \[ \]/g) || []).length;
				relaxedCompletedTasks = (content.match(/[-*] \[x\]/gi) || []).length;
				totalTasks = relaxedIncompleteTasks + relaxedCompletedTasks;
			}

			// Log task counts for debugging
			if (this.plugin.settings.showDebugInfo) {
				console.log(
					`Task counts - incomplete: ${incompleteTasks}, completed: ${completedTasks}, total: ${totalTasks}`
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
						cls: "no-tasks-message"
					});
				}
				return;
			}

			// Calculate percentage based on which regex found tasks
			let completedCount =
				incompleteTasks > 0 || completedTasks > 0
					? completedTasks
					: relaxedCompletedTasks;

			const percentage = Math.round((completedCount / totalTasks) * 100);

			// Update status based on progress percentage (do this for all files)
			let statusChanged = false;
			if (this.plugin.settings.autoChangeStatus) {
				statusChanged = await this.updateStatusBasedOnProgress(
					file,
					percentage
				);
			}

			// Update Kanban boards based on task progress, regardless of whether it's 100%
			// This ensures any status change gets reflected in the Kanban board
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
					await this.updateFileMetadata(file, content);

					// Mark this file as completed to avoid repeated updates
					this.completedFilesMap.set(file.path, true);
				}
			} else if (percentage < 100) {
				// If percentage is less than 100%, remove from completed files map
				// This allows re-notification if the tasks are completed again after being incomplete
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

			// Check if we already have progress elements
			let progressLayout = container.querySelector(".progress-layout") as HTMLElement;
			let statsContainer = container.querySelector(".progress-stats-compact") as HTMLElement;
			
			// If no existing elements, create container structure
			if (!progressLayout || !statsContainer) {
				container.empty();
				
				// Create a more compact layout
				progressLayout = container.createDiv({ cls: "progress-layout" });
				
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
			
			// Now update the existing elements with new values
			
			// Update percentage text
			const percentageElement = progressLayout.querySelector(".progress-percentage-small") as HTMLElement;
			if (percentageElement) {
				percentageElement.setText(`${percentage}%`);
			}
			
			// Update progress bar width with smooth transition
			const progressValue = container.querySelector(".progress-value") as HTMLElement;
			if (progressValue) {
				// Add transition style if not already present
				if (!progressValue.hasAttribute("data-has-transition")) {
					progressValue.style.transition = "width 0.3s ease-in-out, background-color 0.3s ease";
					progressValue.setAttribute("data-has-transition", "true");
				}
				progressValue.style.width = `${percentage}%`;
				this.applyProgressColor(progressValue, percentage);
			}
			
			// Update progress element data attribute
			const progressElement = container.querySelector(".progress-element") as HTMLElement;
			if (progressElement) {
				progressElement.setAttribute("data-percentage", percentage.toString());
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
				let debugInfo = container.querySelector(".debug-info") as HTMLElement;
				if (!debugInfo) {
					debugInfo = container.createDiv({ cls: "debug-info" });
				} else {
					debugInfo.empty();
				}
				
				debugInfo.createEl("p", { text: `Debug Info:` });
				debugInfo.createEl("p", { text: `File: ${this.currentFile?.path}` });
				debugInfo.createEl("p", { text: `Incomplete tasks: ${totalTasks - completedCount}` });
				debugInfo.createEl("p", { text: `Completed tasks: ${completedCount}` });
				debugInfo.createEl("p", { text: `Total tasks: ${totalTasks}` });
				debugInfo.createEl("p", { text: `Percentage: ${percentage}%` });
				debugInfo.createEl("p", { text: `Update time: ${new Date().toISOString()}` });
				debugInfo.createEl("p", { text: `Color scheme: ${this.plugin.settings.progressColorScheme}` });
			} else {
				// Remove debug info if it exists but debug is disabled
				const debugInfo = container.querySelector(".debug-info");
				if (debugInfo) debugInfo.remove();
			}
			
		} catch (error) {
			console.error("Error creating progress bar from string:", error);
			container.empty();
			container.createEl("p", {
				text: `Error creating progress bar: ${error.message}`,
			});
		}
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
			// Read the file content
			const content = await this.plugin.app.vault.read(file);

			// Check if file has YAML frontmatter
			const yamlRegex = /^---\s*\n([\s\S]*?)\n---/;
			const yamlMatch = content.match(yamlRegex);

			if (!yamlMatch) return false;

			let yaml = yamlMatch[1];
			let updatedYaml = yaml;
			let needsUpdate = false;

			// Determine target status based on progress percentage
			let targetStatus = this.plugin.settings.statusInProgress;

			if (progressPercentage === 0) {
				targetStatus = this.plugin.settings.statusTodo;
			} else if (progressPercentage === 100) {
				targetStatus = this.plugin.settings.statusCompleted;
			}

			// Check for existing status
			const statusRegex = /status\s*:\s*([^\n]+)/i;
			const statusMatch = yaml.match(statusRegex);
			const currentStatus = statusMatch ? statusMatch[1].trim() : null;

			// Update if status is different
			if (currentStatus !== targetStatus) {
				if (statusMatch) {
					// Replace existing status
					updatedYaml = updatedYaml.replace(
						statusRegex,
						`status: ${targetStatus}`
					);
				} else {
					// Add status if it doesn't exist
					updatedYaml =
						updatedYaml.trim() + `\nstatus: ${targetStatus}`;
				}
				needsUpdate = true;
			}

			// Remove finished date if progress is less than 100%
			if (
				progressPercentage < 100 &&
				this.plugin.settings.autoUpdateFinishedDate
			) {
				const finishedRegex = /finished\s*:\s*[^\n]+\n?/i;
				if (finishedRegex.test(updatedYaml)) {
					// Remove the finished date line entirely
					updatedYaml = updatedYaml.replace(finishedRegex, "");
					// Remove any extra newlines that might have been left
					updatedYaml = updatedYaml.replace(/\n\n+/g, "\n");
					updatedYaml = updatedYaml.trim();
					needsUpdate = true;

					if (this.plugin.settings.showDebugInfo) {
						console.log(
							`Removed finished date from file ${file.path} because progress is ${progressPercentage}%`
						);
					}
				}
			}

			// Update file if needed
			if (needsUpdate) {
				const updatedContent = content.replace(
					yamlRegex,
					`---\n${updatedYaml}\n---`
				);
				await this.plugin.app.vault.modify(file, updatedContent);

				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Updated status to "${targetStatus}" based on progress ${progressPercentage}% for file:`,
						file.path
					);
				}

				// Return true to indicate status was changed
				return true;
			}
		} catch (error) {
			console.error("Error updating status based on progress:", error);
		}

		return false; // Return false if no status change occurred
	}

	// New method to update file metadata when tasks are completed
	async updateFileMetadata(file: TFile, content: string) {
		try {
			// Check if file has YAML frontmatter
			const yamlRegex = /^---\s*\n([\s\S]*?)\n---/;
			const yamlMatch = content.match(yamlRegex);

			if (!yamlMatch) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(
						"No YAML frontmatter found in file:",
						file.path
					);
				}
				return;
			}

			let yaml = yamlMatch[1];
			let needsUpdate = false;
			let updatedYaml = yaml;
			// Define today's date at the beginning of the function so it's available throughout
			const today = new Date().toISOString().split("T")[0]; // Format: YYYY-MM-DD

			// Check for existing status
			const statusRegex = /status\s*:\s*([^\n]+)/i;
			const statusMatch = yaml.match(statusRegex);
			const currentStatus = statusMatch ? statusMatch[1].trim() : null;

			// Update status based on settings if enabled
			if (this.plugin.settings.autoChangeStatus) {
				const targetStatus = this.plugin.settings.statusCompleted;

				// Only update if the current status isn't already the completed status
				if (currentStatus !== targetStatus) {
					if (statusMatch) {
						// Replace existing status
						updatedYaml = updatedYaml.replace(
							statusRegex,
							`status: ${targetStatus}`
						);
						needsUpdate = true;
					} else {
						// Add status if it doesn't exist
						updatedYaml =
							updatedYaml.trim() + `\nstatus: ${targetStatus}`;
						needsUpdate = true;
					}

					if (this.plugin.settings.showDebugInfo) {
						console.log(
							`Updating status to ${targetStatus} in file:`,
							file.path
						);
					}
				}
			}

			// Update finished date functionality remains the same
			// Check if finished date already exists and matches today's date
			const finishedDateRegex = /finished\s*:\s*(\d{4}-\d{2}-\d{2})/i;
			const finishedDateMatch = yaml.match(finishedDateRegex);
			const finishedDateAlreadySet =
				finishedDateMatch && finishedDateMatch[1] === today;

			// Update finished date only if enabled and not already set to today's date
			if (
				this.plugin.settings.autoUpdateFinishedDate &&
				!finishedDateAlreadySet
			) {
				const finishedRegex = /(finished\s*:)\s*([^\n]*)/i;

				if (finishedRegex.test(yaml)) {
					// Replace existing finished date with proper spacing
					updatedYaml = updatedYaml.replace(
						finishedRegex,
						`$1 ${today}`
					);
					needsUpdate = true;
				} else {
					// Add finished date if it doesn't exist, ensuring proper spacing
					updatedYaml = updatedYaml.trim() + `\nfinished: ${today}`;
					needsUpdate = true;
				}

				if (this.plugin.settings.showDebugInfo) {
					console.log(
						`Updating finished date to ${today} in file:`,
						file.path
					);
				}
			}

			// Update file content if changes were made
			if (needsUpdate) {
				const updatedContent = content.replace(
					yamlRegex,
					`---\n${updatedYaml}\n---`
				);
				await this.plugin.app.vault.modify(file, updatedContent);
			}
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
		if (filePath.includes('.obsidian/plugins/progress-tracker') || 
			filePath.includes('kanban')) {
			if (this.plugin.settings.showDebugInfo) {
				console.log(`Skipping plugin or kanban file for kanban processing: ${file.path}`);
			}
			return 0;
		}

		// Get all markdown files that might be Kanban boards
		const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
		let updatedBoardCount = 0;

		// Check each potential Kanban board file
		for (const boardFile of markdownFiles) {
			// Skip checking the current file itself
			if (boardFile.path === file.path) continue;

			// Read the content of the potential Kanban board
			const boardContent = await this.plugin.app.vault.read(boardFile);

			// Skip if not a Kanban board or doesn't reference our file
			if (
				!this.isKanbanBoard(boardContent) ||
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

		// Check for common reference patterns
		const patterns = [
			// Markdown link: [Note Title](path/to/note.md)
			new RegExp(`\\[.*?\\]\\(${this.escapeRegExp(filePath)}\\)`, "i"),
			// Obsidian link: [[path/to/note]]
			new RegExp(
				`\\[\\[${this.escapeRegExp(
					filePathWithoutExtension
				)}(\\|.*?)?\\]\\]`,
				"i"
			),
			// Obsidian link with just filename: [[Note Title]]
			new RegExp(
				`\\[\\[${this.escapeRegExp(fileName)}(\\|.*?)?\\]\\]`,
				"i"
			),
			// Plain text mention of filepath
			new RegExp(`\\b${this.escapeRegExp(filePath)}\\b`, "i"),
			// Plain text mention of filename
			new RegExp(`\\b${this.escapeRegExp(fileName)}\\b`, "i"),
		];

		// Return true if any pattern matches
		return patterns.some((pattern) => pattern.test(boardContent));
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
			// Parse the Kanban board structure
			const kanbanColumns = this.parseKanbanBoard(boardContent);
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

			// Look for the card containing reference to our file in each column
			let cardMoved = false;
			let newContent = boardContent;

			// Build file reference pattern options for searching
			const filePath = fileToMove.path;
			const filePathWithoutExtension = filePath.replace(/\.md$/, "");
			const fileName = fileToMove.basename;

			// Patterns to match different kinds of file references in cards
			const fileRefPatterns = [
				`\\[.*?\\]\\(${this.escapeRegExp(filePath)}\\)`,
				`\\[\\[${this.escapeRegExp(
					filePathWithoutExtension
				)}(\\|.*?)?\\]\\]`,
				`\\[\\[${this.escapeRegExp(fileName)}(\\|.*?)?\\]\\]`,
				`\\b${this.escapeRegExp(filePath)}\\b`,
				`\\b${this.escapeRegExp(fileName)}\\b`,
			];

			// Join patterns with OR for combined search
			const fileRefRegex = new RegExp(fileRefPatterns.join("|"), "i");

			// Process each column
			for (const columnName in kanbanColumns) {
				// Skip the target column - we don't need to move items already there
				if (
					columnName.toLowerCase() === targetColumnName.toLowerCase()
				) {
					continue;
				}

				const column = kanbanColumns[columnName];

				// Check each card in the column
				for (let i = 0; i < column.items.length; i++) {
					const card = column.items[i];

					// Check if this card references our file
					if (fileRefRegex.test(card.text)) {
						if (this.plugin.settings.showDebugInfo) {
							console.log(
								`Found card in column "${columnName}" that references file ${fileToMove.path}`
							);
						}

						// Remove this card from its current position
						// Find this card's position in the file content
						const columnRegex = new RegExp(
							`## ${this.escapeRegExp(columnName)}\\s*\\n`
						);
						const columnMatch = newContent.match(columnRegex);

						if (!columnMatch) continue;

						const columnStart = columnMatch.index!;
						const columnHeaderEnd =
							columnStart + columnMatch[0].length;

						// Find the next column or the end of file
						const nextColumnRegex = /^## /gm;
						nextColumnRegex.lastIndex = columnHeaderEnd;
						const nextColumnMatch =
							nextColumnRegex.exec(newContent);
						const columnEnd = nextColumnMatch
							? nextColumnMatch.index
							: newContent.length;

						// Get this column's content
						const columnContent = newContent.substring(
							columnHeaderEnd,
							columnEnd
						);

						// Try to find the card in the column
						const cleanCardText = this.escapeRegExp(
							card.text.trim()
						);
						const cardRegex = new RegExp(
							`(^|\\n)(${cleanCardText})(\\n|$)`
						);
						const cardMatch = columnContent.match(cardRegex);

						if (!cardMatch) {
							if (this.plugin.settings.showDebugInfo) {
								console.log(
									`Could not find card in column ${columnName}`
								);
							}
							continue;
						}

						// Calculate absolute positions in the whole content
						const cardStart =
							columnHeaderEnd +
							cardMatch.index! +
							(cardMatch[1] === "\n" ? 1 : 0);
						const cardEnd = cardStart + card.text.length;

						// Safety check - don't remove a card if our indices are wrong
						if (
							cardEnd <= cardStart ||
							cardStart < 0 ||
							cardEnd > newContent.length
						) {
							console.error(
								`Invalid card position: start=${cardStart}, end=${cardEnd}, contentLength=${newContent.length}`
							);
							continue;
						}

						// Remove this card from its current column
						const beforeCard = newContent.substring(0, cardStart);
						const afterCard = newContent.substring(cardEnd);

						// Handle newlines correctly
						newContent = beforeCard + afterCard;

						// Find the target column
						const targetColumnRegex = new RegExp(
							`## ${this.escapeRegExp(targetColumnName)}\\s*\\n`
						);
						const targetColumnMatch =
							newContent.match(targetColumnRegex);

						if (!targetColumnMatch) continue;

						const targetInsertPosition =
							targetColumnMatch.index! +
							targetColumnMatch[0].length;

						// Insert the card at the beginning of the target column
						newContent =
							newContent.substring(0, targetInsertPosition) +
							card.text +
							"\n" +
							newContent.substring(targetInsertPosition);

						cardMoved = true;

						if (this.plugin.settings.showDebugInfo) {
							console.log(
								`Moved card for ${fileToMove.path} from "${columnName}" to "${targetColumnName}" in ${boardFile.path}`
							);
						}

						// Break once we've found and moved the card
						break;
					}
				}

				// If we've moved the card, no need to check other columns
				if (cardMoved) break;
			}

			// Update the file if changes were made
			if (cardMoved && newContent !== boardContent) {
				await this.plugin.app.vault.modify(boardFile, newContent);
				return newContent;
			}

			return boardContent;
		} catch (error) {
			console.error("Error moving card in Kanban board:", error);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			return boardContent;
		}
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
		try {
			const content = await this.plugin.app.vault.read(file);
			const yamlRegex = /^---\s*\n([\s\S]*?)\n---/;
			const yamlMatch = content.match(yamlRegex);

			if (!yamlMatch) return null;

			const yaml = yamlMatch[1];
			const statusRegex = /status\s*:\s*([^\n]+)/i;
			const statusMatch = yaml.match(statusRegex);

			if (statusMatch) {
				return statusMatch[1].trim();
			}
		} catch (error) {
			console.error("Error getting status from YAML:", error);
		}

		return null;
	}

	/**
	 * Parse Kanban board structure into columns and items with improved accuracy
	 */
	private parseKanbanBoard(
		content: string
	): Record<string, { items: Array<{ text: string }> }> {
		const kanban: Record<string, { items: Array<{ text: string }> }> = {};

		// Check if this is a Kanban plugin file by looking for the YAML marker
		const isKanbanPlugin = content.includes("---\n\nkanban-plugin: basic");

		// Split content by H2 headers to get columns
		const columnHeaders = content.match(/^## .+$/gm) || [];

		if (columnHeaders.length < 1) {
			return kanban;
		}

		// Extract content between column headers
		for (let i = 0; i < columnHeaders.length; i++) {
			const columnHeader = columnHeaders[i];
			const columnName = columnHeader.substring(3).trim();

			// Find the start position of this column
			const columnStart = content.indexOf(columnHeader);
			if (columnStart === -1) continue;

			// Find the end position of this column (start of next column or end of file)
			const nextColumnStart =
				i < columnHeaders.length - 1
					? content.indexOf(
							columnHeaders[i + 1],
							columnStart + columnHeader.length
					  )
					: content.length;

			// Extract column content
			const columnContent = content
				.substring(columnStart + columnHeader.length, nextColumnStart)
				.trim();

			kanban[columnName] = { items: [] };

			// Extract items from column content
			if (isKanbanPlugin) {
				// For Kanban plugin format
				this.extractKanbanPluginItems(
					columnContent,
					kanban[columnName].items
				);
			} else {
				// For regular markdown format
				this.extractMarkdownItems(
					columnContent,
					kanban[columnName].items
				);
			}
		}

		if (this.plugin.settings.showDebugInfo) {
			console.log(
				"Parsed Kanban board with columns:",
				Object.keys(kanban)
			);
			Object.entries(kanban).forEach(([column, data]) => {
				console.log(
					`Column "${column}" has ${data.items.length} items`
				);
			});
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
	private isKanbanBoard(content: string): boolean {
		// Look for specific indicators of a Kanban board

		// Check for Kanban plugin metadata marker
		if (content.includes("---\n\nkanban-plugin: basic")) {
			return true;
		}

		// Check for typical Kanban structure - multiple columns with tasks
		// Must have at least 2 columns with headers like "## Todo", "## In Progress", "## Done", etc.
		const kanbanColumnHeaders = content.match(/^## .+?$/gm) || [];
		if (kanbanColumnHeaders.length < 2) {
			return false;
		}

		// Column names typically used in Kanban boards
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
			"on hold",
			"review",
		];

		// Check if at least one column name matches common Kanban terminology
		let foundKanbanName = false;
		for (const header of kanbanColumnHeaders) {
			const columnName = header.substring(3).toLowerCase().trim();
			if (commonKanbanNames.some((name) => columnName.includes(name))) {
				foundKanbanName = true;
				break;
			}
		}

		// Check for column with our target name specifically
		const targetColumnExists = kanbanColumnHeaders.some(
			(header) =>
				header.substring(3).toLowerCase().trim() ===
				this.plugin.settings.kanbanCompletedColumn.toLowerCase()
		);

		// If we find our target column name, it's very likely this is a Kanban board
		if (targetColumnExists) {
			return true;
		}

		// Check for items (-) within columns
		// Split content by headers
		const sections = content.split(/^## /m).slice(1);
		let hasItems = false;

		for (const section of sections) {
			// Check for list items within the section
			if (section.match(/^- .+/m)) {
				hasItems = true;
				break;
			}
		}

		// For a file to be considered a Kanban board:
		// 1. Must have at least 2 column headers
		// 2. Must either have common Kanban column names OR have items in columns
		return kanbanColumnHeaders.length >= 2 && (foundKanbanName || hasItems);
	}

	/**
	 * Add a file to the specified Kanban board if it's not already there
	 */
	async addFileToKanbanBoard(file: TFile): Promise<boolean> {
		try {
			// Skip if auto-add setting is disabled or board path is empty
			if (!this.plugin.settings.autoAddToKanban || !this.plugin.settings.autoAddKanbanBoard) {
				return false;
			}

				// Skip plugin files and Kanban board files to avoid self-reference
			const filePath = file.path.toLowerCase();
			if (filePath.includes('.obsidian/plugins/progress-tracker') || 
				filePath.includes('kanban') || 
				filePath === this.plugin.settings.autoAddKanbanBoard) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Skipping plugin or kanban file: ${file.path}`);
				}
				return false;
			}

			// Get the Kanban board file
			const boardPath = this.plugin.settings.autoAddKanbanBoard;
			const kanbanFile = this.plugin.app.vault.getAbstractFileByPath(boardPath);
			
			if (!kanbanFile || !(kanbanFile instanceof TFile)) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Could not find Kanban board at path: ${boardPath}`);
				}
				return false;
			}

				// Skip if trying to add the kanban board to itself
			if (file.path === kanbanFile.path) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Skipping adding kanban board to itself: ${file.path}`);
				}
				return false;
			}

			// Read the board content
			const boardContent = await this.plugin.app.vault.read(kanbanFile as TFile);
			
			// Skip if this is not a Kanban board
			if (!this.isKanbanBoard(boardContent)) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`File at path ${boardPath} is not a Kanban board`);
				}
				return false;
			}
			
			// Check if the file is already referenced in the board
			if (this.containsFileReference(boardContent, file)) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`File ${file.path} is already in Kanban board ${boardPath}`);
				}
				return false;
			}
			
			// Get the target column name
			const targetColumn = this.plugin.settings.autoAddKanbanColumn || "Todo";
			
			// Parse the Kanban board to find the column
			const kanbanColumns = this.parseKanbanBoard(boardContent);
			if (!kanbanColumns || Object.keys(kanbanColumns).length === 0) {
				if (this.plugin.settings.showDebugInfo) {
					console.log(`Could not parse Kanban board structure in ${boardPath}`);
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
			const cardText = `- [[${file.basename}]]\n`;
			
			// Insert the card
			const newContent = 
				boardContent.substring(0, insertPosition) +
				cardText +
				boardContent.substring(insertPosition);
			
			// Update the file
			await this.plugin.app.vault.modify(kanbanFile as TFile, newContent);
			
			// Show notice
			new Notice(`Added ${file.basename} to "${targetColumnName}" column in ${kanbanFile.basename}`);
			
			return true;
		} catch (error) {
			console.error("Error adding file to Kanban board:", error);
			if (this.plugin.settings.showDebugInfo) {
				console.error("Error details:", error);
			}
			return false;
		}
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

		containerEl.createEl("h2", { text: "Task Progress Bar Settings" });

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

		// General settings section
		containerEl.createEl("h3", { text: "General Settings" });

		new Setting(containerEl)
			.setName("Setting")
			.setDesc("Description of the setting")
			.addText((text) =>
				text
					.setPlaceholder("Enter your setting")
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show Debug Info")
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
		containerEl.createEl("h3", { text: "Animation Settings" });

		// Add new setting for animation
		new Setting(containerEl)
			.setName("Show Update Animation")
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
		containerEl.createEl("h3", { text: "Performance Settings" });

		new Setting(containerEl)
			.setName("Editor Change Delay")
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
			.setName("Keyboard Input Delay")
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
			.setName("Checkbox Click Delay")
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
		containerEl.createEl("h3", { text: "Progress Bar Colors" });

		new Setting(containerEl)
			.setName("Color Scheme")
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
				.setName("Low Progress Color")
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
				.setName("Medium Progress Color")
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
				.setName("High Progress Color")
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
				.setName("Complete Progress Color")
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
				.setName("Low Progress Threshold")
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
				.setName("Medium Progress Threshold")
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
				.setName("High Progress Threshold")
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
		containerEl.createEl("h3", { text: "Interface Settings" });

		// Fix the Max Tabs Height setting to allow proper input
		new Setting(containerEl)
			.setName("Max Tabs Height")
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
		containerEl.createEl("h3", { text: "Metadata Auto-Update" });

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
					.setName("Todo Status Label")
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
					.setName("In Progress Status Label")
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
					.setName("Completed Status Label")
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
			containerEl.createEl("h3", { text: "Kanban Integration" });

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
						.setName("Completed Column Name")
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
				.setDesc("The path to the Kanban board where files should be added")
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
				attr: { style: "margin-left: 36px; margin-bottom: 8px;" }
			});

			const filePickerContainer = containerEl.createEl("div", {
				attr: { style: "margin-left: 36px; margin-bottom: 12px;" }
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
					new Notice("Error opening file picker. Please enter the path manually.");
					console.error("File picker error:", error);
				}
			});

			new Setting(containerEl)
				.setName("Target column")
				.setDesc("The column where new files should be added (e.g., 'Todo', 'Backlog')")
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
    const kanbanFiles = files.filter(file => {
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
