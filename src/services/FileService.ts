import { App, TFile, Notice } from "obsidian";
import { DebugLogger } from "../utils/logger";
import { validateContent } from "../utils/helpers";

/**
 * Service for safe file operations with validation and rate limiting
 */
export class FileService {
	private app: App;
	private logger: DebugLogger;
	private fileOperationLimiter: Map<string, number> = new Map();
	private readonly FILE_OPERATION_DELAY = 100; // Minimum ms between operations per file

	constructor(app: App, logger: DebugLogger) {
		this.app = app;
		this.logger = logger;
	}

	/**
	 * Validate file before performing operations
	 * @param file - File to validate
	 * @returns true if file is safe to operate on
	 */
	isValidFile(file: TFile | null): boolean {
		if (!file) return false;

		// Check if file path is safe (no path traversal)
		if (file.path.includes("..") || file.path.includes("//")) {
			this.logger.error(`Unsafe file path detected: ${file.path}`);
			return false;
		}

		// Check if file is markdown
		if (!file.path.endsWith(".md")) {
			this.logger.warn(`Non-markdown file: ${file.path}`);
			return false;
		}

		// Check file size (prevent processing extremely large files)
		if (file.stat.size > 10 * 1024 * 1024) {
			// 10MB limit
			this.logger.error(
				`File too large: ${file.path} (${file.stat.size} bytes)`
			);
			return false;
		}

		return true;
	}

	/**
	 * Validate content before processing
	 * @param content - Content to validate
	 * @returns true if content is safe to process
	 */
	isValidContent(content: string): boolean {
		const result = validateContent(content);
		if (!result.isValid) {
			this.logger.error(result.error || "Invalid content");
		}
		return result.isValid;
	}

	/**
	 * Check if file operation is rate limited
	 * @param filePath - Path of file to check
	 * @returns true if operation should be allowed
	 */
	checkRateLimit(filePath: string): boolean {
		const now = Date.now();
		const lastOperation = this.fileOperationLimiter.get(filePath);

		if (lastOperation && now - lastOperation < this.FILE_OPERATION_DELAY) {
			this.logger.warn(`Rate limited file operation: ${filePath}`);
			return false;
		}

		this.fileOperationLimiter.set(filePath, now);
		return true;
	}

	/**
	 * Safe async operation wrapper with error handling
	 * @param operation - Async operation to execute
	 * @param context - Context description for error handling
	 * @param fallbackValue - Value to return on error
	 */
	async safeAsyncOperation<T>(
		operation: () => Promise<T>,
		context: string,
		fallbackValue: T
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.logger.error(
				`${context}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				error instanceof Error ? error : undefined
			);
			return fallbackValue;
		}
	}

	/**
	 * Read file content safely with validation
	 * @param file - File to read
	 * @returns File content or null on error
	 */
	async readFileSafe(file: TFile): Promise<string | null> {
		if (!this.isValidFile(file)) {
			return null;
		}

		return this.safeAsyncOperation(
			async () => {
				const content = await this.app.vault.read(file);
				if (!this.isValidContent(content)) {
					return null;
				}
				return content;
			},
			`Reading file ${file.path}`,
			null
		);
	}

	/**
	 * Modify file content safely with validation and rate limiting
	 * @param file - File to modify
	 * @param content - New content
	 * @returns true if modification was successful
	 */
	async modifyFileSafe(file: TFile, content: string): Promise<boolean> {
		if (!this.isValidFile(file)) {
			return false;
		}

		if (!this.isValidContent(content)) {
			return false;
		}

		if (!this.checkRateLimit(file.path)) {
			return false;
		}

		return this.safeAsyncOperation(
			async () => {
				await this.app.vault.modify(file, content);
				return true;
			},
			`Modifying file ${file.path}`,
			false
		);
	}

	/**
	 * Standardized error handler for plugin operations
	 * @param error - Error object or message
	 * @param context - Context where error occurred
	 * @param showNotice - Whether to show user notification
	 */
	handleError(
		error: Error | string,
		context: string,
		showNotice: boolean = false
	): void {
		const errorMessage = error instanceof Error ? error.message : error;
		const fullMessage = `${context}: ${errorMessage}`;

		this.logger.error(
			fullMessage,
			error instanceof Error ? error : undefined
		);

		if (showNotice) {
			new Notice(`Progress Tracker Error: ${errorMessage}`);
		}
	}

	/**
	 * Cleanup resources
	 */
	cleanup(): void {
		this.fileOperationLimiter.clear();
	}
}
