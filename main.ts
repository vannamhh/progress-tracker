import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, MarkdownView, ItemView, Editor, MarkdownPostProcessorContext, debounce, Notice } from 'obsidian';

// Định nghĩa interface cho DataviewAPI
interface DataviewApi {
	executeJs(code: string, container: HTMLElement, sourcePath?: string): Promise<any>;
	page(path: string): any;
	pages(source: string): any[];
	// Không sử dụng eval vì có thể không tồn tại trong một số phiên bản Dataview
}

// Định nghĩa interface cho window object để truy cập Dataview plugin
declare global {
	interface Window {
		DataviewAPI?: DataviewApi;
	}
}

// Hàm helper để lấy Dataview API
function getDataviewAPI(app: App): DataviewApi | null {
	// Cách 1: Thông qua window object
	// @ts-ignore
	if (window.DataviewAPI) {
		return window.DataviewAPI;
	}
	
	// Cách 2: Thông qua app.plugins
	// @ts-ignore
	const dataviewPlugin = app.plugins?.plugins?.dataview;
	if (dataviewPlugin && dataviewPlugin.api) {
		return dataviewPlugin.api;
	}
	
	// Cách 3: Kiểm tra xem plugin có được enable không
	// @ts-ignore
	if (app.plugins.enabledPlugins.has('dataview')) {
		console.log('Dataview plugin is enabled but API is not available yet');
		return null;
	}
	
	console.log('Dataview plugin is not enabled');
	return null;
}

interface TaskProgressBarSettings {
	mySetting: string;
	showDebugInfo: boolean;
}

const DEFAULT_SETTINGS: TaskProgressBarSettings = {
	mySetting: 'default',
	showDebugInfo: false
}

export default class TaskProgressBarPlugin extends Plugin {
	settings: TaskProgressBarSettings;
	dvAPI: DataviewApi | null = null;
	private sidebarView: TaskProgressBarView | null = null;
	private lastActiveFile: TFile | null = null;
	private lastFileContent: string = '';
	private dataviewCheckInterval: number | null = null;

	async onload() {
		await this.loadSettings();

		// Register view type for the sidebar
		this.registerView(
			'progress-tracker',
			(leaf) => (this.sidebarView = new TaskProgressBarView(leaf, this))
		);

		// Add icon to the left sidebar
		this.addRibbonIcon('bar-chart-horizontal', 'Progress Tracker', () => {
			this.activateView();
		});

		// Add settings tab
		this.addSettingTab(new TaskProgressBarSettingTab(this.app, this));

		// Kiểm tra Dataview API và thiết lập interval để kiểm tra lại nếu chưa có
		this.checkDataviewAPI();
		
		// Register event to update progress bar when file changes
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					this.lastActiveFile = file;
					this.updateLastFileContent(file);
					if (this.sidebarView) {
						this.sidebarView.updateProgressBar(file);
					}
				}
			})
		);

		// Register event to update progress bar when editor changes
		this.registerEvent(
			this.app.workspace.on('editor-change', debounce(async (editor, view) => {
				if (view instanceof MarkdownView && this.sidebarView) {
					// Lấy nội dung hiện tại của editor
					const content = editor.getValue();
					
					// Kiểm tra xem nội dung có chứa task hay không
					if (content.includes('- [') || content.includes('- [ ]') || content.includes('- [x]')) {
						// Cập nhật ngay lập tức
						if (this.lastActiveFile) {
							// Cập nhật nội dung file cuối cùng trước khi kiểm tra thay đổi
							this.lastActiveFile = view.file;
							
							// Cập nhật thanh tiến trình ngay lập tức
							this.sidebarView.updateProgressBar(view.file, content);
							
							// Sau đó mới cập nhật nội dung file cuối cùng
							this.lastFileContent = content;
						}
					}
				}
			}, 200)) // Giảm debounce xuống 200ms để phản ứng nhanh hơn
		);

		// Lắng nghe sự kiện keydown để phát hiện khi người dùng nhập task mới hoặc check/uncheck task
		this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
			// Kiểm tra xem có đang trong editor không
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && activeView.getMode() === 'source') {
				// Cập nhật ngay lập tức khi nhấn các phím liên quan đến task
				if (['Enter', 'Space', ']', 'x', 'X', 'Backspace', 'Delete'].includes(evt.key)) {
					// Cập nhật ngay lập tức
					setTimeout(() => {
						const content = activeView.editor.getValue();
						if (content.includes('- [') || content.includes('- [ ]') || content.includes('- [x]')) {
							this.lastActiveFile = activeView.file;
							
							// Cập nhật thanh tiến trình ngay lập tức
							if (this.sidebarView) {
								this.sidebarView.updateProgressBar(activeView.file, content);
							}
							
							// Sau đó mới cập nhật nội dung file cuối cùng
							this.lastFileContent = content;
						}
					}, 10); // Giảm thời gian chờ xuống 10ms
				}
			}
		});

		// Lắng nghe sự kiện click trong editor để phát hiện khi task được check/uncheck
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			
			// Kiểm tra xem click có phải vào checkbox của task không
			if (target && target.tagName === 'INPUT' && target.classList.contains('task-list-item-checkbox')) {
				// Đợi một chút để Obsidian cập nhật trạng thái task trong file
				setTimeout(async () => {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile && this.sidebarView) {
						// Đọc nội dung file hiện tại
						const content = await this.app.vault.read(activeFile);
						
						// Cập nhật thanh tiến trình ngay lập tức
						this.lastActiveFile = activeFile;
						this.sidebarView.updateProgressBar(activeFile, content);
						
						// Sau đó mới cập nhật nội dung file cuối cùng
						this.lastFileContent = content;
					}
				}, 50); // Giảm thời gian chờ xuống 50ms
			}
		});

		// Activate view when plugin loads - đợi một chút để Obsidian khởi động hoàn toàn
		setTimeout(() => {
			this.activateView();
		}, 1000);
	}

	// Kiểm tra Dataview API và thiết lập interval để kiểm tra lại nếu chưa có
	checkDataviewAPI() {
		// Kiểm tra ngay lập tức
		this.dvAPI = getDataviewAPI(this.app);
		
		// Nếu không tìm thấy, thiết lập interval để kiểm tra lại
		if (!this.dvAPI) {
			this.dataviewCheckInterval = window.setInterval(() => {
				this.dvAPI = getDataviewAPI(this.app);
				if (this.dvAPI) {
					console.log('Dataview API found');
					// Nếu tìm thấy, xóa interval
					if (this.dataviewCheckInterval) {
						clearInterval(this.dataviewCheckInterval);
						this.dataviewCheckInterval = null;
					}
					
					// Cập nhật sidebar nếu đang mở
					if (this.sidebarView && this.lastActiveFile) {
						this.sidebarView.updateProgressBar(this.lastActiveFile);
					}
				}
			}, 2000); // Kiểm tra mỗi 2 giây
		}
	}

	// Kiểm tra xem trạng thái task có thay đổi không
	hasTaskStatusChanged(newContent: string): boolean {
		// Nếu chưa có nội dung cũ, coi như đã thay đổi
		if (!this.lastFileContent) return true;
		
		// Đếm số lượng task hoàn thành trong nội dung cũ và mới
		// Sử dụng regex chính xác hơn để phát hiện task
		const oldCompletedTasks = (this.lastFileContent.match(/- \[x\]/gi) || []).length;
		const newCompletedTasks = (newContent.match(/- \[x\]/gi) || []).length;
		
		// Đếm tổng số task trong nội dung cũ và mới
		// Sử dụng regex chính xác hơn để phát hiện task chưa hoàn thành
		const oldIncompleteTasks = (this.lastFileContent.match(/- \[ \]/g) || []).length;
		const newIncompleteTasks = (newContent.match(/- \[ \]/g) || []).length;
		
		const oldTotalTasks = oldIncompleteTasks + oldCompletedTasks;
		const newTotalTasks = newIncompleteTasks + newCompletedTasks;
		
		// Nếu số lượng task hoàn thành hoặc tổng số task thay đổi, coi như đã thay đổi
		return oldCompletedTasks !== newCompletedTasks || oldTotalTasks !== newTotalTasks;
	}

	// Cập nhật nội dung file cuối cùng
	async updateLastFileContent(file: TFile) {
		if (file) {
			this.lastFileContent = await this.app.vault.read(file);
		}
	}

	async activateView() {
		try {
			const { workspace } = this.app;
			
			// If view already exists in leaves, show it
			const leaves = workspace.getLeavesOfType('progress-tracker');
			if (leaves.length > 0) {
				workspace.revealLeaf(leaves[0]);
				return;
			}

			// Otherwise, create a new leaf in the left sidebar
			// Kiểm tra xem workspace đã sẵn sàng chưa
			if (!workspace.leftSplit) {
				console.log('Workspace not ready yet, retrying in 500ms');
				setTimeout(() => this.activateView(), 500);
				return;
			}
			
			// Sử dụng getLeaf thay vì createLeaf
			const leaf = workspace.getLeftLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: 'progress-tracker',
					active: true,
				});
				
				// Reveal the leaf
				workspace.revealLeaf(leaf);
			}
		} catch (error) {
			console.error('Error activating view:', error);
			new Notice('Error activating Task Progress Bar view. Please try again later.');
		}
	}

	onunload() {
		// Xóa interval nếu có
		if (this.dataviewCheckInterval) {
			clearInterval(this.dataviewCheckInterval);
			this.dataviewCheckInterval = null;
		}
		
		// Detach the view when plugin unloads
		this.app.workspace.detachLeavesOfType('progress-tracker');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TaskProgressBarView extends ItemView {
	plugin: TaskProgressBarPlugin;
	currentFile: TFile | null = null;
	isVisible: boolean = false;
	lastUpdateTime: number = 0;

	constructor(leaf: WorkspaceLeaf, plugin: TaskProgressBarPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return 'progress-tracker';
	}

	getDisplayText(): string {
		return 'Task Progress Bar';
	}

	getIcon(): string {
		return 'bar-chart-horizontal';
	}

	async onOpen() {
		this.isVisible = true;
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl('h4', { text: 'Task Progress' });
		
		// Create progress container
		const progressContainer = container.createDiv({ cls: 'task-progress-container' });
		
		// Update with current file if available
		const currentFile = this.app.workspace.getActiveFile();
		if (currentFile) {
			this.updateProgressBar(currentFile);
		} else {
			// Hiển thị thông báo nếu không có file nào đang mở
			progressContainer.createEl('p', { 
				text: 'No file is currently open. Open a markdown file to see the progress bar.' 
			});
		}
	}

	async updateProgressBar(file: TFile | null, content?: string) {
		if (!file) return;
		
		// Tránh cập nhật quá nhanh
		const now = Date.now();
		if (now - this.lastUpdateTime < 100) return; // Giảm thời gian chờ xuống 100ms
		this.lastUpdateTime = now;
		
		this.currentFile = file;
		
		const container = this.containerEl.children[1];
		const progressContainer = container.querySelector('.task-progress-container') as HTMLElement;
		if (!progressContainer) return;
		
		// Thêm class để hiển thị animation
		progressContainer.classList.add('updating');
		
		// Cập nhật ngay lập tức nếu có nội dung được cung cấp
		if (content) {
			this.updateProgressBarContentWithString(content, progressContainer, file);
			
			// Xóa class sau khi cập nhật xong
			setTimeout(() => {
				progressContainer.classList.remove('updating');
			}, 300);
		} else {
			// Nếu không có nội dung, đọc từ file
			setTimeout(async () => {
				// Đọc nội dung file
				const fileContent = await this.plugin.app.vault.read(file);
				// Cập nhật với nội dung đọc được
				this.updateProgressBarContentWithString(fileContent, progressContainer, file);
				
				// Xóa class sau khi cập nhật xong
				setTimeout(() => {
					progressContainer.classList.remove('updating');
				}, 300);
			}, 50);
		}
	}
	
	// Phương thức mới để cập nhật với nội dung string trực tiếp
	async updateProgressBarContentWithString(content: string, progressContainer: HTMLElement, file: TFile) {
		progressContainer.empty();
		
		// Get Dataview API
		const dvAPI = this.plugin.dvAPI;
		if (!dvAPI) {
			// Vẫn hiển thị thanh tiến trình ngay cả khi không có Dataview API
			try {
				// Tạo thanh tiến trình trực tiếp từ nội dung
				this.createProgressBarFromString(progressContainer, content, file);
				
				// Thêm thông tin về thời gian cập nhật
				const updateInfo = progressContainer.createDiv({ cls: 'update-info' });
				updateInfo.createSpan({ 
					text: `Last updated: ${new Date().toLocaleTimeString()}`,
					cls: 'update-time'
				});
				
				// Thêm thông báo về Dataview không khả dụng
				const dataviewWarning = progressContainer.createDiv({ cls: 'dataview-warning' });
				dataviewWarning.createEl('p', { 
					text: 'Note: Dataview plugin is not available. Some advanced features may be limited.' 
				});
				
				// Thêm nút để kiểm tra lại Dataview
				const checkButton = dataviewWarning.createEl('button', { 
					text: 'Check for Dataview',
					cls: 'mod-cta'
				});
				checkButton.addEventListener('click', () => {
					this.plugin.checkDataviewAPI();
					if (this.plugin.dvAPI) {
						new Notice('Dataview API found!');
						this.updateProgressBar(file);
					} else {
						new Notice('Dataview API not found. Make sure Dataview plugin is installed and enabled.');
					}
				});
			} catch (error) {
				console.error('Error creating progress bar without Dataview:', error);
				progressContainer.createEl('p', { text: 'Error creating progress bar' });
			}
			
			return;
		}

		try {
			// Tạo thanh tiến trình trực tiếp từ nội dung
			this.createProgressBarFromString(progressContainer, content, file);
			
			// Thêm thông tin về thời gian cập nhật
			const updateInfo = progressContainer.createDiv({ cls: 'update-info' });
			updateInfo.createSpan({ 
				text: `Last updated: ${new Date().toLocaleTimeString()}`,
				cls: 'update-time'
			});
		} catch (error) {
			console.error('Error updating progress bar:', error);
			progressContainer.createEl('p', { text: 'Error loading progress bar' });
		}
	}
	
	// Phương thức tạo thanh tiến trình từ nội dung string
	async createProgressBarFromString(container: HTMLElement, content: string, file: TFile) {
		try {
			// Sử dụng regex chính xác hơn để đếm task
			const incompleteTasks = (content.match(/- \[ \]/g) || []).length;
			const completedTasks = (content.match(/- \[x\]/gi) || []).length; // Thêm cờ 'i' để bắt cả 'x' và 'X'
			const totalTasks = incompleteTasks + completedTasks;
			
			if (totalTasks === 0) {
				container.createEl('p', { text: 'No tasks found in this file' });
				return;
			}
			
			const percentage = Math.round((completedTasks / totalTasks) * 100);
			
			// Create percentage text
			container.createEl('div', { 
				text: `${percentage}% Complete`, 
				cls: 'progress-percentage' 
			});
			
			// Create progress bar
			const progressBarContainer = container.createDiv({ cls: 'progress-bar' });
			const progressElement = progressBarContainer.createDiv({ cls: 'progress' });
			progressElement.style.width = `${percentage}%`;
			
			// Create stats
			const statsContainer = container.createDiv({ cls: 'progress-stats' });
			statsContainer.createSpan({ text: `${completedTasks}/${totalTasks} tasks complete` });
			statsContainer.createSpan({ text: `${totalTasks - completedTasks} remaining` });
			
			// Hiển thị danh sách các task chưa hoàn thành
			if (totalTasks - completedTasks > 0) {
				const taskList = container.createEl('ul', { cls: 'task-list' });
				
				// Tìm tất cả các task chưa hoàn thành
				const lines = content.split('\n');
				for (const line of lines) {
					if (line.includes('- [ ]')) {
						// Lấy nội dung task (bỏ qua "- [ ]")
						const taskContent = line.substring(line.indexOf('- [ ]') + 5).trim();
						taskList.createEl('li', { text: taskContent });
					}
				}
			}
			
			// Thêm debug info nếu cần
			if (this.plugin.settings.showDebugInfo) {
				const debugInfo = container.createDiv({ cls: 'debug-info' });
				debugInfo.createEl('p', { text: `Debug Info:` });
				debugInfo.createEl('p', { text: `File: ${file.path}` });
				debugInfo.createEl('p', { text: `Incomplete tasks: ${incompleteTasks}` });
				debugInfo.createEl('p', { text: `Completed tasks: ${completedTasks}` });
				debugInfo.createEl('p', { text: `Total tasks: ${totalTasks}` });
				debugInfo.createEl('p', { text: `Percentage: ${percentage}%` });
				debugInfo.createEl('p', { text: `Update time: ${new Date().toISOString()}` });
			}
		} catch (error) {
			console.error('Error creating progress bar from string:', error);
			container.createEl('p', { text: 'Error creating progress bar' });
		}
	}

	async onClose() {
		this.isVisible = false;
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

		containerEl.createEl('h2', { text: 'Task Progress Bar Settings' });
		
		// Thêm thông tin về trạng thái Dataview
		const dataviewStatus = containerEl.createDiv({ cls: 'dataview-status' });
		if (this.plugin.dvAPI) {
			dataviewStatus.createEl('p', { 
				text: '✅ Dataview API is available',
				cls: 'dataview-available'
			});
		} else {
			dataviewStatus.createEl('p', { 
				text: '❌ Dataview API is not available',
				cls: 'dataview-unavailable'
			});
			
			// Thêm nút để kiểm tra lại Dataview
			const checkButton = dataviewStatus.createEl('button', { 
				text: 'Check for Dataview',
				cls: 'mod-cta'
			});
			checkButton.addEventListener('click', () => {
				this.plugin.checkDataviewAPI();
				if (this.plugin.dvAPI) {
					new Notice('Dataview API found!');
					this.display(); // Refresh settings tab
				} else {
					new Notice('Dataview API not found. Make sure Dataview plugin is installed and enabled.');
				}
			});
		}

		new Setting(containerEl)
			.setName('Setting')
			.setDesc('Description of the setting')
			.addText(text => text
				.setPlaceholder('Enter your setting')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName('Show Debug Info')
			.setDesc('Show debug information in the sidebar to help troubleshoot task counting issues')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showDebugInfo)
				.onChange(async (value) => {
					this.plugin.settings.showDebugInfo = value;
					await this.plugin.saveSettings();
					
					// Cập nhật sidebar nếu đang mở - sử dụng phương thức public
					const currentFile = this.app.workspace.getActiveFile();
					if (currentFile) {
						// Sử dụng phương thức public để cập nhật UI
						this.plugin.checkDataviewAPI();
					}
				}));
	}
}
