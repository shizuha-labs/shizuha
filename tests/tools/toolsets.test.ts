import { describe, it, expect } from 'vitest';
import { ToolsetManager, BUILTIN_TOOLSETS } from '../../src/tools/toolsets.js';

// ── Helper ──

const ALL_TOOLS = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'notebook',
  'web_fetch', 'web_search', 'ask_user', 'task', 'todo_write', 'todo_read',
  'enter_plan_mode', 'exit_plan_mode', 'task_output', 'task_stop',
  'schedule_job', 'list_jobs', 'remove_job', 'memory', 'text_to_speech',
  'image_gen', 'session_search', 'usage_stats',
  'mcp__pulse__list_tasks', 'mcp__pulse__create_task',
  'mcp__inventory__list_items', 'mcp__inventory__create_item',
  'mcp__mail__send_email', 'mcp__mail__list_messages',
];

// ── Tests ──

describe('ToolsetManager', () => {
  describe('constructor', () => {
    it('seeds with built-in toolsets', () => {
      const manager = new ToolsetManager();
      const toolsets = manager.list();
      expect(toolsets.length).toBeGreaterThanOrEqual(4);
      expect(manager.get('full')).toBeDefined();
      expect(manager.get('safe')).toBeDefined();
      expect(manager.get('messaging')).toBeDefined();
      expect(manager.get('developer')).toBeDefined();
    });
  });

  describe('register', () => {
    it('registers a custom toolset', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'custom',
        description: 'Custom tools',
        include: ['read', 'glob'],
      });
      expect(manager.get('custom')).toBeDefined();
      expect(manager.get('custom')!.description).toBe('Custom tools');
    });

    it('overwrites existing toolset with same name', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'safe',
        description: 'My custom safe set',
        include: ['read'],
      });
      expect(manager.get('safe')!.description).toBe('My custom safe set');
      expect(manager.get('safe')!.include).toEqual(['read']);
    });
  });

  describe('list', () => {
    it('returns all toolsets', () => {
      const manager = new ToolsetManager();
      const names = manager.list().map((t) => t.name);
      expect(names).toContain('full');
      expect(names).toContain('safe');
      expect(names).toContain('messaging');
      expect(names).toContain('developer');
    });
  });

  describe('filterTools', () => {
    it('full toolset returns all tools', () => {
      const manager = new ToolsetManager();
      const result = manager.filterTools('full', ALL_TOOLS);
      expect(result).toEqual(ALL_TOOLS);
    });

    it('safe toolset returns only read-only tools', () => {
      const manager = new ToolsetManager();
      const result = manager.filterTools('safe', ALL_TOOLS);
      expect(result).toContain('read');
      expect(result).toContain('glob');
      expect(result).toContain('grep');
      expect(result).toContain('web_fetch');
      expect(result).toContain('session_search');
      expect(result).toContain('memory');
      expect(result).not.toContain('write');
      expect(result).not.toContain('bash');
      expect(result).not.toContain('edit');
      expect(result).not.toContain('mcp__pulse__list_tasks');
    });

    it('messaging toolset excludes dangerous tools', () => {
      const manager = new ToolsetManager();
      const result = manager.filterTools('messaging', ALL_TOOLS);
      expect(result).not.toContain('bash');
      expect(result).not.toContain('write');
      expect(result).not.toContain('edit');
      expect(result).not.toContain('notebook');
      // Should still include read-only and MCP tools
      expect(result).toContain('read');
      expect(result).toContain('glob');
      expect(result).toContain('mcp__pulse__list_tasks');
      expect(result).toContain('mcp__mail__send_email');
    });

    it('developer toolset includes dev tools', () => {
      const manager = new ToolsetManager();
      const result = manager.filterTools('developer', ALL_TOOLS);
      expect(result).toContain('read');
      expect(result).toContain('write');
      expect(result).toContain('edit');
      expect(result).toContain('bash');
      expect(result).toContain('notebook');
      expect(result).toContain('web_fetch');
      expect(result).not.toContain('ask_user');
      expect(result).not.toContain('mcp__pulse__list_tasks');
    });

    it('unknown toolset returns all tools', () => {
      const manager = new ToolsetManager();
      const result = manager.filterTools('nonexistent', ALL_TOOLS);
      expect(result).toEqual(ALL_TOOLS);
    });

    it('supports glob patterns in include', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'mcp-only',
        include: ['mcp__*'],
      });
      const result = manager.filterTools('mcp-only', ALL_TOOLS);
      expect(result.length).toBe(6);
      expect(result.every((n) => n.startsWith('mcp__'))).toBe(true);
    });

    it('supports glob patterns in exclude', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'no-mcp',
        include: ['*'],
        exclude: ['mcp__*'],
      });
      const result = manager.filterTools('no-mcp', ALL_TOOLS);
      expect(result.every((n) => !n.startsWith('mcp__'))).toBe(true);
      expect(result).toContain('read');
      expect(result).toContain('bash');
    });

    it('supports MCP server prefix matching in include', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'pulse-only',
        include: ['read', 'mcp__pulse'],
      });
      const result = manager.filterTools('pulse-only', ALL_TOOLS);
      expect(result).toContain('read');
      expect(result).toContain('mcp__pulse__list_tasks');
      expect(result).toContain('mcp__pulse__create_task');
      expect(result).not.toContain('mcp__inventory__list_items');
      expect(result).not.toContain('bash');
    });

    it('exclude takes precedence over include', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'include-then-exclude',
        include: ['*'],
        exclude: ['read', 'glob'],
      });
      const result = manager.filterTools('include-then-exclude', ALL_TOOLS);
      expect(result).not.toContain('read');
      expect(result).not.toContain('glob');
      expect(result).toContain('write');
      expect(result).toContain('bash');
    });

    it('handles empty include (nothing matches)', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'empty',
        include: [],
      });
      const result = manager.filterTools('empty', ALL_TOOLS);
      expect(result.length).toBe(0);
    });

    it('handles empty tool list', () => {
      const manager = new ToolsetManager();
      const result = manager.filterTools('full', []);
      expect(result.length).toBe(0);
    });
  });
});

describe('BUILTIN_TOOLSETS', () => {
  it('full toolset includes wildcard', () => {
    expect(BUILTIN_TOOLSETS['full']!.include).toEqual(['*']);
    expect(BUILTIN_TOOLSETS['full']!.exclude).toBeUndefined();
  });

  it('safe toolset has no wildcard', () => {
    expect(BUILTIN_TOOLSETS['safe']!.include).not.toContain('*');
    expect(BUILTIN_TOOLSETS['safe']!.include).toContain('read');
  });

  it('messaging toolset uses wildcard include with exclude list', () => {
    expect(BUILTIN_TOOLSETS['messaging']!.include).toEqual(['*']);
    expect(BUILTIN_TOOLSETS['messaging']!.exclude).toContain('bash');
    expect(BUILTIN_TOOLSETS['messaging']!.exclude).toContain('write');
  });

  it('all toolsets have name and description', () => {
    for (const [key, toolset] of Object.entries(BUILTIN_TOOLSETS)) {
      expect(toolset.name).toBe(key);
      expect(toolset.description).toBeTruthy();
    }
  });

  it('has all 6 role-based profiles', () => {
    expect(BUILTIN_TOOLSETS['architect']).toBeDefined();
    expect(BUILTIN_TOOLSETS['engineer']).toBeDefined();
    expect(BUILTIN_TOOLSETS['qa_engineer']).toBeDefined();
    expect(BUILTIN_TOOLSETS['security_engineer']).toBeDefined();
    expect(BUILTIN_TOOLSETS['technical_writer']).toBeDefined();
    expect(BUILTIN_TOOLSETS['data_analyst']).toBeDefined();
  });
});

describe('Role-based profiles', () => {
  const manager = new ToolsetManager();

  it('architect gets read tools + pulse/wiki/drive/admin MCP, no write/bash', () => {
    const result = manager.filterTools('architect', ALL_TOOLS);
    expect(result).toContain('read');
    expect(result).toContain('glob');
    expect(result).toContain('grep');
    expect(result).toContain('mcp__pulse__list_tasks');
    expect(result).not.toContain('write');
    expect(result).not.toContain('bash');
    expect(result).not.toContain('edit');
    expect(result).not.toContain('mcp__mail__send_email');
  });

  it('engineer gets everything (same as full)', () => {
    const result = manager.filterTools('engineer', ALL_TOOLS);
    expect(result).toEqual(ALL_TOOLS);
  });

  it('qa_engineer gets read tools + browser, no write/bash/edit', () => {
    const result = manager.filterTools('qa_engineer', ALL_TOOLS);
    expect(result).toContain('read');
    expect(result).toContain('glob');
    expect(result).toContain('mcp__pulse__list_tasks');
    expect(result).not.toContain('write');
    expect(result).not.toContain('bash');
    expect(result).not.toContain('edit');
    expect(result).not.toContain('mcp__inventory__list_items');
    expect(result).not.toContain('mcp__mail__send_email');
  });

  it('security_engineer gets bash + browser but not write/edit', () => {
    const result = manager.filterTools('security_engineer', ALL_TOOLS);
    expect(result).toContain('read');
    expect(result).toContain('bash');
    expect(result).toContain('mcp__pulse__list_tasks');
    expect(result).not.toContain('write');
    expect(result).not.toContain('edit');
    expect(result).not.toContain('mcp__mail__send_email');
  });

  it('technical_writer gets write/edit but not bash', () => {
    const result = manager.filterTools('technical_writer', ALL_TOOLS);
    expect(result).toContain('read');
    expect(result).toContain('write');
    expect(result).toContain('edit');
    expect(result).toContain('mcp__pulse__list_tasks');
    expect(result).not.toContain('bash');
    expect(result).not.toContain('mcp__mail__send_email');
    expect(result).not.toContain('mcp__inventory__list_items');
  });

  it('data_analyst gets bash + data MCP servers, not write/edit', () => {
    const result = manager.filterTools('data_analyst', ALL_TOOLS);
    expect(result).toContain('read');
    expect(result).toContain('bash');
    expect(result).toContain('mcp__pulse__list_tasks');
    expect(result).not.toContain('write');
    expect(result).not.toContain('edit');
    expect(result).not.toContain('mcp__mail__send_email');
  });

  it('role profiles enforce MCP access matrix from CLAUDE.md', () => {
    const mcpTools = [
      'mcp__pulse__list_tasks', 'mcp__wiki__get_page', 'mcp__drive__list_files',
      'mcp__admin__list_users', 'mcp__id__get_user', 'mcp__notes__create_note',
      'mcp__mail__send_email', 'mcp__inventory__list_items', 'mcp__books__list_vouchers',
      'mcp__finance__list_accounts', 'mcp__hr__list_employees', 'mcp__time__list_entries',
      'mcp__connect__list_posts', 'mcp__scs__list_instances',
    ];
    const allWithMcp = [...ALL_TOOLS, ...mcpTools.filter((t) => !ALL_TOOLS.includes(t))];

    // Architect: pulse, wiki, drive, admin — NOT id, notes, mail, etc.
    const arch = manager.filterTools('architect', allWithMcp);
    expect(arch).toContain('mcp__pulse__list_tasks');
    expect(arch).toContain('mcp__wiki__get_page');
    expect(arch).toContain('mcp__drive__list_files');
    expect(arch).toContain('mcp__admin__list_users');
    expect(arch).not.toContain('mcp__id__get_user');
    expect(arch).not.toContain('mcp__mail__send_email');

    // QA: pulse, wiki, drive — NOT admin, id, notes, etc.
    const qa = manager.filterTools('qa_engineer', allWithMcp);
    expect(qa).toContain('mcp__pulse__list_tasks');
    expect(qa).toContain('mcp__wiki__get_page');
    expect(qa).not.toContain('mcp__admin__list_users');
    expect(qa).not.toContain('mcp__id__get_user');
    expect(qa).not.toContain('mcp__inventory__list_items');

    // Security: pulse, wiki, drive, id, scs — NOT admin, notes, mail, etc.
    const sec = manager.filterTools('security_engineer', allWithMcp);
    expect(sec).toContain('mcp__pulse__list_tasks');
    expect(sec).toContain('mcp__id__get_user');
    expect(sec).toContain('mcp__scs__list_instances');
    expect(sec).not.toContain('mcp__admin__list_users');
    expect(sec).not.toContain('mcp__mail__send_email');

    // Data: pulse, wiki, drive, books, finance, hr, time, inventory
    const data = manager.filterTools('data_analyst', allWithMcp);
    expect(data).toContain('mcp__pulse__list_tasks');
    expect(data).toContain('mcp__books__list_vouchers');
    expect(data).toContain('mcp__finance__list_accounts');
    expect(data).toContain('mcp__hr__list_employees');
    expect(data).toContain('mcp__time__list_entries');
    expect(data).toContain('mcp__inventory__list_items');
    expect(data).not.toContain('mcp__admin__list_users');
    expect(data).not.toContain('mcp__mail__send_email');
    expect(data).not.toContain('mcp__connect__list_posts');
  });
});
