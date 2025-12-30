# Huly MCP Server

A Model Context Protocol (MCP) server for [Huly](https://huly.io) issue tracking with full CRUD support.

## Features

- **Projects**: List and get project details
- **Issues**: List, get, create, and update issues
- **Labels**: List, create, add to issues, remove from issues
- **Filtering**: Filter issues by status, priority, and labels

## Installation

```bash
npm install
```

## Configuration

Set the following environment variables:

```bash
export HULY_URL="http://huly.local:8087"
export HULY_EMAIL="your-email@example.com"
export HULY_PASSWORD="your-password"
export HULY_WORKSPACE="your-workspace"
```

## Usage with Claude Code

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "huly": {
      "command": "node",
      "args": ["/path/to/huly-mcp-server/src/index.mjs"],
      "env": {
        "HULY_URL": "http://huly.local:8087",
        "HULY_EMAIL": "your-email@example.com",
        "HULY_PASSWORD": "your-password",
        "HULY_WORKSPACE": "your-workspace"
      }
    }
  }
}
```

## Available Tools

### Projects

- `list_projects` - List all projects with issue counts
- `get_project` - Get project details by identifier

### Issues

- `list_issues` - List issues with filtering (project, status, priority, label)
- `get_issue` - Get issue details by ID (e.g., "PRYLA-42")
- `create_issue` - Create a new issue
- `update_issue` - Update issue title, description, status, or priority

### Labels

- `list_labels` - List all available labels
- `create_label` - Create a new label
- `add_label` - Add a label to an issue
- `remove_label` - Remove a label from an issue

## Examples

### List issues in a project
```
list_issues(project: "PRYLA", status: "Todo", limit: 10)
```

### Create an issue
```
create_issue(
  project: "PRYLA",
  title: "Fix login bug",
  description: "Users cannot log in with SSO",
  priority: "high",
  labels: ["Bug", "priority:high"]
)
```

### Update issue status
```
update_issue(issueId: "PRYLA-42", status: "Done")
```

### Add a label
```
add_label(issueId: "PRYLA-42", label: "reviewed")
```

## License

MIT
