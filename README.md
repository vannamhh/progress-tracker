# Progress Tracker Plugin for Obsidian

A plugin for Obsidian that helps you track progress of your tasks in real-time. It provides a visual progress bar and integrates with Kanban boards to help you manage your tasks more effectively.

## What's new in the latest update

- **Sidebar duplication bug fixed:** Only one progress tracker view is created, even after reloads.
- **Sidebar position:** Progress tracker now appears in the right sidebar by default.
- **Custom checkbox states:** Improved support and protection for custom states in Kanban boards.
- **View initialization:** Progress bar view now reliably loads and updates when opened.

## Features

- Real-time progress tracking of tasks in your notes
- Visual progress bar showing completion percentage
- Automatic status updates based on task completion
- Kanban board integration for task management
- **Custom checkbox states for Kanban columns** (NEW!)
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

### Custom Checkbox States (NEW!)

You can now configure custom checkbox states for different Kanban columns:

1. Enable "Custom Checkbox States" in plugin settings
2. Configure mappings between column names and checkbox states:
   - `Todo` → `[ ]` (unchecked)
   - `In Progress` → `[/]` (in progress)
   - `Complete` → `[x]` (completed)
   - `Done` → `[x]` (completed)
   - Or any custom states like `[>]`, `[-]`, etc.

3. When cards are moved between columns, their checkbox states will automatically update

#### Supported Checkbox States

- `[ ]` - Todo/Unchecked
- `[x]` - Completed
- `[/]` - In Progress
- `[>]` - Forwarded/Deferred
- `[-]` - Cancelled
- `[!]` - Important

#### Kanban Normalization Protection (NEW!)

The plugin now includes intelligent protection against unwanted checkbox state normalization by the Kanban plugin:

- **Real-Time Detection**: Instantly detects when the Kanban plugin tries to convert custom states to standard states
- **Immediate Reversion**: Automatically reverts unwanted normalizations in real-time
- **Smart Pattern Analysis**: Distinguishes between legitimate user changes and unwanted plugin normalizations
- **Selective Protection**: Only protects states that match your column mappings while preserving legitimate changes
- **Multi-Layer Defense**: Combines immediate detection, movement analysis, and content comparison for comprehensive protection
- **Non-Invasive**: Works seamlessly without interfering with normal Kanban operations
- **Debug Support**: Comprehensive logging and testing commands for troubleshooting

**How it works:**
1. **Immediate Detection**: Monitors editor changes in real-time to catch normalization as it happens
2. **Pattern Recognition**: Analyzes content changes to identify unwanted custom state → [x] conversions
3. **Smart Reversion**: Automatically restores correct checkbox states based on column mappings
4. **Movement Protection**: Prevents card movements from triggering unwanted normalization cascades

This ensures your custom checkbox states (like `[/]`, `[~]`, etc.) remain intact when working with Kanban boards, even when the Kanban plugin tries to normalize them.

### Enhanced Custom State Support

The plugin now properly recognizes and counts all custom checkbox states with advanced conflict prevention and precision targeting. When custom checkbox states are enabled:

- **Progress Calculation**: Custom states (like `[/]`, `[-]`, `[~]`) are counted as "tasks in progress" and included in the total task count
- **Smart Auto-Sync**: Auto-sync only updates cards that don't already have the correct checkbox state for their column
- **Conflict Prevention**: Advanced timing detection prevents race conditions between auto-sync and manual card movements
- **Precision Targeting**: Only cards that actually moved between columns are updated, eliminating false positives
- **Content Normalization**: Card movements are detected by normalized content comparison, not checkbox states or fuzzy matching
- **Preserved States**: Cards with existing correct states are left unchanged to prevent unnecessary modifications
- **Enhanced Detection**: All task-related changes are properly detected regardless of checkbox state

**Note:** When updating checkbox states, only the main card checkbox is modified. Sub-items and nested checkboxes within cards are preserved to maintain data integrity. The plugin uses sophisticated position-based replacement and precision targeting to ensure only cards that actually moved are updated, completely preventing accidental modifications to other cards.

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

#### Custom Checkbox States
- Enable custom checkbox state management
- Configure column-to-checkbox mappings
- Add/remove column mappings as needed
- Reset to default mappings

## Troubleshooting

If you encounter issues:

1. Enable Debug Mode in settings to see detailed logs
2. Check if Dataview plugin is installed and enabled
3. Verify your Kanban board configuration
4. Clear the completed files cache if needed
5. Check custom checkbox state mappings if using that feature

## Support

If you find this plugin helpful, you can:

- Star the repository
- Report issues on GitHub
- Submit feature requests
- Contribute to the code

## License

This project is licensed under the MIT License - see the LICENSE file for details.

