import {
	App,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
	Plugin,
} from "obsidian";
import { TaskProgressBarSettings, DEFAULT_SETTINGS } from "../interfaces/settings";
import { DataviewApi } from "../interfaces/types";
import { FileSuggestModal } from "./FileModal";
import { TaskProgressBarView } from "./ProgressBarView";

/**
 * Interface for the plugin to interact with the settings tab
 */
export interface SettingsTabPlugin extends Plugin {
	settings: TaskProgressBarSettings;
	dvAPI: DataviewApi | null;
	sidebarView: TaskProgressBarView | null;
	checkDataviewAPI(): void;
	saveSettings(): Promise<void>;
}

/**
 * Settings tab for the Task Progress Bar plugin
 */
export class TaskProgressBarSettingTab extends PluginSettingTab {
	plugin: SettingsTabPlugin;

	constructor(app: App, plugin: SettingsTabPlugin) {
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
					.setLimits(100, 1000, 50)
					.setValue(this.plugin.settings.editorChangeDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.editorChangeDelay = value;
						await this.plugin.saveSettings();
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
						this.display();
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
					.setLimits(100, 1000, 50)
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
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Checkbox click delay")
			.setDesc(
				"Delay after checkbox click before updating progress (in milliseconds)"
			)
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50)
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
						this.display();
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
								this.plugin.settings.lowProgressColor =
									"#e06c75";
								this.plugin.settings.mediumProgressColor =
									"#e5c07b";
								this.plugin.settings.highProgressColor =
									"#61afef";
								this.plugin.settings.completeProgressColor =
									"#98c379";

								this.plugin.settings.lowProgressThreshold = 30;
								this.plugin.settings.mediumProgressThreshold = 60;
								this.plugin.settings.highProgressThreshold = 99;

								new Notice(
									"Applied Red-Orange-Blue-Green color scheme"
								);
							}

							await this.plugin.saveSettings();
							this.display();

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
			this.displayCustomColorSettings(containerEl);
		}

		// Interface settings section
		new Setting(containerEl).setName("Interface").setHeading();

		new Setting(containerEl)
			.setName("Max tabs height")
			.setDesc(
				"Maximum height for workspace tabs (e.g., 110px, 200px, auto)"
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.maxTabsHeight);

				text.inputEl.addEventListener("blur", async () => {
					const value = text.inputEl.value;
					const isValid =
						value === "auto" ||
						value === "none" ||
						/^\d+(\.\d+)?(px|em|rem|vh|%)$/.test(value);

					if (isValid) {
						if (this.plugin.settings.maxTabsHeight !== value) {
							this.plugin.settings.maxTabsHeight = value;
							await this.plugin.saveSettings();
							new Notice(`Max tabs height updated to ${value}`);
						}
					} else {
						new Notice(
							"Please enter 'auto', 'none' or a valid CSS length value (e.g., 110px)"
						);
						text.setValue(this.plugin.settings.maxTabsHeight);
					}
				});

				text.inputEl.addEventListener("keydown", async (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						text.inputEl.blur();
					}
				});

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
						this.display();
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
						this.display();
					})
			);

		// Only show these settings if auto-update is enabled
		if (this.plugin.settings.autoUpdateMetadata) {
			this.displayMetadataSettings(containerEl);
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
						this.display();
					})
			);

		if (this.plugin.settings.autoAddToKanban) {
			this.displayAutoAddKanbanSettings(containerEl);
		}

		// Add new section for custom checkbox states
		new Setting(containerEl)
			.setName("Custom Checkbox States")
			.setDesc(
				"Configure custom checkbox states for different Kanban columns"
			)
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
						this.display();
					})
			);

		if (this.plugin.settings.enableCustomCheckboxStates) {
			this.displayCustomCheckboxSettings(containerEl);
		}
	}

	/**
	 * Display custom color settings
	 */
	private displayCustomColorSettings(containerEl: HTMLElement): void {
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
						this.updateProgressBarView();
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
						this.updateProgressBarView();
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
						this.updateProgressBarView();
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
						this.updateProgressBarView();
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
						if (value >= this.plugin.settings.mediumProgressThreshold) {
							value = this.plugin.settings.mediumProgressThreshold - 1;
						}
						this.plugin.settings.lowProgressThreshold = value;
						await this.plugin.saveSettings();
						this.updateProgressBarView();
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
						if (value <= this.plugin.settings.lowProgressThreshold) {
							value = this.plugin.settings.lowProgressThreshold + 1;
						}
						if (value >= this.plugin.settings.highProgressThreshold) {
							value = this.plugin.settings.highProgressThreshold - 1;
						}
						this.plugin.settings.mediumProgressThreshold = value;
						await this.plugin.saveSettings();
						this.updateProgressBarView();
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
						if (value <= this.plugin.settings.mediumProgressThreshold) {
							value = this.plugin.settings.mediumProgressThreshold + 1;
						}
						this.plugin.settings.highProgressThreshold = value;
						await this.plugin.saveSettings();
						this.updateProgressBarView();
					})
			);
	}

	/**
	 * Display metadata settings
	 */
	private displayMetadataSettings(containerEl: HTMLElement): void {
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
						this.display();
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
			this.displayStatusLabelSettings(containerEl);
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
						this.display();
					})
			);

		if (this.plugin.settings.autoUpdateKanban) {
			this.displayKanbanIntegrationSettings(containerEl);
		}
	}

	/**
	 * Display status label settings
	 */
	private displayStatusLabelSettings(containerEl: HTMLElement): void {
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
						this.plugin.settings.statusInProgress = "In Progress";
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
						this.plugin.settings.statusCompleted = "Completed";
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}

	/**
	 * Display Kanban integration settings
	 */
	private displayKanbanIntegrationSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Sync Kanban columns with status")
			.setDesc(
				"Match Kanban column names to status values (Todo, In Progress, Completed)"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.kanbanSyncWithStatus)
					.onChange(async (value) => {
						this.plugin.settings.kanbanSyncWithStatus = value;
						await this.plugin.saveSettings();
						this.display();
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
						.setValue(this.plugin.settings.kanbanCompletedColumn)
						.onChange(async (value) => {
							this.plugin.settings.kanbanCompletedColumn = value;
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

		// Add Auto-detect settings
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
						this.display();
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
	}

	/**
	 * Display auto-add to Kanban settings
	 */
	private displayAutoAddKanbanSettings(containerEl: HTMLElement): void {
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
			try {
				const modal = new FileSuggestModal(this.app);
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

	/**
	 * Display custom checkbox settings
	 */
	private displayCustomCheckboxSettings(containerEl: HTMLElement): void {
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
			.setName(
				"Protect custom checkbox states from Kanban normalization"
			)
			.setDesc(
				"When enabled, prevents the Kanban plugin from automatically converting custom checkbox states (like [/], [~]) to standard states ([x]). This preserves your custom state mappings."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.enableKanbanNormalizationProtection
					)
					.onChange(async (value) => {
						this.plugin.settings.enableKanbanNormalizationProtection =
							value;
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
		this.plugin.settings.kanbanColumnCheckboxMappings.forEach(
			(mapping, index) => {
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
					this.plugin.settings.kanbanColumnCheckboxMappings[
						index
					].columnName = columnInput.value;
					await this.plugin.saveSettings();
				});

				checkboxInput.addEventListener("change", async () => {
					this.plugin.settings.kanbanColumnCheckboxMappings[
						index
					].checkboxState = checkboxInput.value;
					await this.plugin.saveSettings();
				});

				deleteButton.addEventListener("click", async () => {
					this.plugin.settings.kanbanColumnCheckboxMappings.splice(
						index,
						1
					);
					await this.plugin.saveSettings();
					this.display();
				});
			}
		);

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
			this.display();
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
			this.display();
		});
	}

	/**
	 * Helper method to update the progress bar view
	 */
	private updateProgressBarView(): void {
		const currentFile = this.app.workspace.getActiveFile();
		if (currentFile && this.plugin.sidebarView) {
			this.plugin.sidebarView.updateProgressBar(currentFile);
		}
	}
}
