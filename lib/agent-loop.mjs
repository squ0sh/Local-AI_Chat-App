/**
 * Agent loop — server-side observe → think → act cycle.
 *
 * The LLM receives tool definitions and produces either structured tool_calls
 * (OpenAI-compatible) or XML-tag fallback output. The loop executes each tool,
 * feeds results back, and repeats until the model produces a final answer.
 */

import { readFileSync, statSync, readdirSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs';
import { join, dirname, resolve, relative, sep } from 'path';
import { spawn } from 'child_process';

// ── Tool definitions ────────────────────────────────────────────────────────
// These are sent to the LLM so it knows what tools are available.

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the text content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to workspace root' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file. Creates parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories in a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to workspace root (default: .)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace directory. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command to execute' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files by name pattern (glob). Returns matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.js" or "src/**/*.ts"' },
          path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
          include: { type: 'string', description: 'File pattern to include, e.g. "*.js" or "*.py"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information. Returns search result snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: { type: 'number', description: 'Number of results (default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract readable text content from a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git',
      description: 'Run a read-only git command in the workspace (status, diff, log, show, branch, ls-files, rev-parse, remote, tag). Writing/force commands are blocked.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'array', items: { type: 'string' }, description: 'Git arguments, e.g. ["status"] or ["diff", "server.mjs"]' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run the project\’s test suite (the "test" script in package.json, usually npm test). Optional test name filter is passed through.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Optional test name/pattern to filter by' } },
      },
    },
  },
];

// ── Tool definitions as plain text (for models that don't support function calling) ──
export const AGENT_TOOLS_TEXT = AGENT_TOOLS.map((t) => {
  const fn = t.function;
  const params = Object.entries(fn.parameters.properties || {}).map(([k, v]) => `    ${k}: ${v.description}`).join('\n');
  return `- ${fn.name}: ${fn.description}\n  Parameters:\n${params}`;
}).join('\n\n');

// ── System prompt templates ──────────────────────────────────────────────────

const BASE_AGENT_SYSTEM = `You are a powerful AI agent working on a local software project. You have access to tools that let you read files, write files, search code, run commands, and search the web.

## How to use tools
When you need to use a tool, output a tool call. You may call multiple tools in sequence, but ALWAYS wait for each result before proceeding to the next step.

## Important rules
- ALWAYS start by understanding the task. Read relevant files before making changes.
- Break complex tasks into smaller steps and track your progress.
- When writing code, follow the existing code style and conventions of the project.
- After making changes, verify they work (run tests, linter, type checks if available).
- If you encounter an error, diagnose it before trying again.
- Never guess file contents — always read them first.
- When you are done, provide a clear summary of what you did.`;

const SKILL_PROMPTS = {
  'coding-partner': `## Coding Partner Mode
You are an expert coding partner. Your workflow:
1. Understand the request fully — ask clarifying questions if ambiguous.
2. Explore the codebase to find relevant files and understand architecture.
3. Plan your approach before writing code.
4. Implement changes following existing patterns and conventions.
5. Run tests or build commands to verify your changes.
6. Explain what you did and why.

Always prefer reading code over guessing. Match the project's style (indentation, naming, imports).`,

  'debug-assistant': `## Debug Assistant Mode
You are a methodical debugging expert. Your workflow:
1. Understand the symptoms — what's failing and what should happen?
2. Find relevant code, error logs, and configuration.
3. Form hypotheses about the root cause.
4. Test hypotheses systematically (read code, run commands, check logs).
5. Once you find the issue, explain it clearly before fixing.
6. Fix the bug and verify the fix works.
7. Check for related issues in nearby code.

Never guess at a fix without understanding the problem first. Use reproduction steps and evidence.`,

  'system-admin': `## System Administrator Mode
You are a careful Linux system administrator. Your workflow:
1. Understand what needs to be configured or fixed.
2. Check current state before making changes (read configs, check services, inspect logs).
3. Make targeted, minimal changes — never modify more than necessary.
4. Verify the change took effect.
5. Document what was changed and why.

Always read before writing. Never blindly overwrite config files — merge or patch when possible. Prefer the safest approach.`,

  'codebase-explorer': `## Codebase Explorer Mode
You are a codebase analyst. Your goal is to understand and explain the project structure.
1. Start with the root directory and key files (package.json, README, main entry points).
2. Map the architecture — what does each directory and major file do?
3. Identify patterns: frameworks used, coding conventions, build system, dependencies.
4. Answer the user's questions about the codebase with specific file references.
5. If asked to find something, search systematically before answering.

Be thorough but concise. Use file paths and line numbers when referencing code.`,

  'research-analyst': `## Research Analyst Mode
You are a research analyst who gathers information from multiple sources.
1. Understand the research question completely.
2. Search the web for relevant information from multiple angles.
3. Read and extract key facts from promising sources.
4. Cross-reference information across sources.
5. Identify patterns, connections, and contradictions across domains.
6. Synthesize findings into a clear, well-structured report.
7. Cite sources and note any areas of uncertainty.

Use web_search and web_fetch tools extensively. Don't rely on a single source — seek diverse perspectives.`,

  'writing-assistant': `## Writing Assistant Mode
You are a skilled writing assistant. Your workflow:
1. Understand the writing goal, audience, and tone.
2. If research is needed, search for facts and context.
3. Create or edit content with clear structure.
4. Proofread for grammar, clarity, and flow.
5. Explain your changes and reasoning.`,

  'full-stack-dev': `## Full-Stack Developer Mode
You are a full-stack developer capable of working across the entire stack.
1. Understand requirements end-to-end (frontend, backend, database, config).
2. Explore the full project structure before making changes.
3. Coordinate changes across multiple files and layers.
4. Test the complete flow after making changes.
5. Ensure consistency across the stack.

Read existing code patterns before writing. Follow the project's architecture.`,

  'security-reviewer': `## Security Reviewer Mode
You are a security auditor reviewing code for vulnerabilities.
1. Map the attack surface — entry points, data flows, auth boundaries.
2. Check for common vulnerabilities (injection, XSS, auth bypass, secrets in code, insecure defaults).
3. Review configuration for security best practices.
4. Provide findings with severity levels and specific fix recommendations.
5. Prioritize critical issues over minor ones.

Be thorough but practical. Focus on real exploitable issues, not theoretical concerns.`,
};

export { SKILL_PROMPTS };

const PLAN_SYSTEM = `## Read-only planning mode
You are producing a plan only. You may read files, search the codebase, and optionally search the web, but you must NEVER write files, run commands, or run tests. Those tools are disabled and will be blocked if you try them.
When you finish, present a clear, numbered plan covering: the goal, the files you would inspect or change, the commands that would be run, and the tests that would verify the work. Do not execute any of it.`;

// ── Glob implementation (simple recursive) ──────────────────────────────────

function globMatch(pattern, filePath) {
  // Simple glob matching: ** matches any path, * matches within a segment
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

export function globSearch(root, pattern, currentPath = '') {
  const results = [];
  let entries;
  try { entries = readdirSync(join(root, currentPath), { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.portable') continue;
    const relPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...globSearch(root, pattern, relPath));
    } else if (globMatch(pattern, relPath)) {
      results.push(relPath);
    }
  }
  return results;
}

// ── Grep implementation ─────────────────────────────────────────────────────

function grepSearch(root, regex, searchPath = '', includePattern = '') {
  const results = [];
  const includeRegex = includePattern ? new RegExp(
    '^' + includePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  ) : null;

  function walk(dirPath) {
    let entries;
    try { entries = readdirSync(join(root, dirPath), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.portable') continue;
      const relPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        try {
          const content = readFileSync(join(root, relPath), 'utf8');
          const lines = content.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
              if (matches.length >= 20) break; // cap per file
            }
          }
          if (matches.length) results.push({ file: relPath, matches });
          if (results.length >= 30) return; // cap total files
        } catch {}
      }
    }
  }
  walk(searchPath);
  return results;
}

// ── Tool execution ──────────────────────────────────────────────────────────

// Risky tools always demand a human decision. Read/search/list are read-only
// and can run without a gate, but the UI still surfaces them as events.
export const RISKY_TOOLS = ['write_file', 'run_command', 'run_tests'];

// Write history for /undo: most recent snapshot is popped (LIFO), capped.
const WRITE_HISTORY = [];
export { WRITE_HISTORY };
const WRITE_HISTORY_MAX = 20;

export function agentWriteFile(workspaceRoot, path, content) {
  const target = resolve(workspaceRoot, path || '');
  const rel = relative(workspaceRoot, target);
  if (rel.startsWith('..' + sep) || rel === '..') return { error: 'Path is outside workspace' };
  const previous = { existed: false, path: rel, content: null };
  try {
    const st = statSync(target);
    if (st.isFile()) previous.existed = true;
    if (previous.existed) previous.content = readFileSync(target, 'utf8');
  } catch {}
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(content == null ? '' : content), 'utf8');
    WRITE_HISTORY.push(previous);
    if (WRITE_HISTORY.length > WRITE_HISTORY_MAX) WRITE_HISTORY.shift();
    return { ok: true, path: rel };
  } catch (e) { return { error: e.message }; }
}

export function revertLastAgentWrite(workspaceRoot) {
  const prev = WRITE_HISTORY.pop();
  if (!prev) return { ok: false, error: 'Nothing to undo' };
  try {
    if (prev.kind === 'move') {
      const fromTarget = resolve(workspaceRoot, prev.from);
      const toTarget = resolve(workspaceRoot, prev.to);
      renameSync(toTarget, fromTarget);
      return { ok: true, action: 'moved back', path: prev.from };
    }
    const target = resolve(workspaceRoot, prev.path || prev.from);
    if (prev.existed) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, prev.content, 'utf8');
      return { ok: true, action: 'restored', path: prev.path || prev.from };
    }
    rmSync(target, { force: true });
    return { ok: true, action: 'removed', path: prev.path || prev.from };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Organize preview / apply ────────────────────────────────────────────────

export const ORGANIZE_STYLES = ['by_year', 'by_month', 'by_type'];

const ORG_EXT_MAP = {
  jpg: 'images', jpeg: 'images', png: 'images', gif: 'images', bmp: 'images', webp: 'images',
  svg: 'images', heic: 'images', heif: 'images', tiff: 'images', tif: 'images', avif: 'images',
  pdf: 'documents', doc: 'documents', docx: 'documents', txt: 'documents', md: 'documents',
  markdown: 'documents', odt: 'documents', pages: 'documents', rtf: 'documents',
  xls: 'spreadsheets', xlsx: 'spreadsheets', tsv: 'spreadsheets', numbers: 'spreadsheets',
  ppt: 'presentations', pptx: 'presentations', key: 'presentations', odp: 'presentations',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio', opus: 'audio',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video', wmv: 'video',
  zip: 'archives', tar: 'archives', gz: 'archives', '7z': 'archives', rar: 'archives', xz: 'archives', zst: 'archives',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', java: 'code', go: 'code', rs: 'code', rb: 'code', php: 'code',
  sh: 'code', bash: 'code', zsh: 'code', html: 'code', htm: 'code', css: 'code',
  json: 'code', yaml: 'code', yml: 'code', xml: 'code', c: 'code', cpp: 'code', h: 'code',
  hs: 'code', ex: 'code', exs: 'code', swift: 'code', kt: 'code',
};

const ORG_CATEGORY_NAMES = {
  images: 'Images', documents: 'Documents', spreadsheets: 'Spreadsheets',
  presentations: 'Presentations', audio: 'Audio', video: 'Video',
  archives: 'Archives', code: 'Code', other: 'Other',
};

function extType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ORG_EXT_MAP[ext] || 'other';
}

export function buildOrganizePlan(workspaceRoot, folder, style) {
  const target = resolve(workspaceRoot, folder || '.');
  const relFolder = relative(workspaceRoot, target);
  if (relFolder.startsWith('..' + sep) || relFolder === '..') return { error: 'Folder is outside workspace' };
  if (!style || !ORGANIZE_STYLES.includes(style)) return { error: 'Style must be one of: ' + ORGANIZE_STYLES.join(', ') };
  const plan = [];
  const seenTargets = new Set();
  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); } catch (e) { return { error: e.message }; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    const fromRel = (relFolder ? relFolder + '/' : '') + entry.name;
    const fromFull = resolve(workspaceRoot, fromRel);
    let destDirName;
    if (style === 'by_type') {
      destDirName = ORG_CATEGORY_NAMES[extType(entry.name)] || 'Other';
    } else {
      let mtime;
      try { mtime = statSync(fromFull).mtime; } catch { continue; }
      const y = mtime.getFullYear();
      const mo = String(mtime.getMonth() + 1).padStart(2, '0');
      destDirName = style === 'by_year' ? String(y) : `${y}-${mo}`;
    }
    const toRel = (relFolder ? relFolder + '/' : '') + destDirName + '/' + entry.name;
    if (toRel === fromRel) continue;
    const toKey = toRel.toLowerCase();
    if (seenTargets.has(toKey)) continue;
    seenTargets.add(toKey);
    try { statSync(resolve(workspaceRoot, toRel)); continue; } catch {}
    plan.push({ from: fromRel, to: toRel });
    if (plan.length >= 200) break;
  }
  return { ok: true, folder: relFolder || '.', style, count: plan.length, plan };
}

export function applyOrganizePlan(workspaceRoot, plan) {
  if (!Array.isArray(plan) || !plan.length) return { error: 'No plan to apply' };
  const applied = [];
  const errors = [];
  for (const move of plan.slice(0, 200)) {
    if (!move?.from || !move?.to) continue;
    const fromFull = resolve(workspaceRoot, move.from);
    const toFull = resolve(workspaceRoot, move.to);
    const relFrom = relative(workspaceRoot, fromFull);
    const relTo = relative(workspaceRoot, toFull);
    if (relFrom.startsWith('..' + sep) || relFrom === '..' || relTo.startsWith('..' + sep) || relTo === '..') {
      errors.push({ from: move.from, to: move.to, error: 'Path is outside workspace' });
      continue;
    }
    try {
      mkdirSync(dirname(toFull), { recursive: true });
      renameSync(fromFull, toFull);
      WRITE_HISTORY.push({ kind: 'move', from: relFrom, to: relTo });
      if (WRITE_HISTORY.length > WRITE_HISTORY_MAX) WRITE_HISTORY.shift();
      applied.push({ from: relFrom, to: relTo });
    } catch (e) { errors.push({ from: move.from, to: move.to, error: e.message }); }
  }
  return { ok: true, applied: applied.length, errors, plan: applied };
}

function runShell(command, argv, { cwd, timeout = 15_000, maxOut = 60_000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ error: e.message, stdout: '', stderr: '', exitCode: null }); return; }
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGTERM'); } catch {} }, timeout);
    proc.stdout.on('data', (d) => { if (stdout.length < maxOut) stdout += d; });
    proc.stderr.on('data', (d) => { if (stderr.length < maxOut) stderr += d; });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, stdout, stderr, exitCode: null }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdout, stderr }); });
  });
}

function requiresApproval(autonomy, name) {
  if (autonomy === 'auto') return false;
  if (autonomy === 'supervised') return RISKY_TOOLS.includes(name);
  // selective (default): writes + commands gated; everything else auto
  return autonomy === 'selective' && RISKY_TOOLS.includes(name);
}

async function executeTool(name, args, workspaceRoot, { autonomy, signal, readonly } = {}) {
  if (readonly && RISKY_TOOLS.includes(name)) {
    return { blocked: true, error: 'Read-only plan mode — this tool is disabled. Describe the change instead of making it.' };
  }
  if (requiresApproval(autonomy, name) && !args._approved) {
    return { blocked: true, error: `Tool "${name}" requires approval. Set _approved=true to proceed.` };
  }

  switch (name) {
    case 'read_file': {
      const target = resolve(workspaceRoot, args.path || '.');
      const rel = relative(workspaceRoot, target);
      if (rel.startsWith('..' + sep) || rel === '..') return { error: 'Path is outside workspace' };
      try {
        const st = statSync(target);
        if (st.isDirectory()) return { error: 'Path is a directory, use list_dir' };
        if (st.size > 500_000) return { error: 'File too large (over 500 KB)' };
        const content = readFileSync(target, 'utf8');
        return { content, path: rel, size: st.size };
      } catch (e) { return { error: e.message }; }
    }

    case 'write_file': {
      return await agentWriteFile(workspaceRoot, args.path, args.content);
    }

    case 'list_dir': {
      const target = resolve(workspaceRoot, args.path || '.');
      const rel = relative(workspaceRoot, target);
      if (rel.startsWith('..' + sep) || rel === '..') return { error: 'Path is outside workspace' };
      try {
        const entries = readdirSync(target, { withFileTypes: true })
          .filter((e) => !['.git', '.portable', 'node_modules'].includes(e.name))
          .slice(0, 200)
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
        return { path: rel || '.', entries };
      } catch (e) { return { error: e.message }; }
    }

    case 'run_command': {
      const command = (args.command || '').trim();
      if (!command) return { error: 'No command provided' };
      if (command.length > 1000) return { error: 'Command too long (max 1000 chars)' };
      return await new Promise((resolve) => {
        const proc = spawn(command, { cwd: workspaceRoot, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 60_000);
        proc.stdout.on('data', (d) => { if (stdout.length < 30_000) stdout += d; });
        proc.stderr.on('data', (d) => { if (stderr.length < 30_000) stderr += d; });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, stdout, stderr }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdout, stderr }); });
      });
    }

    case 'search_files': {
      const searchRoot = resolve(workspaceRoot, args.path || '.');
      const rel = relative(workspaceRoot, searchRoot);
      if (rel.startsWith('..' + sep) || rel === '..') return { error: 'Path is outside workspace' };
      try {
        const files = globSearch(searchRoot, args.pattern || '*').slice(0, 100);
        return { files, count: files.length };
      } catch (e) { return { error: e.message }; }
    }

    case 'grep_search': {
      const searchRoot = resolve(workspaceRoot, args.path || '.');
      const rel = relative(workspaceRoot, searchRoot);
      if (rel.startsWith('..' + sep) || rel === '..') return { error: 'Path is outside workspace' };
      try {
        const regex = new RegExp(args.pattern || '', 'i');
        const matches = grepSearch(searchRoot, regex, '', args.include || '');
        return { results: matches, file_count: matches.length };
      } catch (e) { return { error: 'Invalid regex: ' + e.message }; }
    }

    case 'git': {
      const argv = Array.isArray(args.args) ? args.args.map(String) : [];
      if (!argv.length) return { error: 'Git subcommand required (status, diff, log, show, branch, ls-files, rev-parse, remote, tag)' };
      const allowed = ['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'rev-parse', 'remote', 'tag'];
      if (!allowed.includes(argv[0])) return { error: `Git subcommand '${argv[0]}' is not allowed. Read-only set: ${allowed.join(', ')}` };
      if (argv.some((a) => a === '--hard' || a === '-f' || a === '--force')) return { error: 'Destructive git flags are not allowed' };
      if (argv.join(' ').length > 500) return { error: 'Git arguments too long (max 500 chars)' };
      return await runShell('git', argv, { cwd: workspaceRoot, timeout: 15_000 });
    }

    case 'run_tests': {
      let command = 'npm test';
      try {
        const pkg = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'));
        if (pkg?.scripts?.test) command = pkg.scripts.test;
      } catch {}
      if (args.name) command += ' -- ' + String(args.name);
      if (command.length > 500) return { error: 'Test command too long' };
      return await new Promise((resolve) => {
        const proc = spawn(command, { cwd: workspaceRoot, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 90_000);
        proc.stdout.on('data', (d) => { if (stdout.length < 60_000) stdout += d; });
        proc.stderr.on('data', (d) => { if (stderr.length < 60_000) stderr += d; });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, stdout, stderr }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdout, stderr }); });
      });
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Response parsing ────────────────────────────────────────────────────────
// Parse tool calls from LLM output. Supports two formats:
// 1. OpenAI-compatible tool_calls array (if model supports it)
// 2. XML-tag fallback for smaller models

export function parseToolCalls(content) {
  const calls = [];

  // Try XML tag format first (works with any model)
  const tagRegex = /<tool_call>\s*\n?({[\s\S]*?})\s*<\/tool_call>/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
      }
    } catch {}
  }

  // Also try ```tool_call blocks
  if (calls.length === 0) {
    const blockRegex = /```tool_call\s*\n?({[\s\S]*?})\s*```/g;
    while ((match = blockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.name) {
          calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
        }
      } catch {}
    }
  }

  return calls;
}

// ── Main agent loop ─────────────────────────────────────────────────────────

/**
 * Run the agent loop.
 *
 * @param {object} options
 * @param {string} options.task - The user's task description
 * @param {string} options.model - Ollama model name
 * @param {string} options.workspaceRoot - Path to workspace
 * @param {string} options.autonomy - 'supervised' | 'selective' | 'auto'
 * @param {string} options.skillPrompt - Optional skill-specific system prompt
 * @param {function} options.onEvent - Callback for status events: (event) => void
 * @param {function} options.onToken - Optional callback for streamed model text: (delta: string) => void
 * @param {function} options.llmCall - Async function: (messages, tools, onToken?) => { content, tool_calls }
 * @param {AbortSignal} options.signal - Abort signal
 * @returns {Promise<object>} Final result
 */
export async function runAgentLoop({
  task,
  model,
  workspaceRoot,
  autonomy = 'selective',
  skillPrompt = '',
  readonly = false,
  initialMessages = [],
  onEvent = () => {},
  onToken = () => {},
  llmCall,
  signal,
  supportsTools = true,
}) {
  const MAX_ITERATIONS = 25;
  const messages = [];
  const MAX_INITIAL = 36;
  const trimmedInitial = Array.isArray(initialMessages)
    ? initialMessages.filter((m) => m && m.role && m.role !== 'system').slice(-MAX_INITIAL).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 8000),
      }))
    : [];

  // Build system prompt
  let systemPrompt = BASE_AGENT_SYSTEM;
  if (!supportsTools) {
    systemPrompt = BASE_AGENT_SYSTEM
      .split('\n\n')
      .map((section) => section.startsWith('## How to use tools') ? '## Tools\nNo tools are available in this run. Answer directly in plain text — never emit tool-call tags, XML, or JSON blocks.' : section)
      .join('\n\n');
  }
  if (skillPrompt) systemPrompt += '\n\n' + skillPrompt;
  if (readonly) systemPrompt += '\n\n' + PLAN_SYSTEM;
  systemPrompt += `\n\n## Workspace
The project workspace is at: ${workspaceRoot}
Always use relative paths when referring to files.`;

  // Add tool usage instructions based on model capabilities
  systemPrompt += `\n\n## Tool Format
When you need to use a tool, output a tool call like this:
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

You can call one tool at a time. After each tool result, decide your next step.
When you have completed the task, provide a final summary without calling any tools.`;

  const threadSnapshot = () => messages.filter((m) => m.role !== 'system');
  messages.push({ role: 'system', content: systemPrompt });
  if (trimmedInitial.length) messages.push(...trimmedInitial);
  messages.push({ role: 'user', content: task });

  onEvent({ type: 'started', task, model, autonomy });

  const finalMessages = [];
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    if (signal?.aborted) {
      onEvent({ type: 'cancelled', message: 'Agent loop cancelled' });
      return { status: 'cancelled', iterations: iteration, thread: threadSnapshot() };
    }

    iteration++;
    onEvent({ type: 'thinking', iteration, message: `Step ${iteration}: Thinking...` });

    // Call the LLM
    let llmResponse;
    try {
      llmResponse = await llmCall(messages, AGENT_TOOLS, onToken);
    } catch (e) {
      onEvent({ type: 'error', message: `LLM error: ${e.message}` });
      return { status: 'error', error: e.message, iterations: iteration, thread: threadSnapshot() };
    }

    const content = llmResponse.content || '';
    const nativeToolCalls = llmResponse.tool_calls || [];

    // Parse tool calls from the content (XML tag format)
    const xmlToolCalls = parseToolCalls(content);

    // Merge: prefer native tool_calls if present, otherwise use XML-parsed ones
    const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : xmlToolCalls;

    // If no tool calls, this is the final answer
    if (toolCalls.length === 0) {
      // Strip any empty tool_call tags from the final answer
      const cleanContent = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/```tool_call[\s\S]*?```/g, '').trim();
      finalMessages.push({ role: 'assistant', content: cleanContent });
      onEvent({ type: 'completed', message: 'Task completed', content: cleanContent, iterations: iteration });
      return { status: 'complete', content: cleanContent, iterations: iteration, thread: threadSnapshot() };
    }

    // Add assistant message with the content (strip tool call tags for the model context)
    const contextContent = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/```tool_call[\s\S]*?```/g, '').trim();
    if (contextContent) {
      messages.push({ role: 'assistant', content: contextContent });
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      if (signal?.aborted) break;

      const toolName = tc.name;
      const toolArgs = tc.arguments || {};

      // Determine if this tool call needs approval
      const blockedByReadonly = readonly && RISKY_TOOLS.includes(toolName);
      const needsApproval = !blockedByReadonly && requiresApproval(autonomy, toolName);

      onEvent({
        type: 'tool_call',
        name: toolName,
        arguments: toolArgs,
        iteration,
        needs_approval: needsApproval,
      });

      if (needsApproval) {
        // Wait for approval
        const approved = await new Promise((resolve) => {
          onEvent({
            type: 'waiting_approval',
            name: toolName,
            arguments: toolArgs,
            resolve,
          });
        });

        if (!approved) {
          const toolResult = { blocked: true, error: 'Tool call rejected by user' };
          onEvent({ type: 'tool_result', name: toolName, result: toolResult });
          messages.push({
            role: 'assistant',
            content: `I tried to call ${toolName} but the user rejected it.`,
          });
          messages.push({
            role: 'user',
            content: `Tool result for ${toolName}: ${JSON.stringify(toolResult)}`,
          });
          continue;
        }
        // Approved: mark args so executeTool's guard passes
        toolArgs._approved = true;
      }

      // Execute the tool
      onEvent({ type: 'executing', name: toolName, message: `Running ${toolName}...` });
      const result = await executeTool(toolName, toolArgs, workspaceRoot, { autonomy, signal, readonly });
      onEvent({ type: 'tool_result', name: toolName, result });

      // Add tool result to messages
      const resultSummary = typeof result === 'string' ? result : JSON.stringify(result);
      messages.push({
        role: 'user',
        content: `Tool result for ${toolName}(${JSON.stringify(toolArgs)}):\n${resultSummary}`,
      });
    }
  }

  // Max iterations reached
  onEvent({
    type: 'completed',
    message: `Reached maximum iterations (${MAX_ITERATIONS}). Here is my progress so far.`,
    content: '(Max iterations reached)',
    iterations: iteration,
  });
  return { status: 'max_iterations', iterations: iteration, thread: threadSnapshot() };
}

// ── Web tools (using the research engine's search) ──────────────────────────

export async function webSearch(query, numResults = 5) {
  // Use DuckDuckGo HTML scraping (same as research engine)
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalAI/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await response.text();
    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    const links = [];
    while ((linkMatch = linkRegex.exec(html)) !== null) {
      let href = linkMatch[1];
      // Unwrap DuckDuckGo redirect
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
      const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
      links.push({ url: href, title });
    }
    const snippets = [];
    let snippetMatch;
    while ((snippetMatch = snippetRegex.exec(html)) !== null) {
      snippets.push(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    for (let i = 0; i < Math.min(links.length, numResults); i++) {
      results.push({
        url: links[i].url,
        title: links[i].title,
        snippet: snippets[i] || '',
      });
    }
    return results;
  } catch (e) {
    return [{ error: e.message }];
  }
}

export async function webFetchPage(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalAI/1.0)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const html = await response.text();
    // Simple content extraction
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15_000);
    return { content: text, url };
  } catch (e) {
    return { error: e.message, url };
  }
}
