#!/usr/bin/env node
/**
 * Huly MCP Server
 *
 * A Model Context Protocol server for Huly issue tracking
 * with full CRUD support for projects, issues, and labels.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { connect } = require('@hcengineering/api-client');
const { generateId } = require('@hcengineering/core');
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;

// Configuration from environment variables
const HULY_URL = process.env.HULY_URL || 'http://huly.local:8087';
const HULY_EMAIL = process.env.HULY_EMAIL;
const HULY_PASSWORD = process.env.HULY_PASSWORD;
const HULY_WORKSPACE = process.env.HULY_WORKSPACE;

// Priority mapping
const PRIORITY_MAP = {
  'urgent': 1,
  'high': 2,
  'medium': 3,
  'low': 4,
  'none': 0
};

const PRIORITY_NAMES = ['No Priority', 'Urgent', 'High', 'Medium', 'Low'];

// Cached client connection
let cachedClient = null;

async function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  if (!HULY_EMAIL || !HULY_PASSWORD || !HULY_WORKSPACE) {
    throw new Error('Missing required environment variables: HULY_EMAIL, HULY_PASSWORD, HULY_WORKSPACE');
  }

  cachedClient = await connect(HULY_URL, {
    email: HULY_EMAIL,
    password: HULY_PASSWORD,
    workspace: HULY_WORKSPACE
  });

  return cachedClient;
}

// Tool definitions
const TOOLS = [
  {
    name: 'list_projects',
    description: 'List all projects in the Huly workspace',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_project',
    description: 'Get a project by identifier (e.g., "PRYLA")',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Project identifier (e.g., "PRYLA")'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'list_issues',
    description: 'List issues in a project with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project identifier (e.g., "PRYLA")'
        },
        status: {
          type: 'string',
          description: 'Filter by status (Backlog, Todo, In Progress, Done, Canceled)'
        },
        priority: {
          type: 'string',
          description: 'Filter by priority (urgent, high, medium, low, none)'
        },
        label: {
          type: 'string',
          description: 'Filter by label name'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of issues to return (default: 50)'
        }
      },
      required: ['project']
    }
  },
  {
    name: 'get_issue',
    description: 'Get a specific issue by number (e.g., "PRYLA-42")',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue identifier (e.g., "PRYLA-42")'
        }
      },
      required: ['issueId']
    }
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a project',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project identifier (e.g., "PRYLA")'
        },
        title: {
          type: 'string',
          description: 'Issue title'
        },
        description: {
          type: 'string',
          description: 'Issue description (Markdown supported)'
        },
        priority: {
          type: 'string',
          description: 'Priority: urgent, high, medium, low, none'
        },
        status: {
          type: 'string',
          description: 'Initial status (default: Todo)'
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to apply to the issue'
        }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'update_issue',
    description: 'Update an existing issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue identifier (e.g., "PRYLA-42")'
        },
        title: {
          type: 'string',
          description: 'New title'
        },
        description: {
          type: 'string',
          description: 'New description'
        },
        priority: {
          type: 'string',
          description: 'New priority: urgent, high, medium, low, none'
        },
        status: {
          type: 'string',
          description: 'New status: Backlog, Todo, In Progress, Done, Canceled'
        }
      },
      required: ['issueId']
    }
  },
  {
    name: 'add_label',
    description: 'Add a label to an issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue identifier (e.g., "PRYLA-42")'
        },
        label: {
          type: 'string',
          description: 'Label name to add'
        }
      },
      required: ['issueId', 'label']
    }
  },
  {
    name: 'remove_label',
    description: 'Remove a label from an issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue identifier (e.g., "PRYLA-42")'
        },
        label: {
          type: 'string',
          description: 'Label name to remove'
        }
      },
      required: ['issueId', 'label']
    }
  },
  {
    name: 'list_labels',
    description: 'List all available labels',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_label',
    description: 'Create a new label',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Label name'
        },
        color: {
          type: 'number',
          description: 'Label color as hex number (e.g., 0xFF6B6B)'
        }
      },
      required: ['name']
    }
  }
];

// Tool implementations
async function listProjects() {
  const client = await getClient();
  const projects = await client.findAll(tracker.class.Project, {});

  const result = [];
  for (const project of projects) {
    const issues = await client.findAll(tracker.class.Issue, { space: project._id });
    result.push({
      id: project._id,
      identifier: project.identifier,
      name: project.name || project.identifier,
      issueCount: issues.length
    });
  }

  return result;
}

async function getProject(identifier) {
  const client = await getClient();
  const project = await client.findOne(tracker.class.Project, {
    identifier: identifier.toUpperCase()
  });

  if (!project) {
    throw new Error(`Project not found: ${identifier}`);
  }

  const issues = await client.findAll(tracker.class.Issue, { space: project._id });

  return {
    id: project._id,
    identifier: project.identifier,
    name: project.name || project.identifier,
    description: project.description || '',
    issueCount: issues.length
  };
}

async function listIssues(project, status, priority, label, limit = 50) {
  const client = await getClient();

  // Find project
  const proj = await client.findOne(tracker.class.Project, {
    identifier: project.toUpperCase()
  });

  if (!proj) {
    throw new Error(`Project not found: ${project}`);
  }

  // Build query
  const query = { space: proj._id };

  if (priority) {
    query.priority = PRIORITY_MAP[priority.toLowerCase()] ?? 0;
  }

  // Get issues
  let issues = await client.findAll(tracker.class.Issue, query, {
    limit,
    sort: { modifiedOn: -1 }
  });

  // Get statuses to resolve names
  const statuses = await client.findAll(tracker.class.IssueStatus, {});
  const statusMap = new Map(statuses.map(s => [s._id, s.name]));

  // Filter by status name if provided
  if (status) {
    issues = issues.filter(issue => {
      const statusName = statusMap.get(issue.status) || '';
      return statusName.toLowerCase() === status.toLowerCase();
    });
  }

  // Get labels for filtering
  let labelFilter = null;
  if (label) {
    const tagElements = await client.findAll(tags.class.TagElement, {
      title: label,
      targetClass: tracker.class.Issue
    });
    if (tagElements.length > 0) {
      labelFilter = tagElements[0]._id;
    }
  }

  // Build result with labels
  const result = [];
  for (const issue of issues) {
    const issueLabels = await client.findAll(tags.class.TagReference, {
      attachedTo: issue._id
    });

    // Filter by label if specified
    if (labelFilter && !issueLabels.some(l => l.tag === labelFilter)) {
      continue;
    }

    result.push({
      id: `${proj.identifier}-${issue.number}`,
      title: issue.title,
      status: statusMap.get(issue.status) || 'Unknown',
      priority: PRIORITY_NAMES[issue.priority] || 'Unknown',
      labels: issueLabels.map(l => l.title)
    });
  }

  return result;
}

async function getIssue(issueId) {
  const client = await getClient();

  // Parse issue ID (e.g., "PRYLA-42")
  const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid issue ID format: ${issueId}. Expected format: PROJECT-NUMBER`);
  }

  const [, projectId, issueNum] = match;

  // Find project
  const project = await client.findOne(tracker.class.Project, {
    identifier: projectId.toUpperCase()
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // Find issue
  const issue = await client.findOne(tracker.class.Issue, {
    space: project._id,
    number: parseInt(issueNum)
  });

  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  // Get status name
  const status = await client.findOne(tracker.class.IssueStatus, { _id: issue.status });

  // Get labels
  const issueLabels = await client.findAll(tags.class.TagReference, {
    attachedTo: issue._id
  });

  return {
    id: `${project.identifier}-${issue.number}`,
    internalId: issue._id,
    title: issue.title,
    description: issue.description || '',
    status: status?.name || 'Unknown',
    priority: PRIORITY_NAMES[issue.priority] || 'Unknown',
    labels: issueLabels.map(l => l.title),
    createdOn: issue.createdOn,
    modifiedOn: issue.modifiedOn
  };
}

async function createIssue(projectIdent, title, description, priority, status, labels) {
  const client = await getClient();

  // Find project
  const project = await client.findOne(tracker.class.Project, {
    identifier: projectIdent.toUpperCase()
  });

  if (!project) {
    throw new Error(`Project not found: ${projectIdent}`);
  }

  // Get next issue number
  const existingIssues = await client.findAll(tracker.class.Issue, { space: project._id });
  const nextNumber = existingIssues.length > 0
    ? Math.max(...existingIssues.map(i => i.number)) + 1
    : 1;

  // Find status
  let statusId;
  const statuses = await client.findAll(tracker.class.IssueStatus, {});
  if (status) {
    const found = statuses.find(s => s.name.toLowerCase() === status.toLowerCase());
    statusId = found?._id;
  }
  if (!statusId) {
    const todoStatus = statuses.find(s => s.name === 'Todo');
    statusId = todoStatus?._id || statuses[0]?._id;
  }

  // Create issue
  const issueId = generateId();
  await client.createDoc(tracker.class.Issue, project._id, {
    title,
    description: description || '',
    status: statusId,
    priority: PRIORITY_MAP[priority?.toLowerCase()] ?? 0,
    number: nextNumber,
    assignee: null,
    component: null,
    milestone: null,
    estimation: 0,
    remainingTime: 0,
    reportedTime: 0,
    childInfo: [],
    parents: [],
    kind: tracker.taskTypes.Issue
  }, issueId);

  // Add labels if provided
  if (labels && labels.length > 0) {
    for (const labelName of labels) {
      await addLabelToIssue(client, issueId, project._id, labelName);
    }
  }

  return {
    id: `${project.identifier}-${nextNumber}`,
    internalId: issueId,
    title,
    status: status || 'Todo',
    priority: priority || 'none'
  };
}

async function updateIssue(issueId, title, description, priority, status) {
  const client = await getClient();

  // Parse and find issue
  const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid issue ID format: ${issueId}`);
  }

  const [, projectId, issueNum] = match;

  const project = await client.findOne(tracker.class.Project, {
    identifier: projectId.toUpperCase()
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const issue = await client.findOne(tracker.class.Issue, {
    space: project._id,
    number: parseInt(issueNum)
  });

  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  // Build update operations
  const updates = {};

  if (title !== undefined) {
    updates.title = title;
  }

  if (description !== undefined) {
    updates.description = description;
  }

  if (priority !== undefined) {
    updates.priority = PRIORITY_MAP[priority.toLowerCase()] ?? issue.priority;
  }

  if (status !== undefined) {
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const found = statuses.find(s => s.name.toLowerCase() === status.toLowerCase());
    if (found) {
      updates.status = found._id;
    }
  }

  if (Object.keys(updates).length > 0) {
    await client.updateDoc(tracker.class.Issue, project._id, issue._id, updates);
  }

  return {
    id: issueId,
    updated: Object.keys(updates)
  };
}

async function addLabelToIssue(client, issueId, space, labelName) {
  // Find or create tag element
  let tagElement = await client.findOne(tags.class.TagElement, {
    title: labelName,
    targetClass: tracker.class.Issue
  });

  if (!tagElement) {
    // Create the tag
    const tagId = generateId();
    await client.createDoc(tags.class.TagElement, space, {
      title: labelName,
      targetClass: tracker.class.Issue,
      description: '',
      color: 0x4ECDC4,
      category: 'tracker:category:Other'
    }, tagId);
    tagElement = { _id: tagId, title: labelName, color: 0x4ECDC4 };
  }

  // Check if already attached
  const existing = await client.findOne(tags.class.TagReference, {
    attachedTo: issueId,
    tag: tagElement._id
  });

  if (existing) {
    return { message: `Label "${labelName}" already attached` };
  }

  // Add tag reference
  await client.addCollection(
    tags.class.TagReference,
    space,
    issueId,
    tracker.class.Issue,
    'labels',
    {
      title: tagElement.title,
      color: tagElement.color || 0,
      tag: tagElement._id
    }
  );

  return { message: `Label "${labelName}" added` };
}

async function addLabel(issueId, labelName) {
  const client = await getClient();

  // Parse and find issue
  const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid issue ID format: ${issueId}`);
  }

  const [, projectId, issueNum] = match;

  const project = await client.findOne(tracker.class.Project, {
    identifier: projectId.toUpperCase()
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const issue = await client.findOne(tracker.class.Issue, {
    space: project._id,
    number: parseInt(issueNum)
  });

  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  return await addLabelToIssue(client, issue._id, project._id, labelName);
}

async function removeLabel(issueId, labelName) {
  const client = await getClient();

  // Parse and find issue
  const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid issue ID format: ${issueId}`);
  }

  const [, projectId, issueNum] = match;

  const project = await client.findOne(tracker.class.Project, {
    identifier: projectId.toUpperCase()
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const issue = await client.findOne(tracker.class.Issue, {
    space: project._id,
    number: parseInt(issueNum)
  });

  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  // Find and remove tag reference
  const tagRefs = await client.findAll(tags.class.TagReference, {
    attachedTo: issue._id
  });

  const tagRef = tagRefs.find(r => r.title.toLowerCase() === labelName.toLowerCase());

  if (!tagRef) {
    return { message: `Label "${labelName}" not found on issue` };
  }

  await client.removeDoc(tags.class.TagReference, tagRef.space, tagRef._id);

  return { message: `Label "${labelName}" removed` };
}

async function listLabels() {
  const client = await getClient();

  const tagElements = await client.findAll(tags.class.TagElement, {
    targetClass: tracker.class.Issue
  });

  return tagElements.map(t => ({
    name: t.title,
    color: t.color ? `#${t.color.toString(16).padStart(6, '0')}` : null
  }));
}

async function createLabel(name, color) {
  const client = await getClient();

  // Check if exists
  const existing = await client.findOne(tags.class.TagElement, {
    title: name,
    targetClass: tracker.class.Issue
  });

  if (existing) {
    return { message: `Label "${name}" already exists`, id: existing._id };
  }

  // Get a project space for the tag
  const projects = await client.findAll(tracker.class.Project, {});
  const space = projects.length > 0 ? projects[0]._id : 'tracker:project:Default';

  const tagId = generateId();
  await client.createDoc(tags.class.TagElement, space, {
    title: name,
    targetClass: tracker.class.Issue,
    description: '',
    color: color || 0x4ECDC4,
    category: 'tracker:category:Other'
  }, tagId);

  return { message: `Label "${name}" created`, id: tagId };
}

// Handle tool calls
async function handleToolCall(name, args) {
  switch (name) {
    case 'list_projects':
      return await listProjects();

    case 'get_project':
      return await getProject(args.identifier);

    case 'list_issues':
      return await listIssues(
        args.project,
        args.status,
        args.priority,
        args.label,
        args.limit
      );

    case 'get_issue':
      return await getIssue(args.issueId);

    case 'create_issue':
      return await createIssue(
        args.project,
        args.title,
        args.description,
        args.priority,
        args.status,
        args.labels
      );

    case 'update_issue':
      return await updateIssue(
        args.issueId,
        args.title,
        args.description,
        args.priority,
        args.status
      );

    case 'add_label':
      return await addLabel(args.issueId, args.label);

    case 'remove_label':
      return await removeLabel(args.issueId, args.label);

    case 'list_labels':
      return await listLabels();

    case 'create_label':
      return await createLabel(args.name, args.color);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create and run the server
const server = new Server(
  {
    name: 'huly-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: error.message })
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Huly MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
