import { App, TFile, Notice } from "obsidian";
import { TaskProgressBarSettings } from "../interfaces/settings";
import {
	KanbanBoard,
	CardMovement,
	NormalizationDetectorState,
	CheckboxNormalizationAnalysis,
} from "../interfaces/types";
import { DebugLogger } from "../utils/logger";
import { FileService } from "./FileService";
import {
	normalizeCardContentForComparison,
	updateCheckboxStateInCardText,
	extractObsidianLinks,
	extractMarkdownLinks,
	escapeRegExp,
} from "../utils/helpers";

/**
 * Service for handling Kanban board operations
 * Includes parsing, syncing, and normalization protection
 */
export class KanbanService {
	private app: App;
	private settings: TaskProgressBarSettings;
	private logger: DebugLogger;
	private fileService: FileService;

	// Tracking variables for Kanban sync
	private lastKanbanContent: Map<string, string> = new Map();
	private autoSyncedFiles: Set<string> = new Set();
	private lastFileUpdateMap: Map<string, number> = new Map();
	private kanbanNormalizationDetector: Map<string, NormalizationDetectorState> =
		new Map();
	private isUpdatingFromKanban: boolean = false;

	constructor(
		app: App,
		settings: TaskProgressBarSettings,
		logger: DebugLogger,
		fileService: FileService
	) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;
		this.fileService = fileService;
	}

	/**
	 * Update settings reference (called when settings change)
	 */
	updateSettings(settings: TaskProgressBarSettings): void {
		this.settings = settings;
	}

	/**
	 * Check if currently updating from Kanban
	 */
	getIsUpdatingFromKanban(): boolean {
		return this.isUpdatingFromKanban;
	}

	/**
	 * Set updating from Kanban flag
	 */
	setIsUpdatingFromKanban(value: boolean): void {
		this.isUpdatingFromKanban = value;
	}

	/**
	 * Check if a file has been auto-synced
	 */
	hasBeenAutoSynced(filePath: string): boolean {
		return this.autoSyncedFiles.has(filePath);
	}

	/**
	 * Get last Kanban content for a file
	 */
	getLastKanbanContent(filePath: string): string | undefined {
		return this.lastKanbanContent.get(filePath);
	}

	/**
	 * Check if a file is a Kanban board
	 * Uses heuristics to detect Kanban structure and plugin metadata
	 */
	isKanbanBoard(file: TFile): boolean {
		try {
			// Use MetadataCache to get file cache
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
				this.settings.kanbanCompletedColumn.toLowerCase();

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
			console.error(
				`Error checking if ${file.path} is a Kanban board:`,
				error
			);
			return false;
		}
	}

	/**
	 * Parse Kanban board content into structure
	 */
	async parseKanbanBoardContent(
		content: string,
		file: TFile
	): Promise<KanbanBoard> {
		const kanban: KanbanBoard = {};

		try {
			this.logger.log(`Parsing Kanban content for: ${file.path}`);

			// Split content into lines
			const lines = content.split("\n");
			let currentColumn = "";

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];

				// Check for column header (## Column Name)
				if (line.startsWith("## ")) {
					currentColumn = line.substring(3).trim();
					if (!kanban[currentColumn]) {
						kanban[currentColumn] = { items: [] };
					}
					this.logger.log(`Found column: ${currentColumn}`);
					continue;
				}

				// Check for list item (starts with "- ")
				if (currentColumn && line.trim().startsWith("- ")) {
					// Get complete card content including sub-items
					let cardText = line;
					let j = i + 1;

					// Include indented sub-items
					while (
						j < lines.length &&
						(lines[j].startsWith("  ") ||
							lines[j].startsWith("\t") ||
							lines[j].trim() === "")
					) {
						cardText += "\n" + lines[j];
						j++;
					}

					kanban[currentColumn].items.push({ text: cardText });

					this.logger.log(
						`Found card in ${currentColumn}: ${cardText.substring(0, 50)}...`
					);

					// Skip the lines we already processed
					i = j - 1;
				}
			}

			this.logger.log(
				`Parsed ${Object.keys(kanban).length} columns:`,
				Object.keys(kanban)
			);
		} catch (error) {
			console.error("Error parsing Kanban content:", error);
		}

		return kanban;
	}

	/**
	 * Get checkbox state for a specific kanban column
	 */
	getCheckboxStateForColumn(columnName: string): string {
		if (!this.settings.enableCustomCheckboxStates) {
			return "[ ]"; // Default unchecked state
		}

		const mapping = this.settings.kanbanColumnCheckboxMappings.find(
			(m) => m.columnName.toLowerCase() === columnName.toLowerCase()
		);

		return mapping ? mapping.checkboxState : "[ ]";
	}

	/**
	 * Handle changes in Kanban board files to detect card movements and update card checkbox states
	 */
	async handleKanbanBoardChange(
		kanbanFile: TFile,
		newContent: string
	): Promise<void> {
		try {
			// Validate inputs
			if (!this.fileService.isValidFile(kanbanFile)) {
				this.logger.error(
					`Invalid file for Kanban board change: ${kanbanFile?.path}`
				);
				return;
			}

			if (!this.fileService.isValidContent(newContent)) {
				this.logger.error(`Invalid content for Kanban board change`);
				return;
			}

			// Check rate limit
			if (!this.fileService.checkRateLimit(kanbanFile.path)) {
				return;
			}

			this.logger.log(
				`handleKanbanBoardChange called for: ${kanbanFile.path}`
			);

			if (
				!this.settings.enableKanbanToFileSync ||
				!this.settings.enableCustomCheckboxStates
			) {
				this.logger.log("Kanban sync disabled, skipping...");
				return;
			}

			const filePath = kanbanFile.path;
			const oldContent = this.lastKanbanContent.get(filePath) || "";

			// Check if we're currently updating from auto-sync or other operations
			if (this.isUpdatingFromKanban) {
				this.logger.log(
					"Skipping card movement detection - currently updating from auto-sync or other operations"
				);
				return;
			}

			// Check if auto-sync recently ran on this file
			if (this.autoSyncedFiles.has(filePath)) {
				const timeSinceLastUpdate =
					Date.now() - (this.lastFileUpdateMap.get(filePath) || 0);
				if (timeSinceLastUpdate < 2000) {
					this.logger.log(
						`Skipping card movement detection - auto-sync ran recently (${timeSinceLastUpdate}ms ago)`
					);
					this.lastKanbanContent.set(filePath, newContent);
					return;
				}
			}

			// Update the last file update timestamp
			this.lastFileUpdateMap.set(filePath, Date.now());

			this.logger.log(
				`Old content length: ${oldContent.length}, New content length: ${newContent.length}`
			);

			// Store the new content for next comparison
			this.lastKanbanContent.set(filePath, newContent);

			// Skip if this is the first time we see this file
			if (!oldContent) {
				this.logger.log(
					`First time seeing Kanban board: ${filePath}, storing content for next time`
				);
				return;
			}

			// Skip if content is identical
			if (oldContent === newContent) {
				this.logger.log("Content unchanged, skipping...");
				return;
			}

			// STEP 1: Detect actual card movements first
			const actualCardMovements = await this.detectActualCardMovements(
				oldContent,
				newContent,
				kanbanFile
			);

			this.logger.log(
				`Detected ${actualCardMovements.length} actual card movements:`,
				actualCardMovements
			);

			// STEP 2: Process legitimate card movements and update their checkbox states
			let finalContent = newContent;
			if (actualCardMovements.length > 0) {
				finalContent = await this.updateCardCheckboxStatesInKanban(
					oldContent,
					newContent,
					kanbanFile,
					actualCardMovements
				);

				this.logger.log(
					`Updated content for ${actualCardMovements.length} card movements`
				);
			}

			// STEP 3: Apply protection for non-moved cards (only if protection is enabled)
			if (this.settings.enableKanbanNormalizationProtection) {
				const isKanbanNormalization = await this.detectKanbanNormalization(
					kanbanFile,
					oldContent,
					finalContent,
					actualCardMovements
				);
				if (isKanbanNormalization) {
					this.logger.log(
						"Detected Kanban plugin normalization - protecting custom checkbox states for non-moved cards"
					);
					finalContent = await this.protectCustomCheckboxStatesSelective(
						kanbanFile,
						oldContent,
						finalContent,
						actualCardMovements
					);
				}
			}

			// STEP 4: Proactively sync all checkbox states to match column mappings
			finalContent = await this.syncAllCheckboxStatesToMappings(
				kanbanFile,
				finalContent
			);

			// STEP 5: Update the Kanban board file if content changed
			if (finalContent !== newContent) {
				this.logger.log(
					`Content will be updated. Original length: ${newContent.length}, Final length: ${finalContent.length}`
				);

				// Set flag to prevent infinite loops
				this.isUpdatingFromKanban = true;

				await this.app.vault.modify(kanbanFile, finalContent);

				// Update our stored content
				this.lastKanbanContent.set(filePath, finalContent);

				// Try to force refresh Kanban UI
				await this.forceRefreshKanbanUI(kanbanFile);

				this.logger.log(
					`Successfully updated checkbox states in Kanban board: ${kanbanFile.basename}`
				);

				// Reset flag after a short delay
				setTimeout(() => {
					this.isUpdatingFromKanban = false;
				}, 300);
			} else {
				this.logger.log("No checkbox state changes needed");
			}
		} catch (error) {
			this.fileService.handleError(
				error as Error,
				"handleKanbanBoardChange",
				false
			);
		}
	}

	/**
	 * Detect actual card movements between columns (not just checkbox state changes)
	 */
	private async detectActualCardMovements(
		oldContent: string,
		newContent: string,
		kanbanFile: TFile
	): Promise<CardMovement[]> {
		try {
			const movements: CardMovement[] = [];

			// Parse both old and new Kanban structures
			const oldKanban = await this.parseKanbanBoardContent(
				oldContent,
				kanbanFile
			);
			const newKanban = await this.parseKanbanBoardContent(
				newContent,
				kanbanFile
			);

			// Create more precise card tracking with position information
			const oldCardPositions = new Map<
				string,
				Array<{ column: string; index: number; originalText: string }>
			>();
			const newCardPositions = new Map<
				string,
				Array<{ column: string; index: number; originalText: string }>
			>();

			// Populate old card positions map
			for (const [columnName, columnData] of Object.entries(oldKanban)) {
				columnData.items.forEach((item, index) => {
					const normalizedCard = normalizeCardContentForComparison(
						item.text
					);
					if (!oldCardPositions.has(normalizedCard)) {
						oldCardPositions.set(normalizedCard, []);
					}
					oldCardPositions.get(normalizedCard)!.push({
						column: columnName,
						index: index,
						originalText: item.text,
					});
				});
			}

			// Populate new card positions and detect movements
			for (const [columnName, columnData] of Object.entries(newKanban)) {
				columnData.items.forEach((item, index) => {
					const normalizedCard = normalizeCardContentForComparison(
						item.text
					);
					if (!newCardPositions.has(normalizedCard)) {
						newCardPositions.set(normalizedCard, []);
					}
					newCardPositions.get(normalizedCard)!.push({
						column: columnName,
						index: index,
						originalText: item.text,
					});
				});
			}

			// Detect movements by comparing card distributions across columns
			for (const [normalizedCard, newPositions] of newCardPositions) {
				const oldPositions = oldCardPositions.get(normalizedCard) || [];

				// Check for cards that appear in new columns where they weren't before
				for (const newPos of newPositions) {
					const wasInThisColumn = oldPositions.some(
						(oldPos) => oldPos.column === newPos.column
					);

					if (!wasInThisColumn && oldPositions.length > 0) {
						// This card appears in a new column - it's a movement
						// Find the most likely source column (the one that lost a card)
						const oldColumnCounts = new Map<string, number>();
						const newColumnCounts = new Map<string, number>();

						// Count cards in each column
						oldPositions.forEach((pos) => {
							oldColumnCounts.set(
								pos.column,
								(oldColumnCounts.get(pos.column) || 0) + 1
							);
						});
						newPositions.forEach((pos) => {
							newColumnCounts.set(
								pos.column,
								(newColumnCounts.get(pos.column) || 0) + 1
							);
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
									cardIndex: newPos.index,
								});

								this.logger.log(
									`Detected card movement: "${normalizedCard.substring(
										0,
										30
									)}..." from "${oldColumn}" to "${newPos.column}"`
								);
								break; // Only record one movement per card instance
							}
						}
					}
				}
			}

			return movements;
		} catch (error) {
			this.fileService.handleError(
				error as Error,
				"detectActualCardMovements",
				false
			);
			return [];
		}
	}

	/**
	 * Update checkbox states in Kanban board based on card movements
	 */
	private async updateCardCheckboxStatesInKanban(
		oldContent: string,
		newContent: string,
		kanbanFile: TFile,
		actualCardMovements: CardMovement[]
	): Promise<string> {
		try {
			this.logger.log("Starting card checkbox state update process...");
			this.logger.log(
				`Processing ${actualCardMovements.length} actual card movements`
			);

			// If no actual card movements, return original content
			if (actualCardMovements.length === 0) {
				this.logger.log(
					"No actual card movements to process, returning original content"
				);
				return newContent;
			}

			// Parse new Kanban structure to find cards to update
			const newKanban = await this.parseKanbanBoardContent(
				newContent,
				kanbanFile
			);

			// Split content into lines for position-based replacement
			const lines = newContent.split("\n");
			let changesFound = 0;

			// Process only the cards that actually moved
			for (const movement of actualCardMovements) {
				const {
					card: normalizedCard,
					oldColumn,
					newColumn,
					cardIndex,
				} = movement;

				this.logger.log(
					`Processing movement: "${normalizedCard.substring(
						0,
						30
					)}..." from "${oldColumn}" to "${newColumn}"`
				);

				// Find the actual card in the new content using the specific index
				const targetColumn = newKanban[newColumn];
				if (!targetColumn) {
					this.logger.log(
						`Target column "${newColumn}" not found in new content`
					);
					continue;
				}

				// Use the specific card index to get the exact card that moved
				if (cardIndex >= targetColumn.items.length) {
					this.logger.log(
						`Card index ${cardIndex} out of range for column "${newColumn}" (has ${targetColumn.items.length} items)`
					);
					continue;
				}

				const foundCard = targetColumn.items[cardIndex];

				// Double-check that this is the right card
				const itemNormalized = normalizeCardContentForComparison(
					foundCard.text
				);
				if (itemNormalized !== normalizedCard) {
					this.logger.log(
						`Card at index ${cardIndex} doesn't match expected content. Expected: "${normalizedCard}", Found: "${itemNormalized}"`
					);
					continue;
				}

				// Update the checkbox state for this card
				const targetCheckboxState =
					this.getCheckboxStateForColumn(newColumn);
				const updatedCardText = updateCheckboxStateInCardText(
					foundCard.text,
					targetCheckboxState
				);

				this.logger.log(`Target checkbox state: "${targetCheckboxState}"`);
				this.logger.log(`Original card: ${foundCard.text}`);
				this.logger.log(`Updated card: ${updatedCardText}`);

				// Use position-based replacement to update only this specific card
				if (updatedCardText !== foundCard.text) {
					// Use the specific card index to find the exact position in the content
					const cardPosition = this.findCardPositionByIndex(
						lines,
						newColumn,
						cardIndex
					);
					if (cardPosition !== -1) {
						// Replace only the specific card at the found position
						const cardLines = foundCard.text.split("\n");
						const updatedCardLines = updatedCardText.split("\n");

						// Replace the card lines at the specific position
						lines.splice(
							cardPosition,
							cardLines.length,
							...updatedCardLines
						);
						changesFound++;

						this.logger.log(
							`Successfully updated card checkbox state at position ${cardPosition} (index ${cardIndex}) from "${oldColumn}" to "${newColumn}": ${targetCheckboxState}`
						);
					} else {
						this.logger.log(
							`Could not find position for card at index ${cardIndex} in column "${newColumn}"`
						);
					}
				} else {
					this.logger.log(
						`No changes needed for card (already has correct checkbox state)`
					);
				}
			}

			this.logger.log(
				`Card checkbox update complete. Changes found: ${changesFound} out of ${actualCardMovements.length} movements`
			);

			return lines.join("\n");
		} catch (error) {
			this.fileService.handleError(
				error as Error,
				"updateCardCheckboxStatesInKanban",
				false
			);
			return newContent;
		}
	}

	/**
	 * Find the exact position of a card by its index within a specific column
	 */
	private findCardPositionByIndex(
		lines: string[],
		targetColumn: string,
		cardIndex: number
	): number {
		let currentColumn = "";
		let inTargetColumn = false;
		let cardCount = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Check for column header
			if (line.startsWith("## ")) {
				currentColumn = line.substring(3).trim();
				inTargetColumn =
					currentColumn.toLowerCase() === targetColumn.toLowerCase();
				cardCount = 0; // Reset card count for new column
				continue;
			}

			// Only check for cards when we're in the target column
			if (inTargetColumn && line.trim().startsWith("- ")) {
				// Check if this is the card we're looking for
				if (cardCount === cardIndex) {
					this.logger.log(
						`Found card at position ${i} (index ${cardIndex}) in column "${targetColumn}"`
					);
					return i;
				}

				cardCount++;

				// Skip sub-items to avoid counting them as separate cards
				let j = i + 1;
				while (
					j < lines.length &&
					(lines[j].startsWith("  ") ||
						lines[j].startsWith("\t") ||
						lines[j].trim() === "")
				) {
					j++;
				}
				i = j - 1;
			}
		}

		this.logger.log(
			`Card at index ${cardIndex} not found in column "${targetColumn}" (found ${cardCount} cards total)`
		);
		return -1;
	}

	/**
	 * Find the exact position of a card within content lines under a specific column
	 */
	findCardPositionInContent(
		cardText: string,
		lines: string[],
		targetColumn: string
	): number {
		let currentColumn = "";
		let inTargetColumn = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Check for column header
			if (line.startsWith("## ")) {
				currentColumn = line.substring(3).trim();
				inTargetColumn =
					currentColumn.toLowerCase() === targetColumn.toLowerCase();
				continue;
			}

			// Only check for cards when we're in the target column
			if (inTargetColumn && line.trim().startsWith("- ")) {
				// Get complete card content including sub-items
				let completeCardText = line;
				let j = i + 1;

				// Include indented sub-items
				while (
					j < lines.length &&
					(lines[j].startsWith("  ") ||
						lines[j].startsWith("\t") ||
						lines[j].trim() === "")
				) {
					completeCardText += "\n" + lines[j];
					j++;
				}

				// Check if this matches our target card
				if (completeCardText.trim() === cardText.trim()) {
					this.logger.log(
						`Found card at position ${i} in column "${targetColumn}"`
					);
					return i;
				}

				// Skip the lines we already processed
				i = j - 1;
			}
		}

		this.logger.log(`Card not found in column "${targetColumn}"`);
		return -1;
	}

	/**
	 * Detect if a change is caused by Kanban plugin normalization
	 */
	private async detectKanbanNormalization(
		kanbanFile: TFile,
		oldContent: string,
		newContent: string,
		knownMovements: CardMovement[] = []
	): Promise<boolean> {
		try {
			const filePath = kanbanFile.path;
			const now = Date.now();

			// Initialize detector state if not exists
			if (!this.kanbanNormalizationDetector.has(filePath)) {
				this.kanbanNormalizationDetector.set(filePath, {
					preChangeCheckpoints: new Map(),
					lastKanbanUIInteraction: 0,
					pendingNormalizationCheck: null,
				});
			}

			const detector = this.kanbanNormalizationDetector.get(filePath)!;

			// Analyze the pattern of changes first
			const normalizationPatterns = this.analyzeCheckboxNormalizationPatterns(
				oldContent,
				newContent
			);

			// Enhanced detection logic - focus on content patterns rather than timing
			const hasUnwantedNormalization = this.detectUnwantedKanbanNormalization(
				oldContent,
				newContent,
				knownMovements
			);

			// Update interaction timestamp for future detections
			detector.lastKanbanUIInteraction = now;

			this.logger.log(`Kanban normalization analysis for ${filePath}:`, {
				normalizationPatterns,
				hasUnwantedNormalization,
				contentLengthSame: oldContent.length === newContent.length,
			});

			// Return true if this looks like unwanted Kanban normalization
			return hasUnwantedNormalization || normalizationPatterns.hasNormalization;
		} catch (error) {
			console.error("Error detecting Kanban normalization:", error);
			return false;
		}
	}

	/**
	 * Detect unwanted Kanban normalization based on content patterns
	 */
	private detectUnwantedKanbanNormalization(
		oldContent: string,
		newContent: string,
		knownMovements: CardMovement[] = []
	): boolean {
		const oldLines = oldContent.split("\n");
		const newLines = newContent.split("\n");

		// Look for patterns where custom states in non-completed columns get converted to [x]
		for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
			const oldLine = oldLines[i];
			const newLine = newLines[i];

			// Find what column this line is in
			let currentColumn = "";
			for (let j = i; j >= 0; j--) {
				if (oldLines[j].startsWith("## ")) {
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
				const expectedStateChar = expectedState.replace(/[\[\]]/g, "");

				// Check if this change is part of a legitimate movement
				const isLegitimateMovement = knownMovements.some(
					(movement) =>
						movement.newColumn.toLowerCase() ===
						currentColumn.toLowerCase()
				);

				// Detect unwanted conversion: custom state → [x] when it should be something else
				// BUT only if it's not part of a legitimate movement
				if (
					oldState === expectedStateChar &&
					newState === "x" &&
					expectedStateChar !== "x" &&
					!isLegitimateMovement
				) {
					this.logger.log(
						`Detected unwanted normalization in column "${currentColumn}": [${oldState}] → [${newState}] (expected: ${expectedState})`
					);
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Analyze checkbox normalization patterns
	 */
	analyzeCheckboxNormalizationPatterns(
		oldContent: string,
		newContent: string
	): CheckboxNormalizationAnalysis {
		const oldLines = oldContent.split("\n");
		const newLines = newContent.split("\n");
		const normalizedStates: Array<{
			line: number;
			from: string;
			to: string;
		}> = [];

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
				if (
					oldState !== newState &&
					oldState !== " " &&
					oldState !== "x" &&
					(newState === "x" || newState === " ")
				) {
					normalizedStates.push({
						line: i,
						from: `[${oldState}]`,
						to: `[${newState}]`,
					});
				}
			}
		}

		return {
			hasNormalization: normalizedStates.length > 0,
			normalizedStates,
		};
	}

	/**
	 * Selective protection that only protects non-moved cards from unwanted normalization
	 */
	private async protectCustomCheckboxStatesSelective(
		kanbanFile: TFile,
		oldContent: string,
		newContent: string,
		knownMovements: CardMovement[]
	): Promise<string> {
		try {
			// Analyze what was normalized
			const analysis = this.analyzeCheckboxNormalizationPatterns(
				oldContent,
				newContent
			);

			if (!analysis.hasNormalization) {
				this.logger.log(
					"No normalization detected, no selective protection needed"
				);
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
			const statesNeedingProtection = analysis.normalizedStates.filter(
				(state) => !legitimateNormalizations.includes(state)
			);

			if (statesNeedingProtection.length === 0) {
				this.logger.log(
					"All normalizations are legitimate movements, no protection needed"
				);
				return newContent;
			}

			// Create protected content by restoring only non-legitimate changes
			const protectedContent = this.restoreCustomCheckboxStates(
				oldContent,
				newContent,
				statesNeedingProtection,
				kanbanFile
			);

			this.logger.log(
				`Selectively protecting ${statesNeedingProtection.length} out of ${analysis.normalizedStates.length} normalized states`
			);

			return protectedContent;
		} catch (error) {
			console.error("Error in selective protection:", error);
			return newContent;
		}
	}

	/**
	 * Filter out normalizations that correspond to legitimate card movements
	 */
	private filterLegitimateNormalizations(
		normalizedStates: Array<{ line: number; from: string; to: string }>,
		knownMovements: CardMovement[],
		newContent: string,
		kanbanFile: TFile
	): Array<{ line: number; from: string; to: string }> {
		const legitimateNormalizations: Array<{
			line: number;
			from: string;
			to: string;
		}> = [];
		const lines = newContent.split("\n");

		for (const normalizedState of normalizedStates) {
			const lineIndex = normalizedState.line;

			if (lineIndex < lines.length) {
				const line = lines[lineIndex];

				// Find which column this line is in
				const columnName = this.findLineColumn(line, lines, lineIndex);
				if (columnName) {
					// Check if there's a known movement to this column
					const hasMovementToColumn = knownMovements.some(
						(movement) =>
							movement.newColumn.toLowerCase() ===
							columnName.toLowerCase()
					);

					if (hasMovementToColumn) {
						// Get expected state for this column
						const expectedState =
							this.getCheckboxStateForColumn(columnName);

						// If the normalization results in the expected state for this column, it's legitimate
						if (normalizedState.to === expectedState) {
							legitimateNormalizations.push(normalizedState);

							this.logger.log(
								`Legitimate normalization at line ${lineIndex}: ${normalizedState.from} → ${normalizedState.to} for column "${columnName}"`
							);
						}
					}
				}
			}
		}

		return legitimateNormalizations;
	}

	/**
	 * Restore custom checkbox states while preserving other changes
	 */
	private restoreCustomCheckboxStates(
		oldContent: string,
		newContent: string,
		normalizedStates: Array<{ line: number; from: string; to: string }>,
		kanbanFile: TFile
	): string {
		const lines = newContent.split("\n");
		let restoredCount = 0;

		for (const normalizedState of normalizedStates) {
			const lineIndex = normalizedState.line;

			if (lineIndex < lines.length) {
				const line = lines[lineIndex];

				// Only restore if the column mapping supports this custom state
				const columnName = this.findLineColumn(line, lines, lineIndex);
				if (columnName) {
					const expectedState =
						this.getCheckboxStateForColumn(columnName);

					// If the old state matches what we expect for this column, restore it
					if (normalizedState.from === expectedState) {
						lines[lineIndex] = line.replace(
							normalizedState.to,
							normalizedState.from
						);
						restoredCount++;

						this.logger.log(
							`Restored line ${lineIndex}: ${normalizedState.to} → ${normalizedState.from} for column "${columnName}"`
						);
					}
				}
			}
		}

		this.logger.log(
			`Restored ${restoredCount} out of ${normalizedStates.length} normalized states`
		);

		return lines.join("\n");
	}

	/**
	 * Find which column a line belongs to
	 */
	private findLineColumn(
		line: string,
		allLines: string[],
		lineIndex: number
	): string | null {
		// Search backwards from current line to find the column header
		for (let i = lineIndex; i >= 0; i--) {
			const currentLine = allLines[i];
			if (currentLine.startsWith("## ")) {
				return currentLine.substring(3).trim();
			}
		}
		return null;
	}

	/**
	 * Detect immediate Kanban normalization (real-time detection)
	 */
	detectImmediateKanbanNormalization(
		oldContent: string,
		newContent: string
	): boolean {
		const oldLines = oldContent.split("\n");
		const newLines = newContent.split("\n");
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
					if (oldState !== " " && oldState !== "x" && newState === "x") {
						customToXConversions++;

						this.logger.log(
							`Immediate normalization detected: [${oldState}] → [${newState}] on line ${i}`
						);
					}
				}
			}
		}

		// Enhanced detection criteria:
		// 1. Multiple custom states converted to [x] (strong indicator of Kanban normalization)
		// 2. High ratio of custom→[x] conversions vs total changes
		const hasMultipleCustomToX = customToXConversions >= 2;
		const hasHighCustomToXRatio =
			normalizationCount > 0 &&
			customToXConversions / normalizationCount >= 0.5;

		this.logger.log(
			`Enhanced normalization detection: ${customToXConversions} custom→[x] out of ${normalizationCount} total changes`
		);

		return hasMultipleCustomToX || hasHighCustomToXRatio;
	}

	/**
	 * Revert Kanban normalization by restoring custom states
	 */
	revertKanbanNormalization(
		oldContent: string,
		newContent: string,
		kanbanFile: TFile
	): string {
		const oldLines = oldContent.split("\n");
		const newLines = newContent.split("\n");
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
					let currentColumn = "";
					for (let j = i; j >= 0; j--) {
						if (newLines[j].startsWith("## ")) {
							currentColumn = newLines[j].substring(3).trim();
							break;
						}
					}

					if (currentColumn) {
						// Get expected state for this column
						const expectedState =
							this.getCheckboxStateForColumn(currentColumn);
						const expectedStateChar = expectedState.replace(
							/[\[\]]/g,
							""
						);

						// Revert if:
						// 1. Old state was correct for this column AND
						// 2. New state is wrong for this column
						if (
							oldState === expectedStateChar &&
							newState !== expectedStateChar
						) {
							// Only change the checkbox state, preserve the card content
							const newPrefix = newMatch[1]; // "- " part
							const newSuffix = newLine.substring(newMatch[0].length); // Everything after checkbox
							revertedLines[i] = `${newPrefix}[${oldState}]${newSuffix}`;
							revertCount++;

							this.logger.log(
								`Reverted line ${i} in column "${currentColumn}": [${newState}] → [${oldState}] (preserving content)`
							);
						}
					}
				}
			}
		}

		this.logger.log(
			`Reverted ${revertCount} out of ${totalNormalizations} normalizations`
		);

		return revertedLines.join("\n");
	}

	/**
	 * Proactively sync all checkbox states in Kanban board to match column mappings
	 */
	async syncAllCheckboxStatesToMappings(
		kanbanFile: TFile,
		content: string
	): Promise<string> {
		try {
			this.logger.log(
				`Syncing all checkbox states to mappings for: ${kanbanFile.path}`
			);

			// Parse Kanban board structure
			const kanban = await this.parseKanbanBoardContent(content, kanbanFile);
			if (!kanban || Object.keys(kanban).length === 0) {
				this.logger.log(
					`Could not parse Kanban board structure, returning original content`
				);
				return content;
			}

			// Split content into lines for position-based replacement
			const lines = content.split("\n");
			let totalChanges = 0;

			// Process each column and sync all cards to have correct checkbox states
			for (const [columnName, columnData] of Object.entries(kanban)) {
				const targetCheckboxState =
					this.getCheckboxStateForColumn(columnName);

				this.logger.log(
					`Syncing column "${columnName}" to checkbox state "${targetCheckboxState}" (${columnData.items.length} cards)`
				);

				// Update each card in this column using position-based replacement
				for (const item of columnData.items) {
					// Check if the card already has the correct checkbox state
					const currentCheckboxMatch = item.text.match(
						/^(\s*- )\[([^\]]*)\]/
					);
					const currentCheckboxState = currentCheckboxMatch
						? `[${currentCheckboxMatch[2]}]`
						: null;

					// Only update if the current state is different from target state
					if (currentCheckboxState !== targetCheckboxState) {
						const updatedCardText = updateCheckboxStateInCardText(
							item.text,
							targetCheckboxState
						);

						if (updatedCardText !== item.text) {
							const cardPosition = this.findCardPositionInContent(
								item.text,
								lines,
								columnName
							);
							if (cardPosition !== -1) {
								// Replace only the specific card at the found position
								const cardLines = item.text.split("\n");
								const updatedCardLines = updatedCardText.split("\n");

								// Replace the card lines at the specific position
								lines.splice(
									cardPosition,
									cardLines.length,
									...updatedCardLines
								);
								totalChanges++;

								this.logger.log(
									`  Synced card at position ${cardPosition}: ${item.text.substring(
										0,
										30
									)}... → ${targetCheckboxState} (was ${currentCheckboxState})`
								);
							}
						}
					}
				}
			}

			this.logger.log(
				`Sync complete: ${totalChanges} cards updated to match column mappings`
			);

			return lines.join("\n");
		} catch (error) {
			console.error("Error syncing checkbox states to mappings:", error);
			return content;
		}
	}

	/**
	 * Auto-sync all checkbox states in a Kanban board to match column mappings
	 */
	async autoSyncKanbanCheckboxStates(kanbanFile: TFile): Promise<void> {
		try {
			// Check if we're already updating to prevent conflicts
			if (this.isUpdatingFromKanban) {
				this.logger.log(
					`Auto-sync skipped - update already in progress for: ${kanbanFile.path}`
				);
				return;
			}

			this.logger.log(
				`Starting auto-sync for Kanban board: ${kanbanFile.path}`
			);

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

			// Sync all checkbox states
			const syncedContent = await this.syncAllCheckboxStatesToMappings(
				kanbanFile,
				content
			);

			// Update the file if changes were made
			if (syncedContent !== content) {
				await this.app.vault.modify(kanbanFile, syncedContent);

				// Update lastKanbanContent to prevent conflicts with card movement detection
				this.lastKanbanContent.set(kanbanFile.path, syncedContent);

				this.logger.log(
					`Auto-sync complete: updated ${kanbanFile.basename}`
				);

				// Show notification to user
				new Notice(`Auto-synced card checkbox states in ${kanbanFile.basename}`);
			} else {
				this.logger.log(
					`Auto-sync complete: No changes needed for ${kanbanFile.basename}`
				);
			}
		} catch (error) {
			console.error("Error in auto-sync Kanban checkbox states:", error);
			// Remove from auto-synced set so it can be retried
			this.autoSyncedFiles.delete(kanbanFile.path);
		} finally {
			// Always reset flag after operation completes
			setTimeout(() => {
				this.isUpdatingFromKanban = false;
				this.logger.log(`Auto-sync flag reset for: ${kanbanFile.path}`);
			}, 200);
		}
	}

	/**
	 * Force refresh Kanban UI after modifying file content
	 */
	async forceRefreshKanbanUI(kanbanFile: TFile): Promise<void> {
		try {
			this.logger.log(
				`Attempting to force refresh Kanban UI for: ${kanbanFile.path}`
			);

			// Method 1: If this is the currently active file, try to refresh the view
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.path === kanbanFile.path) {
				// Import MarkdownView dynamically to avoid circular dependencies
				const { MarkdownView } = await import("obsidian");
				const activeView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					// Force re-render by triggering a view update
					setTimeout(() => {
						activeView.requestSave();
					}, 100);
				}
			}

			// Method 2: Trigger workspace layout change to force refresh
			setTimeout(() => {
				this.app.workspace.trigger("layout-change");
			}, 150);

			// Method 3: If file is open in a leaf, try to refresh that leaf
			const leaves = this.app.workspace.getLeavesOfType("markdown");
			const { MarkdownView } = await import("obsidian");
			for (const leaf of leaves) {
				const view = leaf.view as InstanceType<typeof MarkdownView>;
				if (view.file && view.file.path === kanbanFile.path) {
					setTimeout(() => {
						// Force view to re-read file content
						view.load();
					}, 200);
					break;
				}
			}

			this.logger.log(
				`Force refresh attempts completed for: ${kanbanFile.path}`
			);
		} catch (error) {
			this.logger.log(`Error forcing Kanban UI refresh: ${error}`);
		}
	}

	/**
	 * Reset all Kanban conflict state
	 */
	resetConflictState(): void {
		this.isUpdatingFromKanban = false;
		this.lastKanbanContent.clear();
		this.autoSyncedFiles.clear();
		this.kanbanNormalizationDetector.clear();
	}

	/**
	 * Clear auto-sync cache
	 */
	clearAutoSyncCache(): void {
		this.autoSyncedFiles.clear();
	}

	// ============================================================================
	// Kanban Board Management Methods (moved from ProgressBarView)
	// ============================================================================

	/**
	 * Check if a Kanban board content contains a reference to the given file
	 */
	containsFileReference(boardContent: string, file: TFile): boolean {
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
	 * Check if a card content exactly matches a file reference
	 */
	isExactCardForFile(cardContent: string, file: TFile): boolean {
		const obsidianLinks = extractObsidianLinks(cardContent);
		const markdownLinks = extractMarkdownLinks(cardContent);

		const fileName = file.basename;
		const filePath = file.path;
		const filePathWithoutExtension = filePath.replace(/\.md$/, "");

		// Check Obsidian links first
		for (const link of obsidianLinks) {
			const { path } = link;
			if (path === fileName || path === filePathWithoutExtension || path === filePath) {
				return true;
			}
		}

		// Then check Markdown links
		for (const link of markdownLinks) {
			const { url } = link;
			if (url === filePath || url === filePathWithoutExtension) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Parse Kanban board structure into columns and items from a file
	 */
	async parseKanbanBoardFromFile(file: TFile): Promise<Record<string, { items: Array<{ text: string }> }>> {
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
		} catch (error) {
			this.logger.error(`Error parsing Kanban board ${file.path}:`, error as Error);
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
		const lines = columnContent.split("\n");
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
	 * Wait for MetadataCache to update for a specific file
	 */
	async waitForCacheUpdate(file: TFile, timeoutMs: number = 1000): Promise<void> {
		return new Promise((resolve) => {
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
	 * Get the status from the file's YAML frontmatter
	 */
	async getStatusFromYaml(file: TFile): Promise<string | null> {
		const fileCache = this.app.metadataCache.getFileCache(file);

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
			this.logger.error(`Error accessing frontmatter for ${file.path}:`, error as Error);
		}

		return null;
	}

	/**
	 * Calculate status based on task progress
	 */
	calculateStatusFromProgress(completedTasks: number, totalTasks: number): string {
		if (totalTasks === 0 || completedTasks === 0) {
			return this.settings.statusTodo;
		} else if (completedTasks === totalTasks) {
			return this.settings.statusCompleted;
		} else {
			return this.settings.statusInProgress;
		}
	}

	/**
	 * Get the complete content of a card, including any sub-items
	 */
	getCompleteCardContent(lines: string[], startIndex: number): { content: string; lineCount: number } {
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
	 * Update checkbox states in card content based on target column
	 */
	updateCheckboxStatesInCard(cardContent: string, targetColumnName: string): string {
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
			lines[0] = lines[0].replace(
				checkboxPattern,
				(match, prefix, suffix) => {
					return `${prefix}${targetCheckboxState}${suffix}`;
				}
			);
		}

		return lines.join("\n");
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
			const kanbanColumns = await this.parseKanbanBoardFromFile(boardFile);
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
					cardLines = cardLines.map((line) => {
						return this.updateCheckboxStatesInCard(line, targetColumnName!);
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
				}
			}

			// If card was moved, update the file
			if (cardMoved) {
				newContent = lines.join("\n");
				await this.app.vault.modify(boardFile, newContent);
			}

			return newContent;
		} catch (error) {
			this.logger.error("Error moving card in Kanban board:", error as Error);
			return boardContent;
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
			const kanbanColumns = await this.parseKanbanBoardFromFile(kanbanFile);
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
			this.logger.error("Error adding file to Kanban board:", error as Error);
			return false;
		}
	}

	/**
	 * Process all Kanban boards that might reference the target file
	 */
	async processKanbanBoardsForFile(file: TFile, currentStatus: string): Promise<number> {
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
	 * Cleanup resources
	 */
	cleanup(): void {
		this.lastKanbanContent.clear();
		this.autoSyncedFiles.clear();
		this.lastFileUpdateMap.clear();
		this.kanbanNormalizationDetector.clear();
		this.isUpdatingFromKanban = false;
	}
}
