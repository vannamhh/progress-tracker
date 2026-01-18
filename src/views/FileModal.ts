import { App, SuggestModal, TFile } from "obsidian";

/**
 * Helper class for file picking in settings
 */
export class FileSuggestModal extends SuggestModal<TFile> {
	onChooseItem: (file: TFile) => void;

	constructor(app: App) {
		super(app);
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
