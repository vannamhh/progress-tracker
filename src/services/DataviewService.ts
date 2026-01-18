import { App } from "obsidian";
import { DataviewApi, ObsidianApp } from "../interfaces/types";
import { DebugLogger } from "../utils/logger";

/**
 * Service for managing Dataview API integration
 * Provides methods for safely accessing and checking Dataview availability
 */
export class DataviewService {
	private app: App;
	private logger: DebugLogger;
	private dvAPI: DataviewApi | null = null;
	private checkInterval: number | null = null;

	constructor(app: App, logger: DebugLogger) {
		this.app = app;
		this.logger = logger;
	}

	/**
	 * Safely get Dataview API with proper type checking
	 * @returns DataviewApi instance or null if not available
	 */
	getDataviewAPI(): DataviewApi | null {
		try {
			// Method 1: Through window object (most reliable)
			if (typeof window !== "undefined" && window.DataviewAPI) {
				return window.DataviewAPI;
			}

			// Method 2: Through app.plugins with type safety
			const obsidianApp = this.app as ObsidianApp;
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

	/**
	 * Check for Dataview API availability and cache the result
	 * @returns DataviewApi instance or null
	 */
	checkAndCacheAPI(): DataviewApi | null {
		this.dvAPI = this.getDataviewAPI();
		return this.dvAPI;
	}

	/**
	 * Get cached Dataview API
	 * @returns Cached DataviewApi instance or null
	 */
	getCachedAPI(): DataviewApi | null {
		return this.dvAPI;
	}

	/**
	 * Start periodic checking for Dataview API availability
	 * @param onFound - Callback when Dataview API is found, receives the API instance
	 * @param intervalMs - Check interval in milliseconds (default 2000)
	 */
	startPeriodicCheck(onFound?: (api: DataviewApi) => void, intervalMs: number = 2000): void {
		// Check immediately first
		this.dvAPI = this.getDataviewAPI();

		// If found immediately, call callback
		if (this.dvAPI) {
			if (onFound) {
				onFound(this.dvAPI);
			}
			return;
		}

		// If not found, set up interval to check again
		this.checkInterval = window.setInterval(() => {
			this.dvAPI = this.getDataviewAPI();
			if (this.dvAPI) {
				// If found, clear interval
				this.stopPeriodicCheck();

				// Call callback if provided
				if (onFound) {
					onFound(this.dvAPI);
				}
			}
		}, intervalMs);
	}

	/**
	 * Stop periodic checking for Dataview API
	 */
	stopPeriodicCheck(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
	}

	/**
	 * Check if Dataview API is available
	 * @returns true if Dataview API is available
	 */
	isAvailable(): boolean {
		return this.dvAPI !== null;
	}

	/**
	 * Cleanup resources
	 */
	cleanup(): void {
		this.stopPeriodicCheck();
		this.dvAPI = null;
	}
}
