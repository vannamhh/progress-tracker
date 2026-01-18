/**
 * Progress Tracker Plugin for Obsidian
 * 
 * A plugin that tracks task progress in markdown files and integrates with Kanban boards.
 * Supports custom checkbox states and automatic status updates.
 */

import {
	App,
	Plugin,
	WorkspaceLeaf,
	TFile,
	MarkdownView,
	debounce,
} from "obsidian";

// Import interfaces and types
import { TaskProgressBarSettings, DEFAULT_SETTINGS } from "./interfaces/settings";
import { DataviewApi } from "./interfaces/types";

// Import utilities
import { DebugLogger } from "./utils/logger";

// Import services
import { DataviewService } from "./services/DataviewService";
import { FileService } from "./services/FileService";
import { KanbanService } from "./services/KanbanService";

// Import views
import { TaskProgressBarView } from "./views/ProgressBarView";
import { TaskProgressBarSettingTab } from "./views/SettingsTab";

/**
 * Main plugin class for Progress Tracker
 */
export default class TaskProgressBarPlugin extends Plugin {
	settings: TaskProgressBarSettings;
	dvAPI: DataviewApi | null = null;
	sidebarView: TaskProgressBarView | null = null;
	
	// Services
	private dataviewService: DataviewService;
	private fileService: FileService;
	private kanbanService: KanbanService;
	
	// Internal state
	private lastActiveFile: TFile | null = null;
	private lastFileContent: string = "";
	private logger: DebugLogger;

	async onload() {
		await this.loadSettings();

		// Initialize debug logger
		this.logger = new DebugLogger(() => this.settings.showDebugInfo);

		// Initialize services
		this.dataviewService = new DataviewService(this.app, this.logger);
		this.fileService = new FileService(this.app, this.logger);
		this.kanbanService = new KanbanService(
			this.app,
			this.settings,
			this.logger,
			this.fileService
		);

		// Apply the max-height CSS style as soon as the plugin loads
		this.applyMaxTabsHeightStyle();

		// Register view type for the sidebar
		this.registerView(
			"progress-tracker",
			(leaf) => {
				this.sidebarView = new TaskProgressBarView(
					leaf,
					this.app,
					this.settings,
					this.logger,
					this.dvAPI
				);
				
				// Set up callbacks for Kanban integration
				this.sidebarView.setIsKanbanBoardFn((file: TFile) => this.kanbanService.isKanbanBoard(file));
				
				return this.sidebarView;
			}
		);

		// Add icon to the left sidebar
		this.addRibbonIcon("bar-chart-horizontal", "Progress Tracker", () => {
			this.activateView();
		});

		// Add settings tab
		this.addSettingTab(new TaskProgressBarSettingTab(this.app, this));

		// Check Dataview API and set up interval to check again if not found
		this.checkDataviewAPI();

		// Register event handlers
		this.registerEventHandlers();
	}

	/**
	 * Register all event handlers for the plugin
	 */
	private registerEventHandlers(): void {
		// Register event to update progress bar when file changes
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.lastActiveFile = file;

					// Handle auto-sync for Kanban boards
					if (
						this.settings.enableKanbanAutoSync &&
						this.settings.enableCustomCheckboxStates &&
						this.kanbanService.isKanbanBoard(file) &&
						!this.kanbanService.hasBeenAutoSynced(file.path) &&
						!this.kanbanService.getIsUpdatingFromKanban()
					) {
						this.logger.log(`Auto-syncing Kanban board on open: ${file.path}`);

						setTimeout(async () => {
							if (
								!this.kanbanService.getIsUpdatingFromKanban() &&
								!this.kanbanService.getLastKanbanContent(file.path)
							) {
								await this.kanbanService.autoSyncKanbanCheckboxStates(file);
							} else {
								this.logger.log(
									`Skipping auto-sync - update in progress or file already tracked`
								);
							}
						}, 800);
					}

					// Original progress bar update logic
					setTimeout(async () => {
						await this.updateLastFileContent(file);
						if (this.sidebarView) {
							this.sidebarView.updateProgressBar(file);
						}
					}, 100);
				}
			})
		);

		// Register event to listen for file modifications (for Kanban UI changes)
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (
					file instanceof TFile &&
					this.settings.enableKanbanToFileSync &&
					this.settings.enableCustomCheckboxStates &&
					this.kanbanService.isKanbanBoard(file)
				) {
					this.logger.log(`File modified event for Kanban board: ${file.path}`);

					if (this.kanbanService.getIsUpdatingFromKanban()) {
						this.logger.log("Skipping file modify - currently updating from plugin");
						return;
					}

					setTimeout(async () => {
						try {
							const newContent = await this.app.vault.read(file);
							await this.kanbanService.handleKanbanBoardChange(file, newContent);
						} catch (error) {
							this.logger.error("Error handling file modify for Kanban board:", error as Error);
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
						if (this.kanbanService.getIsUpdatingFromKanban()) {
							this.logger.log("Skipping editor-change - currently updating from Kanban");
							return;
						}

						const content = editor.getValue();
						const currentFile = view.file;

						// Check if this is a Kanban board file and handle card checkbox sync
						if (
							this.settings.enableKanbanToFileSync &&
							this.settings.enableCustomCheckboxStates &&
							currentFile &&
							this.kanbanService.isKanbanBoard(currentFile)
						) {
							this.logger.log(`Detected Kanban board change: ${currentFile.path}`);

							// Enhanced immediate Kanban normalization protection
							if (this.settings.enableKanbanNormalizationProtection) {
								const hasImmediateNormalization =
									this.kanbanService.detectImmediateKanbanNormalization(
										this.lastFileContent,
										content
									);
								this.logger.log(`Immediate normalization check: ${hasImmediateNormalization}`);
								
								if (hasImmediateNormalization) {
									this.logger.log("Detected immediate Kanban normalization - reverting unwanted changes");
									const revertedContent = this.kanbanService.revertKanbanNormalization(
										this.lastFileContent,
										content,
										currentFile
									);
									
									if (revertedContent !== content) {
										this.kanbanService.setIsUpdatingFromKanban(true);
										
										setTimeout(async () => {
											const syncedContent =
												await this.kanbanService.syncAllCheckboxStatesToMappings(
													currentFile,
													revertedContent
												);
											await this.app.vault.modify(currentFile, syncedContent);
											this.lastFileContent = syncedContent;
											await this.kanbanService.forceRefreshKanbanUI(currentFile);
											
											setTimeout(() => {
												this.kanbanService.setIsUpdatingFromKanban(false);
											}, 100);
										}, 50);
										return;
									}
								}
							}

							setTimeout(async () => {
								const latestContent = await this.app.vault.read(currentFile);
								await this.kanbanService.handleKanbanBoardChange(currentFile, latestContent);
							}, 200);
						}

						// Original logic for regular file changes
						if (
							content.includes("- [") ||
							this.lastFileContent.includes("- [") ||
							/- \[[^\]]*\]/.test(content) ||
							/- \[[^\]]*\]/.test(this.lastFileContent)
						) {
							const hasContentChanged = this.hasTaskContentChanged(
								this.lastFileContent,
								content
							);

							if (hasContentChanged) {
								this.lastFileContent = content;

								if (currentFile) {
									this.sidebarView.updateProgressBar(currentFile, content);
								}
							}
						}
					}
				}, this.settings.editorChangeDelay)
			)
		);

		// Listen for keydown events to detect when user enters new tasks or checks/unchecks tasks
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			// Check if we're in the editor
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && activeView.getMode() === "source") {
				// Update immediately when pressing keys related to tasks
				if (
					["Enter", "Space", "]", "x", "X", "Backspace", "Delete"].includes(evt.key)
				) {
					// Update immediately
					setTimeout(() => {
						const content = activeView.editor.getValue();

						// Check if content contains tasks and if they have changed (enhanced for custom states)
						if (
							(content.includes("- [") || /- \[[^\]]*\]/.test(content)) &&
							this.hasTaskContentChanged(this.lastFileContent, content)
						) {
							this.lastActiveFile = activeView.file;

							// Update progress bar immediately
							if (this.sidebarView) {
								this.sidebarView.updateProgressBar(activeView.file, content);
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
					this.sidebarView.updateProgressBar(currentFile, undefined, true);
				}
			}, 1500);
		}, 1000);
	}

	/**
	 * Check if task content has changed between two versions
	 */
	private hasTaskContentChanged(oldContent: string, newContent: string): boolean {
		// Quick length check first
		if (oldContent.length !== newContent.length) {
			return true;
		}

		// Extract task lines for comparison
		const oldTaskLines = oldContent
			.split("\n")
			.filter((line) => /- \[[^\]]*\]/.test(line));
		const newTaskLines = newContent
			.split("\n")
			.filter((line) => /- \[[^\]]*\]/.test(line));

		// Check if number of tasks changed
		if (oldTaskLines.length !== newTaskLines.length) {
			return true;
		}

		// Check if any task content changed
		for (let i = 0; i < oldTaskLines.length; i++) {
			if (oldTaskLines[i] !== newTaskLines[i]) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Update the cached file content
	 */
	private async updateLastFileContent(file: TFile): Promise<void> {
		try {
			this.lastFileContent = await this.app.vault.read(file);
		} catch (error) {
			this.logger.error("Error reading file content:", error as Error);
		}
	}

	async onunload() {
		// Cleanup services
		this.dataviewService.cleanup();
		this.fileService.cleanup();
		this.kanbanService.cleanup();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		
		// Update services with new settings
		if (this.kanbanService) {
			this.kanbanService.updateSettings(this.settings);
		}
		if (this.sidebarView) {
			this.sidebarView.updateSettings(this.settings);
		}
		
		// Apply max tabs height style
		this.applyMaxTabsHeightStyle();
	}

	/**
	 * Apply max-height style to workspace tabs
	 */
	private applyMaxTabsHeightStyle(): void {
		const styleId = "progress-tracker-max-tabs-height";
		let styleEl = document.getElementById(styleId);

		if (!styleEl) {
			styleEl = document.createElement("style");
			styleEl.id = styleId;
			document.head.appendChild(styleEl);
		}

		const maxHeight = this.settings.maxTabsHeight || "auto";
		styleEl.textContent = `
			.workspace-tabs:has(.workspace-tab-container .progress-tracker-leaf) {
				max-height: ${maxHeight};
			}
		`;
	}

	/**
	 * Check and initialize Dataview API
	 */
	checkDataviewAPI(): void {
		this.dvAPI = this.dataviewService.getDataviewAPI();
		
		if (this.dvAPI) {
			this.logger.log("Dataview API found and cached");
			
			// Update the sidebar view with the new API
			if (this.sidebarView) {
				this.sidebarView.updateDataviewAPI(this.dvAPI);
			}
		} else {
			this.logger.log("Dataview API not found, starting periodic check");
			this.dataviewService.startPeriodicCheck((api) => {
				this.dvAPI = api;
				if (this.sidebarView) {
					this.sidebarView.updateDataviewAPI(this.dvAPI);
				}
			});
		}
	}

	/**
	 * Activate the sidebar view
	 */
	async activateView(): Promise<void> {
		const { workspace } = this.app;

		// Wait for workspace to be ready
		if (!workspace.layoutReady) {
			workspace.onLayoutReady(() => this.activateView());
			return;
		}

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType("progress-tracker");

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			// Try to get right leaf, with fallback
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: "progress-tracker", active: true });
			} else {
				// Fallback: create a new split in the right sidebar
				leaf = workspace.getLeaf('split', 'vertical');
				if (leaf) {
					await leaf.setViewState({ type: "progress-tracker", active: true });
				}
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}
