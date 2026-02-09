import {
	App,
	WorkspaceLeaf,
	TFile,
	ItemView,
	Notice,
} from "obsidian";
import { TaskProgressBarSettings } from "../interfaces/settings";
import { DataviewApi } from "../interfaces/types";
import { DebugLogger } from "../utils/logger";
import { 
	hasTasksInContent, 
	countAllTasks, 
	UI_CLASSES,
	type TaskCounts 
} from "../utils/helpers";
import { KanbanService } from "../services/KanbanService";

// ============================================================================
// Types
// ============================================================================

interface ProgressData {
	percentage: number;
	completedCount: number;
	totalTasks: number;
}

// ============================================================================
// Progress Bar View
// ============================================================================

/**
 * Progress bar view that displays task completion status in the sidebar
 * Refactored to use centralized helpers and KanbanService
 */
export class TaskProgressBarView extends ItemView {
	private settings: TaskProgressBarSettings;
	private logger: DebugLogger;
	private dvAPI: DataviewApi | null = null;
	private kanbanService: KanbanService | null = null;
	
	currentFile: TFile | null = null;
	isVisible: boolean = false;
	lastUpdateTime: number = 0;
	initialLoadComplete: boolean = false;
	completedFilesMap: Map<string, boolean> = new Map();

	constructor(
		leaf: WorkspaceLeaf,
		_app: App,
		settings: TaskProgressBarSettings,
		logger: DebugLogger,
		dvAPI: DataviewApi | null
	) {
		super(leaf);
		this.settings = settings;
		this.logger = logger;
		this.dvAPI = dvAPI;
	}

	// ============================================================================
	// Public API Methods
	// ============================================================================

	updateSettings(settings: TaskProgressBarSettings): void {
		this.settings = settings;
	}

	updateDataviewAPI(dvAPI: DataviewApi | null): void {
		this.dvAPI = dvAPI;
	}

	setKanbanService(kanbanService: KanbanService): void {
		this.kanbanService = kanbanService;
	}

	setIsKanbanBoardFn(fn: (file: TFile) => boolean): void {
		// Keep for backwards compatibility - now uses KanbanService
	}

	clearCompletedFilesCache(): void {
		this.completedFilesMap.clear();
		this.logger.log("Cleared completed files cache");
	}

	// ============================================================================
	// ItemView Overrides
	// ============================================================================

	getViewType(): string {
		return "progress-tracker";
	}

	getDisplayText(): string {
		return "Task progress bar";
	}

	getIcon(): string {
		return "bar-chart-horizontal";
	}

	async onOpen(): Promise<void> {
		this.isVisible = true;
		this.initialLoadComplete = false;

		this.addLeafClasses();
		this.initializeContainer();

		// Trigger initial update after a short delay
		setTimeout(async () => {
			const currentFile = this.app.workspace.getActiveFile();
			if (currentFile) {
				await this.updateProgressBar(currentFile, undefined, true);
			}
		}, 200);
	}

	async onClose(): Promise<void> {
		this.isVisible = false;
	}

	// ============================================================================
	// Main Progress Bar Methods
	// ============================================================================

	async updateProgressBar(
		file: TFile | null,
		content?: string,
		isInitialLoad: boolean = false
	): Promise<void> {
		if (!file) return;

		// Throttle updates
		const now = Date.now();
		if (!isInitialLoad && now - this.lastUpdateTime < 100) return;
		this.lastUpdateTime = now;

		this.currentFile = file;

		const container = this.getProgressContainer();
		if (!container) return;

		// Clear on initial load
		if (isInitialLoad || !this.initialLoadComplete) {
			container.empty();
			this.initialLoadComplete = true;
		}

		// Add animation class if enabled
		if (this.settings.showUpdateAnimation) {
			container.classList.add("updating");
		}

		try {
			const fileContent = content || await this.app.vault.read(file);

			if (!hasTasksInContent(fileContent)) {
				this.showNoTasksMessage(container);
				this.logger.log("No tasks found in file:", file.path);
			} else {
				await this.createProgressBarFromContent(container, fileContent, file);
			}
		} catch (error) {
			this.showErrorMessage(container, error as Error);
		} finally {
			if (this.settings.showUpdateAnimation) {
				setTimeout(() => {
					container.classList.remove("updating");
				}, this.settings.updateAnimationDelay);
			}
		}
	}

	// ============================================================================
	// Progress Bar Creation
	// ============================================================================

	private async createProgressBarFromContent(
		container: HTMLElement,
		content: string,
		file: TFile
	): Promise<void> {
		this.logger.log(`Creating progress bar for file: ${file.path}`);

		// Check Dataview API
		if (!this.dvAPI) {
			this.showDataviewWarning(container);
			return;
		}

		// Count tasks using centralized helper
		const taskCounts = countAllTasks(content, this.settings.enableCustomCheckboxStates);
		
		this.logger.log(
			`Task counts - incomplete: ${taskCounts.incomplete}, completed: ${taskCounts.completed}, ` +
			`custom states: ${taskCounts.customStates}, total: ${taskCounts.total}`
		);

		if (taskCounts.total === 0) {
			this.showNoTasksMessage(container);
			return;
		}

		const progressData: ProgressData = {
			completedCount: taskCounts.completed,
			totalTasks: taskCounts.total,
			percentage: Math.round((taskCounts.completed / taskCounts.total) * 100),
		};

		// Update UI first for responsiveness
		this.updateProgressBarUI(container, progressData);

		// Process async updates
		this.processAsyncUpdates(file, progressData);
	}

	// ============================================================================
	// UI Update Methods
	// ============================================================================

	private updateProgressBarUI(container: HTMLElement, data: ProgressData): void {
		const { percentage, completedCount, totalTasks } = data;

		// Get or create UI elements
		let progressLayout = container.querySelector(`.${UI_CLASSES.PROGRESS_LAYOUT}`) as HTMLElement;
		let statsContainer = container.querySelector(`.${UI_CLASSES.PROGRESS_STATS}`) as HTMLElement;

		if (!progressLayout || !statsContainer) {
			container.empty();
			this.createProgressBarStructure(container);
			progressLayout = container.querySelector(`.${UI_CLASSES.PROGRESS_LAYOUT}`) as HTMLElement;
			statsContainer = container.querySelector(`.${UI_CLASSES.PROGRESS_STATS}`) as HTMLElement;
		}

		// Update percentage text
		const percentageElement = progressLayout?.querySelector(`.${UI_CLASSES.PROGRESS_PERCENTAGE}`) as HTMLElement;
		if (percentageElement) {
			percentageElement.setText(`${percentage}%`);
		}

		// Update progress bar
		const progressValue = container.querySelector(`.${UI_CLASSES.PROGRESS_VALUE}`) as HTMLElement;
		if (progressValue) {
			if (!progressValue.hasAttribute("data-has-transition")) {
				progressValue.style.transition = "width 0.3s ease-in-out, background-color 0.3s ease";
				progressValue.setAttribute("data-has-transition", "true");
			}
			progressValue.style.width = `${percentage}%`;
			this.applyProgressColor(progressValue, percentage);
		}

		// Update progress element data attribute
		const progressElement = container.querySelector(`.${UI_CLASSES.PROGRESS_ELEMENT}`) as HTMLElement;
		if (progressElement) {
			progressElement.setAttribute("data-percentage", percentage.toString());
		}

		// Update stats
		if (statsContainer) {
			statsContainer.empty();
			statsContainer.createSpan({ text: `${completedCount}/${totalTasks} tasks` });
		}

		// Update debug info
		this.updateDebugInfo(container, data);
	}

	private createProgressBarStructure(container: HTMLElement): void {
		const progressLayout = container.createDiv({ cls: UI_CLASSES.PROGRESS_LAYOUT });

		// Percentage text
		progressLayout.createEl("div", { cls: UI_CLASSES.PROGRESS_PERCENTAGE });

		// Progress bar
		const progressBarContainer = progressLayout.createDiv({ cls: UI_CLASSES.PROGRESS_BAR_CONTAINER });
		const progressElement = progressBarContainer.createDiv({ cls: UI_CLASSES.PROGRESS_ELEMENT });
		progressElement.createDiv({ cls: UI_CLASSES.PROGRESS_VALUE });

		// Stats container
		container.createDiv({ cls: UI_CLASSES.PROGRESS_STATS });
	}

	private applyProgressColor(progressElement: HTMLElement, percentage: number): void {
		if (this.settings.progressColorScheme === "default") {
			progressElement.style.backgroundColor = "";
			return;
		}

		let newColor = "";
		if (percentage === 100) {
			newColor = this.settings.completeProgressColor;
		} else if (percentage >= this.settings.mediumProgressThreshold) {
			newColor = this.settings.highProgressColor;
		} else if (percentage >= this.settings.lowProgressThreshold) {
			newColor = this.settings.mediumProgressColor;
		} else {
			newColor = this.settings.lowProgressColor;
		}

		if (progressElement.style.backgroundColor !== newColor) {
			progressElement.style.backgroundColor = newColor;
		}
	}

	private updateDebugInfo(container: HTMLElement, data: ProgressData): void {
		if (!this.settings.showDebugInfo) {
			const debugInfo = container.querySelector(`.${UI_CLASSES.DEBUG_INFO}`);
			if (debugInfo) debugInfo.remove();
			return;
		}

		let debugInfo = container.querySelector(`.${UI_CLASSES.DEBUG_INFO}`) as HTMLElement;
		if (!debugInfo) {
			debugInfo = container.createDiv({ cls: UI_CLASSES.DEBUG_INFO });
		} else {
			debugInfo.empty();
		}

		const { percentage, completedCount, totalTasks } = data;
		debugInfo.createEl("p", { text: `Debug info:` });
		debugInfo.createEl("p", { text: `File: ${this.currentFile?.path}` });
		debugInfo.createEl("p", { text: `Incomplete tasks: ${totalTasks - completedCount}` });
		debugInfo.createEl("p", { text: `Completed tasks: ${completedCount}` });
		debugInfo.createEl("p", { text: `Total tasks: ${totalTasks}` });
		debugInfo.createEl("p", { text: `Percentage: ${percentage}%` });
		debugInfo.createEl("p", { text: `Update time: ${new Date().toISOString()}` });
		debugInfo.createEl("p", { text: `Color scheme: ${this.settings.progressColorScheme}` });
	}

	// ============================================================================
	// Message Display Methods
	// ============================================================================

	private showNoTasksMessage(container: HTMLElement): void {
		if (!container.querySelector(`.${UI_CLASSES.NO_TASKS_MESSAGE}`)) {
			container.empty();
			container.createEl("p", {
				text: "No tasks found in this file",
				cls: UI_CLASSES.NO_TASKS_MESSAGE,
			});
		}
	}

	private showDataviewWarning(container: HTMLElement): void {
		if (!container.querySelector(`.${UI_CLASSES.DATAVIEW_WARNING}`)) {
			container.empty();
			const warning = container.createDiv({ cls: UI_CLASSES.DATAVIEW_WARNING });
			warning.createEl("span", {
				text: "Dataview not available",
				cls: UI_CLASSES.DATAVIEW_WARNING_TEXT,
			});
		}
	}

	private showErrorMessage(container: HTMLElement, error: Error): void {
		this.logger.error("Error updating progress bar:", error);
		container.empty();
		container.createEl("p", {
			text: `Error updating progress bar: ${error.message}`,
		});
	}

	// ============================================================================
	// Async Processing Methods
	// ============================================================================

	private processAsyncUpdates(file: TFile, data: ProgressData): void {
		setTimeout(async () => {
			try {
				const { percentage, completedCount, totalTasks } = data;

				// Calculate target status FIRST
				let targetStatus = this.settings.statusInProgress;
				if (percentage === 0) {
					targetStatus = this.settings.statusTodo;
				} else if (percentage === 100) {
					targetStatus = this.settings.statusCompleted;
				}

				// Update status based on progress
				let statusChanged = false;
				if (this.settings.autoChangeStatus) {
					statusChanged = await this.updateStatusBasedOnProgress(file, percentage);
					
					// Wait for metadata cache to update after frontmatter change
					if (statusChanged) {
						await new Promise(resolve => setTimeout(resolve, 100));
					}
				}

				// Update Kanban boards - PASS the calculated status directly
				// instead of reading from YAML to avoid race condition
				if (this.settings.autoUpdateKanban && this.kanbanService) {
					if (statusChanged || !this.completedFilesMap.has(file.path)) {
						await this.updateKanbanBoards(file, completedCount, totalTasks, targetStatus);
					}
				}

				// Handle 100% completion
				if (percentage === 100 && this.settings.autoUpdateMetadata) {
					if (!this.completedFilesMap.has(file.path)) {
						await this.updateFileMetadata(file);
						this.completedFilesMap.set(file.path, true);
					}
				} else if (percentage < 100) {
					this.completedFilesMap.delete(file.path);
				}

				// Auto-add to Kanban board
				if (
					this.settings.autoAddToKanban &&
					this.settings.autoAddKanbanBoard &&
					totalTasks > 0 &&
					!this.completedFilesMap.has(file.path) &&
					this.kanbanService
				) {
					await this.kanbanService.addFileToKanbanBoard(file);
				}
			} catch (error) {
				this.logger.error("Error in async updates:", error as Error);
			}
		}, 0);
	}

	// ============================================================================
	// Status & Metadata Methods
	// ============================================================================

	async updateStatusBasedOnProgress(file: TFile, progressPercentage: number): Promise<boolean> {
		if (!file || !this.settings.autoChangeStatus) return false;

		try {
			let needsUpdate = false;

			// Determine target status
			let targetStatus = this.settings.statusInProgress;
			if (progressPercentage === 0) {
				targetStatus = this.settings.statusTodo;
			} else if (progressPercentage === 100) {
				targetStatus = this.settings.statusCompleted;
			}

			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (frontmatter["status"] !== targetStatus) {
					frontmatter["status"] = targetStatus;
					needsUpdate = true;
				}

				if (progressPercentage < 100 && this.settings.autoUpdateFinishedDate && frontmatter["finished"]) {
					delete frontmatter["finished"];
					needsUpdate = true;
				}
			});

			if (needsUpdate) {
				this.logger.log(`Updated status to "${targetStatus}" for file: ${file.path}`);
			}

			return needsUpdate;
		} catch (error) {
			this.logger.error("Error updating status:", error as Error);
			return false;
		}
	}

	async updateFileMetadata(file: TFile): Promise<void> {
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				const today = new Date().toISOString().split("T")[0];

				if (this.settings.autoChangeStatus && frontmatter["status"] !== this.settings.statusCompleted) {
					frontmatter["status"] = this.settings.statusCompleted;
					this.logger.log(`Updating status to ${this.settings.statusCompleted} in file: ${file.path}`);
				}

				if (this.settings.autoUpdateFinishedDate && frontmatter["finished"] !== today) {
					frontmatter["finished"] = today;
					this.logger.log(`Updating finished date to ${today} in file: ${file.path}`);
				}
			});
		} catch (error) {
			this.logger.error("Error updating file metadata:", error as Error);
			new Notice(`Error updating metadata for ${file.basename}: ${(error as Error).message}`);
		}
	}

	// ============================================================================
	// Kanban Integration Methods
	// ============================================================================

	async updateKanbanBoards(
		file: TFile, 
		completedTasks: number, 
		totalTasks: number,
		targetStatus?: string
	): Promise<void> {
		if (!this.settings.autoUpdateKanban || totalTasks === 0 || !this.kanbanService) {
			return;
		}

		try {
			// Use passed targetStatus if available, otherwise calculate or read from YAML
			let finalStatus: string;
			if (targetStatus) {
				// Use the status passed from processAsyncUpdates (already calculated)
				finalStatus = targetStatus;
				this.logger.log(`Using passed target status for ${file.path}: ${finalStatus}`);
			} else {
				// Fallback: Calculate status from progress
				const currentStatus = this.kanbanService.calculateStatusFromProgress(completedTasks, totalTasks);

				// Get status from YAML if available
				const statusFromYaml = await this.kanbanService.getStatusFromYaml(file);
				finalStatus = statusFromYaml || currentStatus;
			}

			this.logger.log(`Updating Kanban boards for ${file.path} with status: ${finalStatus}`);

			// Process Kanban boards using the service
			const updatedBoardCount = await this.kanbanService.processKanbanBoardsForFile(file, finalStatus);

			if (updatedBoardCount > 0) {
				new Notice(
					`Updated ${updatedBoardCount} Kanban board${updatedBoardCount > 1 ? "s" : ""} ` +
					`to move ${file.basename} to ${finalStatus} column`
				);
			}
		} catch (error) {
			this.logger.error("Error updating Kanban boards:", error as Error);
			new Notice(`Error updating Kanban boards: ${(error as Error).message}`);
		}
	}

	// ============================================================================
	// Helper Methods
	// ============================================================================

	private addLeafClasses(): void {
		const leaf = this.leaf as any;
		if (leaf?.containerEl) {
			leaf.containerEl.addClass(UI_CLASSES.PROGRESS_TRACKER_LEAF);
		}

		const parentLeaf = this.containerEl.closest(".workspace-leaf");
		if (parentLeaf) {
			parentLeaf.addClass(UI_CLASSES.PROGRESS_TRACKER_LEAF);
		}
	}

	private initializeContainer(): void {
		const container = this.containerEl.children[1];
		container.empty();

		const progressContainer = container.createDiv({ cls: UI_CLASSES.PROGRESS_CONTAINER });
		progressContainer.createEl("p", {
			text: "Loading task progress...",
			cls: UI_CLASSES.LOADING_INDICATOR,
		});
	}

	private getProgressContainer(): HTMLElement | null {
		const container = this.containerEl.children[1];
		return container.querySelector(`.${UI_CLASSES.PROGRESS_CONTAINER}`) as HTMLElement;
	}
}
