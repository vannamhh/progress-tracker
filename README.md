# Progress Tracker Plugin for Obsidian

A plugin for Obsidian that helps you track progress of your tasks in real-time. It provides a visual progress bar and integrates with Kanban boards to help you manage your tasks more effectively.

## Features

- Real-time progress tracking of tasks in your notes
- Visual progress bar showing completion percentage
- Automatic status updates based on task completion
- Kanban board integration for task management
- Customizable colors and thresholds
- Debug mode for troubleshooting

## Installation

1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "Progress Tracker"
4. Install the plugin
5. Enable the plugin in your Community Plugins list

## Usage

### Basic Usage

1. Create tasks in your notes using Markdown checkboxes:
   ```markdown
   - [ ] Task 1
   - [x] Completed task
   - [ ] Task 3
   ```

2. The progress bar will automatically update as you check/uncheck tasks.

### Kanban Integration

The plugin can automatically move cards in your Kanban boards based on task completion:

1. Set up a Kanban board in Obsidian
2. Configure the target Kanban board in plugin settings
3. As you complete tasks, cards will move to appropriate columns

### Settings

#### Progress Bar Colors
- Choose between default theme colors or custom color schemes
- Set custom colors for different progress levels
- Configure progress thresholds

#### Performance
- Adjust update delays for different actions
- Configure animation settings
- Set maximum height for the progress bar container

#### Metadata Auto-Update
- Automatically update file metadata on task completion
- Configure status labels for different progress states
- Set up finished date tracking

#### Kanban Integration
- Enable/disable automatic Kanban board updates
- Configure target Kanban board
- Set up column mapping for task states

## Troubleshooting

If you encounter issues:

1. Enable Debug Mode in settings to see detailed logs
2. Check if Dataview plugin is installed and enabled
3. Verify your Kanban board configuration
4. Clear the completed files cache if needed

## Support

If you find this plugin helpful, you can:

- Star the repository
- Report issues on GitHub
- Submit feature requests
- Contribute to the code

## License

This project is licensed under the MIT License - see the LICENSE file for details.

