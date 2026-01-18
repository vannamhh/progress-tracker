/**
 * Debug logger utility that only logs when debug mode is enabled
 * Prevents console spam in production builds
 */
export class DebugLogger {
	private isDebugEnabled: () => boolean;

	constructor(isDebugEnabled: () => boolean) {
		this.isDebugEnabled = isDebugEnabled;
	}

	/**
	 * Log a message with optional arguments
	 * @param message - Message to log
	 * @param args - Additional arguments to log
	 */
	log(message: string, ...args: any[]): void {
		if (this.isDebugEnabled()) {
			console.log(`[Progress Tracker] ${message}`, ...args);
		}
	}

	/**
	 * Log an error message with optional error object
	 * @param message - Error message
	 * @param error - Optional error object
	 */
	error(message: string, error?: Error): void {
		if (this.isDebugEnabled()) {
			console.error(`[Progress Tracker ERROR] ${message}`, error);
		}
	}

	/**
	 * Log a warning message with optional arguments
	 * @param message - Warning message
	 * @param args - Additional arguments to log
	 */
	warn(message: string, ...args: any[]): void {
		if (this.isDebugEnabled()) {
			console.warn(`[Progress Tracker WARNING] ${message}`, ...args);
		}
	}
}
