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

const { connect, markdown } = require('@hcengineering/api-client');
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
let connectionPromise = null;

async function createConnection() {
  if (!HULY_EMAIL || !HULY_PASSWORD || !HULY_WORKSPACE) {
    throw new Error('Missing required environment variables: HULY_EMAIL, HULY_PASSWORD, HULY_WORKSPACE');
  }

  const client = await connect(HULY_URL, {
    email: HULY_EMAIL,
    password: HULY_PASSWORD,
    workspace: HULY_WORKSPACE
  });

  return client;
}

async function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  // Prevent multiple simultaneous connection attempts
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = createConnection();
  try {
    cachedClient = await connectionPromise;
    return cachedClient;
  } finally {
    connectionPromise = null;
  }
}

function clearConnection() {
  cachedClient = null;
  connectionPromise = null;
}

async function withReconnect(operation) {
  try {
    return await operation();
  } catch (error) {
    // Check if this is a connection error
    if (error.message?.includes('ConnectionClosed') ||
        error.message?.includes('connection') ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('socket') ||
        error.code === 'ECONNRESET') {
      console.error('Connection lost, attempting reconnect...');
      clearConnection();
      // Retry once with fresh connection
      return await operation();
    }
    throw error;
  }
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
  },
  {
    name: 'add_relation',
    description: 'Add a "related to" relationship between two issues',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue identifier (e.g., "PRYLA-42")'
        },
        relatedToIssueId: {
          type: 'string',
          description: 'The issue to relate to (e.g., "PRYLA-99")'
        }
      },
      required: ['issueId', 'relatedToIssueId']
    }
  },
  {
    name: 'add_blocked_by',
    description: 'Add a "blocked by" dependency between two issues. The first issue is blocked by the second.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue that is blocked (e.g., "PRYLA-42")'
        },
        blockedByIssueId: {
          type: 'string',
          description: 'The blocking issue (e.g., "PRYLA-99")'
        }
      },
      required: ['issueId', 'blockedByIssueId']
    }
  },
  {
    name: 'set_parent',
    description: 'Set the parent issue (e.g., link a task to an epic)',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Child issue identifier (e.g., "PRYLA-42")'
        },
        parentIssueId: {
          type: 'string',
          description: 'Parent issue identifier (e.g., "PRYLA-1" for an epic)'
        }
      },
      required: ['issueId', 'parentIssueId']
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

  // Fetch actual description content (stored as collaborative document)
  let descriptionContent = '';
  if (issue.description) {
    try {
      descriptionContent = await client.fetchMarkup(
        tracker.class.Issue,
        issue._id,
        'description',
        issue.description,
        'markdown'
      );
    } catch (err) {
      // Fall back to empty if fetch fails
      console.error('Failed to fetch description:', err.message);
    }
  }

  return {
    id: `${project.identifier}-${issue.number}`,
    internalId: issue._id,
    title: issue.title,
    description: descriptionContent,
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

  // Get next issue number from project's sequence counter and increment it
  const nextNumber = (project.sequence || 0) + 1;

  // Update project's sequence counter
  await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
    sequence: nextNumber
  });

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

  // Create issue using addCollection (Issues are AttachedDoc, not regular Doc)
  const issueId = generateId();
  await client.addCollection(
    tracker.class.Issue,
    project._id,
    project._id,
    tracker.class.Project,
    'issues',
    {
      title,
      identifier: `${project.identifier}-${nextNumber}`,
      description: description ? markdown(description) : '',
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
    },
    issueId
  );

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
  const updatedFields = [];

  if (title !== undefined) {
    updates.title = title;
    updatedFields.push('title');
  }

  if (priority !== undefined) {
    updates.priority = PRIORITY_MAP[priority.toLowerCase()] ?? issue.priority;
    updatedFields.push('priority');
  }

  if (status !== undefined) {
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const found = statuses.find(s => s.name.toLowerCase() === status.toLowerCase());
    if (found) {
      updates.status = found._id;
      updatedFields.push('status');
    }
  }

  // Apply non-description updates
  if (Object.keys(updates).length > 0) {
    await client.updateDoc(tracker.class.Issue, project._id, issue._id, updates);
  }

  // Handle description update by directly uploading markup
  // Note: PlatformClient.processMarkup has a bug where uploadMarkup is not awaited
  // So we manually upload the markup and pass the reference to updateDoc
  if (description !== undefined) {
    try {
      // Access the markup operations directly and await the upload
      const markupRef = await client.markup.uploadMarkup(
        tracker.class.Issue,
        issue._id,
        'description',
        description,
        'markdown'
      );
      // Update the issue with the resolved markup reference
      await client.client.updateDoc(tracker.class.Issue, project._id, issue._id, {
        description: markupRef
      });
      updatedFields.push('description');
    } catch (err) {
      console.error('Failed to update description:', err.message);
      throw new Error(`Failed to update description: ${err.message}`);
    }
  }

  return {
    id: issueId,
    updated: updatedFields
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

// Helper to parse issue ID and get issue
async function parseAndFindIssue(client, issueId) {
  const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid issue ID format: ${issueId}. Expected format: PROJECT-NUMBER`);
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

  return { project, issue };
}

async function addRelation(issueId, relatedToIssueId) {
  const client = await getClient();

  // Find both issues
  const { project, issue } = await parseAndFindIssue(client, issueId);
  const { issue: relatedIssue } = await parseAndFindIssue(client, relatedToIssueId);

  // Get current relations or initialize empty array
  const currentRelations = issue.relations || [];

  // Check if relation already exists
  const alreadyRelated = currentRelations.some(r => r._id === relatedIssue._id);
  if (alreadyRelated) {
    return { message: `Issues are already related` };
  }

  // Add the new relation
  const newRelations = [...currentRelations, { _id: relatedIssue._id, _class: relatedIssue._class }];

  await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
    relations: newRelations
  });

  return {
    message: `Added relation: ${issueId} is now related to ${relatedToIssueId}`,
    issueId,
    relatedToIssueId
  };
}

async function addBlockedBy(issueId, blockedByIssueId) {
  const client = await getClient();

  // Find both issues
  const { project, issue } = await parseAndFindIssue(client, issueId);
  const { issue: blockingIssue } = await parseAndFindIssue(client, blockedByIssueId);

  // Get current blockedBy or initialize empty array
  const currentBlockedBy = issue.blockedBy || [];

  // Check if already blocked by this issue
  const alreadyBlocked = currentBlockedBy.some(r => r._id === blockingIssue._id);
  if (alreadyBlocked) {
    return { message: `${issueId} is already blocked by ${blockedByIssueId}` };
  }

  // Add the new blocking relation
  const newBlockedBy = [...currentBlockedBy, { _id: blockingIssue._id, _class: blockingIssue._class }];

  await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
    blockedBy: newBlockedBy
  });

  return {
    message: `Added dependency: ${issueId} is now blocked by ${blockedByIssueId}`,
    issueId,
    blockedByIssueId
  };
}

async function setParent(issueId, parentIssueId) {
  const client = await getClient();

  // Find both issues
  const { project, issue } = await parseAndFindIssue(client, issueId);
  const { project: parentProject, issue: parentIssue } = await parseAndFindIssue(client, parentIssueId);

  // Build parent info
  const parentInfo = {
    parentId: parentIssue._id,
    identifier: `${parentProject.identifier}-${parentIssue.number}`,
    parentTitle: parentIssue.title,
    space: parentProject._id
  };

  // Update the child issue with the parent reference
  await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
    attachedTo: parentIssue._id,
    parents: [parentInfo]
  });

  // Update parent's subIssues count (if tracked)
  // Note: This may be handled automatically by Huly

  return {
    message: `Set parent: ${issueId} is now a child of ${parentIssueId}`,
    issueId,
    parentIssueId
  };
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

    case 'add_relation':
      return await addRelation(args.issueId, args.relatedToIssueId);

    case 'add_blocked_by':
      return await addBlockedBy(args.issueId, args.blockedByIssueId);

    case 'set_parent':
      return await setParent(args.issueId, args.parentIssueId);

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

// Call tool handler with auto-reconnect
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await withReconnect(async () => {
      return await handleToolCall(name, args || {});
    });
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
