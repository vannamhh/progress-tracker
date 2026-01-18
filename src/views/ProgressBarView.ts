import {
	App,
	WorkspaceLeaf,
	TFile,
	ItemView,
	Notice,
} from "obsidian";
import { TaskProgressBarSettings } from "../interfaces/settings";
import { DataviewApi, KanbanBoard } from "../interfaces/types";
import { DebugLogger } from "../utils/logger";
import { escapeRegExp, extractObsidianLinks, extractMarkdownLinks } from "../utils/helpers";

/**
 * Progress bar view that displays task completion status in the sidebar
 */
export class TaskProgressBarView extends ItemView {
	private settings: TaskProgressBarSettings;
	private logger: DebugLogger;
	private dvAPI: DataviewApi | null = null;
	currentFile: TFile | null = null;
	isVisible: boolean = false;
	lastUpdateTime: number = 0;
	lastFileUpdateMap: Map<string, number> = new Map();
	initialLoadComplete: boolean = false;
	completedFilesMap: Map<string, boolean> = new Map();

	// Callbacks for plugin integration
	private onKanbanBoardsUpdate: ((file: TFile, completedTasks: number, totalTasks: number) => Promise<void>) | null = null;
	private isKanbanBoardFn: ((file: TFile) => boolean) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		_app: App, // app is provided by caller but we use this.app from ItemView
		settings: TaskProgressBarSettings,
		logger: DebugLogger,
		dvAPI: DataviewApi | null
	) {
		super(leaf);
		// Note: this.app is already set by super(leaf) from ItemView
		this.settings = settings;
		this.logger = logger;
		this.dvAPI = dvAPI;
	}

	/**
	 * Update settings reference
	 */
	updateSettings(settings: TaskProgressBarSettings): void {
		this.settings = settings;
	}

	/**
	 * Update Dataview API reference
	 */
	updateDataviewAPI(dvAPI: DataviewApi | null): void {
		this.dvAPI = dvAPI;
	}

	/**
	 * Set callback for Kanban boards update
	 */
	setKanbanBoardsUpdateCallback(callback: (file: TFile, completedTasks: number, totalTasks: number) => Promise<void>): void {
		this.onKanbanBoardsUpdate = callback;
	}

	/**
	 * Set isKanbanBoard function reference
	 */
	setIsKanbanBoardFn(fn: (file: TFile) => boolean): void {
		this.isKanbanBoardFn = fn;
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

		// Also try to add class to parent element directly
		const parentLeaf = this.containerEl.closest(".workspace-leaf");
		if (parentLeaf) {
			parentLeaf.addClass("progress-tracker-leaf");
		}

		const container = this.containerEl.children[1];
		container.empty();

		// Create progress container
		const progressContainer = container.createDiv({
			cls: "task-progress-container",
		});

		// Add loading indicator
		progressContainer.createEl("p", {
			text: "Loading task progress...",
			cls: "loading-indicator",
		});

		// Trigger initial update after a short delay
		setTimeout(async () => {
			const currentFile = this.app.workspace.getActiveFile();
			if (currentFile) {
				await this.updateProgressBar(currentFile, undefined, true);
			}
		}, 200);
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
		if (isInitialLoad || !this.initialLoadComplete) {
			progressContainer.empty();
			this.initialLoadComplete = true;
		}

		// Add class to show animation only when showUpdateAnimation setting is enabled
		if (this.settings.showUpdateAnimation) {
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
				const fileContent = await this.app.vault.read(file);

				if (!this.hasTasksInContentExtended(fileContent)) {
					// Only clear if not already showing "no tasks" message
					if (!progressContainer.querySelector(".no-tasks-message")) {
						progressContainer.empty();
						progressContainer.createEl("p", {
							text: "No tasks found in this file",
							cls: "no-tasks-message",
						});
					}
					this.logger.log("No tasks found in file:", file.path);
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
				text: `Error updating progress bar: ${(error as Error).message}`,
			});
		} finally {
			// Remove class after update completes, only if animation is enabled
			if (this.settings.showUpdateAnimation) {
				setTimeout(() => {
					progressContainer.classList.remove("updating");
				}, this.settings.updateAnimationDelay);
			}
		}
	}

	/**
	 * Helper method to quickly check if content has tasks
	 */
	hasTasksInContentExtended(content: string): boolean {
		// Extended pattern to match custom checkbox states
		const extendedTaskRegex = /- \[[^\]]*\]/i;
		return extendedTaskRegex.test(content);
	}

	/**
	 * Method to create progress bar from string content
	 */
	async createProgressBarFromString(
		container: HTMLElement,
		content: string,
		file: TFile
	) {
		try {
			this.logger.log(`Creating progress bar for file: ${file.path}`);
			this.logger.log(`Content length: ${content.length}`);

			// Get Dataview API - only check for warning display
			if (!this.dvAPI) {
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

			if (this.settings.enableCustomCheckboxStates) {
				// When custom checkbox states are enabled, use enhanced counting
				const taskCounts = this.countTasksByCheckboxState(content);

				// Count standard states
				incompleteTasks = taskCounts[" "] || 0; // [ ]
				completedTasks = taskCounts["x"] || 0; // [x]

				// Count all custom states as tasks in progress
				for (const [state, count] of Object.entries(taskCounts)) {
					if (state !== " " && state !== "x" && state.trim() !== "") {
						customStateTasks += count;
					}
				}

				this.logger.log("Custom checkbox state counts:", taskCounts);
				this.logger.log(
					`Incomplete: ${incompleteTasks}, Completed: ${completedTasks}, Custom states: ${customStateTasks}`
				);
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
				relaxedIncompleteTasks = (content.match(/[-*] \[ \]/g) || []).length;
				relaxedCompletedTasks = (content.match(/[-*] \[x\]/gi) || []).length;
				totalTasks = relaxedIncompleteTasks + relaxedCompletedTasks;
			}

			this.logger.log(
				`Task counts - incomplete: ${incompleteTasks}, completed: ${completedTasks}, custom states: ${customStateTasks}, total: ${totalTasks}`
			);

			if (totalTasks === 0) {
				// No tasks found, show message
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
			this.updateProgressBarUI(
				container,
				percentage,
				completedCount,
				totalTasks
			);

			// Then process status and Kanban updates asynchronously
			this.processStatusAndKanbanUpdates(
				file,
				percentage,
				completedCount,
				totalTasks
			);
		} catch (error) {
			console.error("Error creating progress bar from string:", error);
			container.empty();
			container.createEl("p", {
				text: `Error creating progress bar: ${(error as Error).message}`,
			});
		}
	}

	/**
	 * Update UI elements first for better responsiveness
	 */
	private updateProgressBarUI(
		container: HTMLElement,
		percentage: number,
		completedCount: number,
		totalTasks: number
	) {
		// Check if we already have progress elements
		let progressLayout = container.querySelector(".progress-layout") as HTMLElement;
		let statsContainer = container.querySelector(".progress-stats-compact") as HTMLElement;

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
		if (this.settings.showDebugInfo) {
			let debugInfo = container.querySelector(".debug-info") as HTMLElement;
			if (!debugInfo) {
				debugInfo = container.createDiv({ cls: "debug-info" });
			} else {
				debugInfo.empty();
			}

			debugInfo.createEl("p", { text: `Debug info:` });
			debugInfo.createEl("p", { text: `File: ${this.currentFile?.path}` });
			debugInfo.createEl("p", { text: `Incomplete tasks: ${totalTasks - completedCount}` });
			debugInfo.createEl("p", { text: `Completed tasks: ${completedCount}` });
			debugInfo.createEl("p", { text: `Total tasks: ${totalTasks}` });
			debugInfo.createEl("p", { text: `Percentage: ${percentage}%` });
			debugInfo.createEl("p", { text: `Update time: ${new Date().toISOString()}` });
			debugInfo.createEl("p", { text: `Color scheme: ${this.settings.progressColorScheme}` });
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
				if (this.settings.autoChangeStatus) {
					statusChanged = await this.updateStatusBasedOnProgress(file, percentage);
				}

				// Update Kanban boards based on task progress
				if (
					this.settings.autoUpdateKanban &&
					(statusChanged || !this.completedFilesMap.has(file.path))
				) {
					await this.updateKanbanBoards(file, completedCount, totalTasks);
				}

				// Additional special handling for 100% completion
				if (percentage === 100 && this.settings.autoUpdateMetadata) {
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
					this.settings.autoAddToKanban &&
					this.settings.autoAddKanbanBoard &&
					totalTasks > 0 &&
					!this.completedFilesMap.has(file.path)
				) {
					await this.addFileToKanbanBoard(file);
				}
			} catch (error) {
				console.error("Error in status and Kanban updates:", error);
				this.logger.error("Error details:", error as Error);
			}
		}, 0);
	}

	/**
	 * Apply color based on percentage and settings
	 */
	applyProgressColor(progressElement: HTMLElement, percentage: number) {
		const settings = this.settings;

		// If using default color scheme, let CSS handle it
		if (settings.progressColorScheme === "default") {
			progressElement.style.backgroundColor = "";
			return;
		}

		// Apply custom color based on percentage
		let newColor = "";
		if (percentage === 100) {
			newColor = settings.completeProgressColor;
		} else if (percentage >= settings.mediumProgressThreshold) {
			newColor = settings.highProgressColor;
		} else if (percentage >= settings.lowProgressThreshold) {
			newColor = settings.mediumProgressColor;
		} else {
			newColor = settings.lowProgressColor;
		}

		// Only update if color has changed
		if (progressElement.style.backgroundColor !== newColor) {
			progressElement.style.backgroundColor = newColor;
		}

		this.logger.log(`Applied color for ${percentage}%: 
			Color scheme: ${settings.progressColorScheme},
			Low threshold: ${settings.lowProgressThreshold}%, 
			Medium threshold: ${settings.mediumProgressThreshold}%, 
			High threshold: ${settings.highProgressThreshold}%,
			Applied color: ${newColor}`);
	}

	/**
	 * Clear the completed files cache
	 */
	clearCompletedFilesCache() {
		this.completedFilesMap.clear();
		this.logger.log("Cleared completed files cache");
	}

	/**
	 * Update status based on progress percentage
	 */
	async updateStatusBasedOnProgress(
		file: TFile,
		progressPercentage: number
	): Promise<boolean> {
		if (!file || !this.settings.autoChangeStatus) return false;

		try {
			let needsUpdate = false;

			// Determine target status based on progress percentage
			let targetStatus = this.settings.statusInProgress;
			if (progressPercentage === 0) {
				targetStatus = this.settings.statusTodo;
			} else if (progressPercentage === 100) {
				targetStatus = this.settings.statusCompleted;
			}

			// Use processFrontMatter API to update frontmatter
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				// Check current status
				const currentStatus = frontmatter["status"];

				// Update if status is different
				if (currentStatus !== targetStatus) {
					frontmatter["status"] = targetStatus;
					needsUpdate = true;
				}

				// Remove finished date if progress is less than 100%
				if (progressPercentage < 100 && this.settings.autoUpdateFinishedDate) {
					if (frontmatter["finished"]) {
						delete frontmatter["finished"];
						needsUpdate = true;
					}
				}
			});

			if (needsUpdate) {
				this.logger.log(
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

	/**
	 * Update file metadata when tasks are completed
	 */
	async updateFileMetadata(file: TFile) {
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				let needsUpdate = false;
				const today = new Date().toISOString().split("T")[0];

				// Update status if enabled
				if (this.settings.autoChangeStatus) {
					const targetStatus = this.settings.statusCompleted;
					if (frontmatter["status"] !== targetStatus) {
						frontmatter["status"] = targetStatus;
						needsUpdate = true;
						this.logger.log(
							`Updating status to ${targetStatus} in file:`,
							file.path
						);
					}
				}

				// Update finished date if enabled
				if (this.settings.autoUpdateFinishedDate) {
					if (frontmatter["finished"] !== today) {
						frontmatter["finished"] = today;
						needsUpdate = true;
						this.logger.log(
							`Updating finished date to ${today} in file:`,
							file.path
						);
					}
				}

				return needsUpdate;
			});
		} catch (error) {
			console.error("Error updating file metadata:", error);
			new Notice(`Error updating metadata for ${file.basename}: ${(error as Error).message}`);
		}
	}

	/**
	 * Handle Kanban board integration with files
	 */
	async updateKanbanBoards(
		file: TFile,
		completedTasks: number,
		totalTasks: number
	) {
		try {
			// Only proceed if Kanban integration is enabled
			if (!this.settings.autoUpdateKanban || totalTasks === 0) {
				return;
			}

			// Use the callback if available
			if (this.onKanbanBoardsUpdate) {
				await this.onKanbanBoardsUpdate(file, completedTasks, totalTasks);
				return;
			}

			// Calculate the current status based on progress
			let currentStatus = this.calculateStatusFromProgress(completedTasks, totalTasks);

			// Wait for MetadataCache to update
			await this.waitForCacheUpdate(file);
			
			// Get status from YAML frontmatter if available
			let statusFromYaml = await this.getStatusFromYaml(file);
			if (statusFromYaml) {
				currentStatus = statusFromYaml;
				this.logger.log(
					`Using status from YAML: ${currentStatus} instead of calculated status`
				);
			}

			this.logger.log(
				`Searching for Kanban boards that might contain ${file.path}...`
			);
			this.logger.log(
				`Current status is: ${currentStatus} (${completedTasks}/${totalTasks} tasks)`
			);

			// Get and process Kanban boards
			const updatedBoardCount = await this.processKanbanBoards(file, currentStatus);

			if (updatedBoardCount > 0) {
				new Notice(
					`Updated ${updatedBoardCount} Kanban board${
						updatedBoardCount > 1 ? "s" : ""
					} to move ${file.basename} to ${currentStatus} column`
				);
			}
		} catch (error) {
			console.error("Error updating Kanban boards:", error);
			this.logger.error("Error details:", error as Error);
			new Notice(`Error updating Kanban boards: ${(error as Error).message}`);
		}
	}

	/**
	 * Calculate status based on task progress
	 */
	private calculateStatusFromProgress(completedTasks: number, totalTasks: number): string {
		if (totalTasks === 0) {
			return this.settings.statusTodo;
		} else if (completedTasks === 0) {
			return this.settings.statusTodo;
		} else if (completedTasks === totalTasks) {
			return this.settings.statusCompleted;
		} else {
			return this.settings.statusInProgress;
		}
	}

	/**
	 * Process all Kanban boards that might reference the target file
	 */
	private async processKanbanBoards(file: TFile, currentStatus: string): Promise<number> {
		// Skip plugin files and obvious Kanban files
		const filePath = file.path.toLowerCase();
		const configDir = this.app.vault.configDir.toLowerCase();
		if (
			filePath.includes(`${configDir}/plugins/progress-tracker`) ||
			filePath.includes("kanban")
		) {
			this.logger.log(`Skipping plugin or kanban file for kanban processing: ${file.path}`);
			return 0;
		}

		let updatedBoardCount = 0;

		// If there is a target board selected in settings, only process that board
		if (this.settings.autoAddKanbanBoard) {
			const targetBoard = this.app.vault.getAbstractFileByPath(
				this.settings.autoAddKanbanBoard
			);

			if (targetBoard instanceof TFile) {
				// Skip if trying to update the target file itself
				if (targetBoard.path === file.path) {
					this.logger.log(
						`Skipping target board as it's the file being updated: ${file.path}`
					);
					return 0;
				}

				// Read and process the target board
				const boardContent = await this.app.vault.read(targetBoard);

				// Skip if not a Kanban board or doesn't reference our file
				if (!this.isKanbanBoard(targetBoard) || !this.containsFileReference(boardContent, file)) {
					this.logger.log(
						`Target board ${targetBoard.path} is not a valid Kanban board or doesn't reference ${file.path}`
					);
					return 0;
				}

				this.logger.log(`Processing target Kanban board: ${targetBoard.path}`);

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
				this.logger.log(`Target board not found: ${this.settings.autoAddKanbanBoard}`);
				return 0;
			}
		}

		// If no target board is set, search all possible boards
		this.logger.log(`No target board set, searching all potential Kanban boards...`);

		// Get all markdown files that might be Kanban boards
		const markdownFiles = this.app.vault.getMarkdownFiles();

		// Check each potential Kanban board file
		for (const boardFile of markdownFiles) {
			// Skip checking the current file itself
			if (boardFile.path === file.path) continue;

			// Read the content of the potential Kanban board
			const boardContent = await this.app.vault.read(boardFile);

			// Skip if not a Kanban board or doesn't reference our file
			if (!this.isKanbanBoard(boardFile) || !this.containsFileReference(boardContent, file)) continue;

			this.logger.log(`Found Kanban board "${boardFile.path}" that references "${file.path}"`);

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
	 * Check if content appears to be a Kanban board
	 */
	private isKanbanBoard(file: TFile): boolean {
		// Use callback if available
		if (this.isKanbanBoardFn) {
			return this.isKanbanBoardFn(file);
		}

		try {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (!fileCache) {
				this.logger.log(`No cache found for file: ${file.path}`);
				return false;
			}

			// Check for Kanban plugin frontmatter
			if (fileCache.frontmatter?.["kanban-plugin"] === "basic") {
				this.logger.log(`Detected Kanban plugin board: ${file.path}`);
				return true;
			}

			// Check for Kanban-like structure via headers
			const headers = fileCache.headings || [];
			if (headers.length < 2) {
				this.logger.log(`Insufficient headers in file: ${file.path}`);
				return false;
			}

			const commonKanbanNames = [
				"todo", "to do", "to-do", "backlog", "new", "ideas", "inbox",
				"in progress", "doing", "working", "current", "ongoing",
				"done", "complete", "completed", "finished", "blocked", "waiting"
			];

			let kanbanColumnCount = 0;
			const completedColumnLower = this.settings.kanbanCompletedColumn.toLowerCase();

			for (const header of headers) {
				if (header.level !== 2) continue;
				const columnName = header.heading.toLowerCase();

				if (
					commonKanbanNames.some((name) => columnName.includes(name)) ||
					columnName === completedColumnLower
				) {
					kanbanColumnCount++;
				}
			}

			const isKanban = kanbanColumnCount >= 2;
			this.logger.log(
				`File ${file.path} is ${isKanban ? "" : "not "}a Kanban board ` +
				`(columns detected: ${kanbanColumnCount})`
			);

			return isKanban;
		} catch (error) {
			console.error(`Error checking if ${file.path} is a Kanban board:`, error);
			return false;
		}
	}

	/**
	 * Check if a Kanban board content contains a reference to the given file
	 */
	private containsFileReference(boardContent: string, file: TFile): boolean {
		const filePath = file.path;
		const filePathWithoutExtension = filePath.replace(/\.md$/, "");
		const fileName = file.basename;

		// First try to find exact matches in Obsidian-style links
		const obsidianLinks = extractObsidianLinks(boardContent);
		for (const link of obsidianLinks) {
			const { path } = link;
			if (path === fileName || path === filePathWithoutExtension || path === filePath) {
				this.logger.log(`Found exact Obsidian link match for ${fileName}: ${path}`);
				return true;
			}
		}

		// Then check for Markdown-style links
		const markdownLinks = extractMarkdownLinks(boardContent);
		for (const link of markdownLinks) {
			const { url } = link;
			if (url === filePath || url === filePathWithoutExtension) {
				this.logger.log(`Found exact Markdown link match for ${fileName}: ${url}`);
				return true;
			}
		}

		// Finally check for exact filepath mentions
		const filepathPattern = new RegExp(
			`(?:^|\\s|\\()${escapeRegExp(filePath)}(?:$|\\s|\\))`,
			"i"
		);
		if (filepathPattern.test(boardContent)) {
			this.logger.log(`Found exact filepath match for ${filePath}`);
			return true;
		}

		return false;
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
				this.logger.log(`Could not parse Kanban board structure in ${boardFile.path}`);
				return boardContent;
			}

			// Determine the target column name based on settings
			let targetColumnName: string | undefined;

			if (this.settings.kanbanSyncWithStatus) {
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
				// Legacy behavior: When not syncing, use the completed column setting
				if (targetStatus === this.settings.statusCompleted) {
					targetColumnName = Object.keys(kanbanColumns).find(
						(name) =>
							name.toLowerCase() ===
							this.settings.kanbanCompletedColumn.toLowerCase()
					);
				}
			}

			// If no matching column found, log and return original content
			if (!targetColumnName) {
				this.logger.log(
					`Could not find column for status "${targetStatus}" in Kanban board ${boardFile.path}`
				);
				this.logger.log(`Available columns: ${Object.keys(kanbanColumns).join(", ")}`);
				return boardContent;
			}

			this.logger.log(`Target column for status "${targetStatus}" is "${targetColumnName}"`);

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
				if (this.settings.enableCustomCheckboxStates && targetColumnName) {
					const columnName = targetColumnName;
					cardLines = cardLines.map((line) => {
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

					this.logger.log(
						`Moved card for ${fileToMove.path} to column "${targetColumnName}" in ${boardFile.path}`
					);
					if (this.settings.enableCustomCheckboxStates) {
						const targetCheckboxState = this.getCheckboxStateForColumn(targetColumnName);
						this.logger.log(`Applied checkbox state "${targetCheckboxState}" to card`);
					}
				}
			}

			// If card was moved, update the file
			if (cardMoved) {
				newContent = lines.join("\n");
				await this.app.vault.modify(boardFile, newContent);
			}

			return newContent;
		} catch (error) {
			console.error("Error moving card in Kanban board:", error);
			return boardContent;
		}
	}

	/**
	 * Get the complete content of a card, including any sub-items
	 */
	private getCompleteCardContent(
		lines: string[],
		startIndex: number
	): { content: string; lineCount: number } {
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
		const obsidianLinks = extractObsidianLinks(cardContent);
		const markdownLinks = extractMarkdownLinks(cardContent);

		const fileName = file.basename;
		const filePath = file.path;
		const filePathWithoutExtension = filePath.replace(/\.md$/, "");

		// Check Obsidian links first
		for (const link of obsidianLinks) {
			const { path } = link;
			if (path === fileName || path === filePathWithoutExtension || path === filePath) {
				this.logger.log(`Found exact Obsidian link match in card: ${path} for file: ${fileName}`);
				return true;
			}
		}

		// Then check Markdown links
		for (const link of markdownLinks) {
			const { url } = link;
			if (url === filePath || url === filePathWithoutExtension) {
				this.logger.log(`Found exact Markdown link match in card: ${url} for file: ${fileName}`);
				return true;
			}
		}

		return false;
	}

	/**
	 * Find the closest column name match for a given status
	 */
	findClosestColumnName(columnNames: string[], targetStatus: string): string | undefined {
		const targetLower = targetStatus.toLowerCase();

		// Define common variants of status names
		const statusVariants: Record<string, string[]> = {
			todo: ["to do", "todo", "backlog", "new", "not started", "pending", "open", "to-do"],
			"in progress": ["progress", "doing", "working", "ongoing", "started", "in work", "active", "current", "wip"],
			completed: ["done", "complete", "finished", "closed", "resolved", "ready", "completed"],
		};

		// First try exact match (case-insensitive)
		const exactMatch = columnNames.find((name) => name.toLowerCase() === targetLower);
		if (exactMatch) return exactMatch;

		// Special handling for common status values
		if (targetLower === this.settings.statusTodo.toLowerCase()) {
			for (const colName of columnNames) {
				const colNameLower = colName.toLowerCase();
				if (statusVariants["todo"].some((v) => colNameLower.includes(v) || v === colNameLower)) {
					return colName;
				}
			}
		} else if (targetLower === this.settings.statusInProgress.toLowerCase()) {
			for (const colName of columnNames) {
				const colNameLower = colName.toLowerCase();
				if (statusVariants["in progress"].some((v) => colNameLower.includes(v) || v === colNameLower)) {
					return colName;
				}
			}
		} else if (targetLower === this.settings.statusCompleted.toLowerCase()) {
			for (const colName of columnNames) {
				const colNameLower = colName.toLowerCase();
				if (statusVariants["completed"].some((v) => colNameLower.includes(v) || v === colNameLower)) {
					return colName;
				}
			}
		}

		// Then try fuzzy variant matching
		for (const [status, variants] of Object.entries(statusVariants)) {
			if (variants.some((v) => targetLower.includes(v) || v.includes(targetLower))) {
				for (const colName of columnNames) {
					const colNameLower = colName.toLowerCase();
					if (variants.some((v) => colNameLower.includes(v) || v.includes(colNameLower))) {
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

		// If still no matches, and this is a "Todo" status, return the first column
		if (targetLower === this.settings.statusTodo.toLowerCase() && columnNames.length > 0) {
			return columnNames[0];
		}

		return undefined;
	}

	/**
	 * Get the status from the file's YAML frontmatter
	 */
	async getStatusFromYaml(file: TFile): Promise<string | null> {
		let fileCache = this.app.metadataCache.getFileCache(file);

		if (!fileCache?.frontmatter) {
			this.logger.log(`No frontmatter found for file: ${file.path}`);
			return null;
		}

		try {
			const status = fileCache.frontmatter["status"];
			if (typeof status === "string" && status.trim()) {
				this.logger.log(`Status found for ${file.path}: ${status}`);
				return status.trim();
			}

			this.logger.log(`No valid status in frontmatter for file: ${file.path}`);
		} catch (error) {
			console.error(`Error accessing frontmatter for ${file.path}:`, error);
		}

		return null;
	}

	/**
	 * Wait for MetadataCache to update for a specific file
	 */
	async waitForCacheUpdate(file: TFile, timeoutMs: number = 1000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.logger.log(`Timeout waiting for cache update for ${file.path}`);
				resolve();
			}, timeoutMs);

			const handler = (updatedFile: TFile) => {
				if (updatedFile.path === file.path) {
					this.app.metadataCache.off("changed", handler);
					clearTimeout(timeout);
					this.logger.log(`Cache updated for ${file.path}`);
					resolve();
				}
			};

			this.app.metadataCache.on("changed", handler);
		});
	}

	/**
	 * Parse Kanban board structure into columns and items
	 */
	private async parseKanbanBoard(file: TFile): Promise<Record<string, { items: Array<{ text: string }> }>> {
		const kanban: Record<string, { items: Array<{ text: string }> }> = {};

		try {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (!fileCache) {
				this.logger.log(`No cache found for file: ${file.path}`);
				return kanban;
			}

			// Check if this is a Kanban plugin file using frontmatter
			const isKanbanPlugin = fileCache.frontmatter?.["kanban-plugin"] === "basic";

			// Get H2 headers (level 2) to identify columns
			const columnHeaders = fileCache.headings?.filter((h) => h.level === 2) || [];
			if (columnHeaders.length < 1) {
				this.logger.log(`No H2 headers found in file: ${file.path}`);
				return kanban;
			}

			// Read file content only when necessary to extract items
			const content = await this.app.vault.read(file);

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
					.substring(columnStart + columnHeader.heading.length + 4, columnEnd)
					.trim();

				// Extract items based on format
				if (isKanbanPlugin) {
					this.extractKanbanPluginItems(columnContent, kanban[columnName].items);
				} else {
					this.extractMarkdownItems(columnContent, kanban[columnName].items);
				}
			}

			this.logger.log(`Parsed Kanban board ${file.path} with columns:`, Object.keys(kanban));
			Object.entries(kanban).forEach(([column, data]) => {
				this.logger.log(`Column "${column}" has ${data.items.length} items`);
			});
		} catch (error) {
			console.error(`Error parsing Kanban board ${file.path}:`, error);
		}

		return kanban;
	}

	/**
	 * Extract items from Kanban plugin format
	 */
	private extractKanbanPluginItems(columnContent: string, items: Array<{ text: string }>) {
		const listItemsRaw = columnContent.split(/^- /m).slice(1);

		for (const rawItem of listItemsRaw) {
			const itemText = "- " + rawItem.trim();
			items.push({ text: itemText });
		}
	}

	/**
	 * Extract items from regular markdown format
	 */
	private extractMarkdownItems(columnContent: string, items: Array<{ text: string }>) {
		let lines = columnContent.split("\n");
		let currentItem = "";
		let inItem = false;

		for (const line of lines) {
			if (line.trim().startsWith("- ")) {
				if (inItem) {
					items.push({ text: currentItem.trim() });
				}
				currentItem = line;
				inItem = true;
			} else if (inItem) {
				currentItem += "\n" + line;
			}
		}

		if (inItem) {
			items.push({ text: currentItem.trim() });
		}
	}

	/**
	 * Add a file to the specified Kanban board if it's not already there
	 */
	async addFileToKanbanBoard(file: TFile): Promise<boolean> {
		try {
			// Skip if auto-add setting is disabled or board path is empty
			if (!this.settings.autoAddToKanban || !this.settings.autoAddKanbanBoard) {
				return false;
			}

			// Skip plugin files and Kanban board files
			const filePath = file.path.toLowerCase();
			const configDir = this.app.vault.configDir.toLowerCase();
			if (
				filePath.includes(`${configDir}/plugins/progress-tracker`) ||
				filePath.includes("kanban") ||
				filePath === this.settings.autoAddKanbanBoard
			) {
				this.logger.log(`Skipping plugin or kanban file: ${file.path}`);
				return false;
			}

			// Get the Kanban board file
			const boardPath = this.settings.autoAddKanbanBoard;
			const kanbanFile = this.app.vault.getAbstractFileByPath(boardPath);

			if (!kanbanFile || !(kanbanFile instanceof TFile)) {
				this.logger.log(`Could not find Kanban board at path: ${boardPath}`);
				return false;
			}

			// Skip if trying to add the kanban board to itself
			if (file.path === kanbanFile.path) {
				this.logger.log(`Skipping adding kanban board to itself: ${file.path}`);
				return false;
			}

			// Read the board content
			const boardContent = await this.app.vault.read(kanbanFile);

			// Skip if this is not a Kanban board
			if (!this.isKanbanBoard(kanbanFile)) {
				this.logger.log(`File at path ${boardPath} is not a Kanban board`);
				return false;
			}

			// Check if the file is already referenced in the board
			if (this.containsFileReference(boardContent, file)) {
				this.logger.log(`File ${file.path} is already in Kanban board ${boardPath}`);
				return false;
			}

			// Get the target column name
			const targetColumn = this.settings.autoAddKanbanColumn || "Todo";

			// Wait for MetadataCache to update
			await this.waitForCacheUpdate(file);

			// Parse the Kanban board to find the column
			const kanbanColumns = await this.parseKanbanBoard(kanbanFile);
			if (!kanbanColumns || Object.keys(kanbanColumns).length === 0) {
				this.logger.log(`Could not parse Kanban board structure in ${boardPath}`);
				return false;
			}

			// Find the exact or closest column match
			let targetColumnName = Object.keys(kanbanColumns).find(
				(name) => name.toLowerCase() === targetColumn.toLowerCase()
			);

			if (!targetColumnName) {
				targetColumnName = this.findClosestColumnName(Object.keys(kanbanColumns), targetColumn);
			}

			if (!targetColumnName) {
				this.logger.log(`Could not find column "${targetColumn}" in Kanban board ${boardPath}`);
				return false;
			}

			// Find the position to insert the card
			const columnRegex = new RegExp(`## ${escapeRegExp(targetColumnName)}\\s*\\n`);
			const columnMatch = boardContent.match(columnRegex);

			if (!columnMatch) {
				this.logger.log(`Could not find column "${targetColumnName}" in Kanban board content`);
				return false;
			}

			const insertPosition = columnMatch.index! + columnMatch[0].length;

			// Create card text with link to the file
			let cardText = `- [[${file.basename}]]\n`;

			// Apply custom checkbox state if enabled
			if (this.settings.enableCustomCheckboxStates) {
				const checkboxState = this.getCheckboxStateForColumn(targetColumnName);
				cardText = `- ${checkboxState} [[${file.basename}]]\n`;
			}

			// Insert the card
			const newContent =
				boardContent.substring(0, insertPosition) +
				cardText +
				boardContent.substring(insertPosition);

			// Update the file
			await this.app.vault.modify(kanbanFile, newContent);

			// Show notice
			new Notice(`Added ${file.basename} to "${targetColumnName}" column in ${kanbanFile.basename}`);

			return true;
		} catch (error) {
			console.error("Error adding file to Kanban board:", error);
			return false;
		}
	}

	/**
	 * Get checkbox state for a specific kanban column
	 */
	private getCheckboxStateForColumn(columnName: string): string {
		if (!this.settings.enableCustomCheckboxStates) {
			return "[ ]";
		}

		const mapping = this.settings.kanbanColumnCheckboxMappings.find(
			(m) => m.columnName.toLowerCase() === columnName.toLowerCase()
		);

		return mapping ? mapping.checkboxState : "[ ]";
	}

	/**
	 * Update checkbox states in card content based on target column
	 */
	private updateCheckboxStatesInCard(cardContent: string, targetColumnName: string): string {
		if (!this.settings.enableCustomCheckboxStates) {
			return cardContent;
		}

		const targetCheckboxState = this.getCheckboxStateForColumn(targetColumnName);

		// Split content into lines to process only the first line (main card)
		const lines = cardContent.split("\n");
		if (lines.length === 0) return cardContent;

		// Pattern to match various checkbox states
		const checkboxPattern = /^(\s*- )\[[^\]]*\](.*)$/;

		// Only update the first line if it matches the pattern (main card line)
		if (checkboxPattern.test(lines[0])) {
			const originalFirstLine = lines[0];
			lines[0] = lines[0].replace(
				checkboxPattern,
				(match, prefix, suffix) => {
					return `${prefix}${targetCheckboxState}${suffix}`;
				}
			);

			if (lines[0] !== originalFirstLine) {
				this.logger.log(
					`Updated checkbox states in card for column "${targetColumnName}":`,
					{
						original: originalFirstLine,
						updated: lines[0],
						targetState: targetCheckboxState,
					}
				);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Count tasks with different checkbox states
	 */
	private countTasksByCheckboxState(content: string): { [state: string]: number } {
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

	async onClose() {
		this.isVisible = false;
	}
}
