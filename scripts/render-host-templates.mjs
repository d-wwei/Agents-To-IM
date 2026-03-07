import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') out.host = argv[++i];
    else if (arg === '--target') out.target = argv[++i];
    else if (arg === '--templates') out.templates = argv[++i];
    else if (arg === '--repo-home') out.repoHome = true;
  }
  if (!out.target || (!out.repoHome && !out.host)) {
    throw new Error('Usage: node scripts/render-host-templates.mjs --host <host> --target <dir> [--templates <dir>] | --repo-home --target <dir> [--templates <dir>]');
  }
  return out;
}

function titleCase(host) {
  return host
    .split(/[-_]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getHostSkillsDir(host) {
  switch (host) {
    case 'claude': return '~/.claude/skills';
    case 'codex': return '~/.codex/skills';
    case 'gemini': return '~/.gemini/skills';
    default: return `~/.${host}/skills`;
  }
}

function getVerifyInstallation(host, skillCommand, runtimeHome) {
  const display = titleCase(host);
  if (host === 'claude') {
    return {
      en: `**${display}:** Start a new session and type \`/\` — you should see \`${skillCommand}\` in the skill list.`,
      zh: `**${display}：** 启动新会话，输入 \`/\` 应能看到 \`${skillCommand}\`。`,
    };
  }
  return {
    en: `**${display}:** Start a new session and say \`${skillCommand} setup\` or \`start bridge\` — ${display} will recognize the skill and use \`${runtimeHome}\` for its runtime data.`,
    zh: `**${display}：** 启动新会话，说 \`${skillCommand} setup\` 或“启动桥接”，${display} 会识别 Skill 并使用 \`${runtimeHome}\` 作为运行时目录。`,
  };
}

function getPrerequisites(host) {
  switch (host) {
    case 'claude':
      return {
        en: [
          '- **Node.js >= 20**',
          '- **Claude Code CLI** — installed and authenticated (`claude` command available)',
          '- **Optional Codex CLI** (only if you plan to use `CTI_RUNTIME=codex` or `auto`) — `npm install -g @openai/codex`',
        ].join('\n'),
        zh: [
          '- **Node.js >= 20**',
          '- **Claude Code CLI** — 已安装并完成认证（`claude` 命令可用）',
          '- **可选的 Codex CLI**（仅当你计划使用 `CTI_RUNTIME=codex` 或 `auto` 时）— `npm install -g @openai/codex`',
        ].join('\n'),
      };
    case 'codex':
      return {
        en: [
          '- **Node.js >= 20**',
          '- **Codex CLI** — installed and authenticated (`codex` command available; login via `codex login`)',
          '- **Optional Claude CLI** (only if you plan to use `CTI_RUNTIME=claude` or `auto`)',
        ].join('\n'),
        zh: [
          '- **Node.js >= 20**',
          '- **Codex CLI** — 已安装并完成认证（`codex` 命令可用；可通过 `codex login` 登录）',
          '- **可选的 Claude CLI**（仅当你计划使用 `CTI_RUNTIME=claude` 或 `auto` 时）',
        ].join('\n'),
      };
    case 'gemini':
      return {
        en: [
          '- **Node.js >= 20**',
          '- **Your Gemini host integration** — available and configured in the environment where this skill will run',
          '- **Codex CLI** (required only when `CTI_RUNTIME=codex`) — `npm install -g @openai/codex`',
          '- **Claude CLI** (required only when `CTI_RUNTIME=claude`)',
        ].join('\n'),
        zh: [
          '- **Node.js >= 20**',
          '- **Gemini 宿主集成** — 已在运行此 Skill 的环境中可用并完成配置',
          '- **Codex CLI**（仅当 `CTI_RUNTIME=codex` 时需要）— `npm install -g @openai/codex`',
          '- **Claude CLI**（仅当 `CTI_RUNTIME=claude` 时需要）',
        ].join('\n'),
      };
    default:
      return {
        en: [
          '- **Node.js >= 20**',
          '- **The CLI or host integration required by your selected runtime**',
        ].join('\n'),
        zh: [
          '- **Node.js >= 20**',
          '- **你所选 runtime 需要的 CLI 或宿主集成**',
        ].join('\n'),
      };
  }
}

function getRuntimeNotes(host) {
  switch (host) {
    case 'claude':
      return [
        '  - `claude` — recommended in this host; uses Claude Code CLI + Claude Agent SDK',
        '  - `codex` — optional alternative; uses OpenAI Codex SDK',
        '  - `gemini` — optional alternative; uses Gemini CLI',
        '  - `auto` — tries Gemini first, then Claude, then falls back to Codex',
      ].join('\n');
    case 'codex':
      return [
        '  - `claude` — optional alternative; uses Claude CLI + Claude Agent SDK',
        '  - `codex` — recommended in this host; uses OpenAI Codex SDK',
        '  - `gemini` — optional alternative; uses Gemini CLI',
        '  - `auto` — tries Gemini first, then Claude, then falls back to Codex if needed',
      ].join('\n');
    case 'gemini':
      return [
        '  - `claude` — available when Claude CLI is installed',
        '  - `codex` — available when Codex CLI / SDK is installed',
        '  - `gemini` — recommended in this host; uses Gemini CLI',
        '  - `auto` — tries Gemini first, then Claude, then falls back to Codex if needed',
      ].join('\n');
    default:
      return [
        '  - `claude` — uses Claude CLI + Claude Agent SDK',
        '  - `codex` — uses OpenAI Codex SDK',
        '  - `gemini` — uses Gemini CLI',
        '  - `auto` — tries Gemini first, then Claude, then falls back to Codex if needed',
      ].join('\n');
  }
}

function getConfigRuntimeNotes(host) {
  switch (host) {
    case 'claude':
      return [
        '#   claude (default) — recommended in this host; uses Claude Code CLI + @anthropic-ai/claude-agent-sdk',
        '#   codex  — optional alternative; uses @openai/codex-sdk',
        '#   gemini — optional alternative; uses Gemini CLI',
        '#   auto   — tries Gemini first, then Claude, then falls back to Codex if CLI not found',
      ].join('\n');
    case 'codex':
      return [
        '#   claude (optional) — uses Claude CLI + @anthropic-ai/claude-agent-sdk',
        '#   codex  (recommended) — uses @openai/codex-sdk',
        '#   gemini — optional alternative; uses Gemini CLI',
        '#   auto   — tries Gemini first, then Claude, then falls back to Codex if CLI not found',
      ].join('\n');
    case 'gemini':
      return [
        '#   claude — available when Claude CLI is installed',
        '#   codex  — available when @openai/codex-sdk / Codex CLI is configured',
        '#   gemini (recommended) — uses Gemini CLI',
        '#   auto   — tries Gemini first, then Claude, then falls back to Codex if needed',
      ].join('\n');
    default:
      return [
        '#   claude — uses Claude CLI + @anthropic-ai/claude-agent-sdk',
        '#   codex  — uses @openai/codex-sdk',
        '#   gemini — uses Gemini CLI',
        '#   auto   — tries Gemini first, then Claude, then falls back to Codex if CLI not found',
      ].join('\n');
  }
}

function getRuntimeOptions(host) {
  switch (host) {
    case 'claude':
      return '`claude` (default), `codex`, `gemini`, `auto`';
    case 'codex':
      return '`claude`, `codex` (default), `gemini`, `auto`';
    case 'gemini':
      return '`claude`, `codex`, `gemini` (default), `auto`';
    default:
      return '`claude`, `codex`, `gemini`, `auto`';
  }
}

function getDefaultRuntime(host) {
  switch (host) {
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'claude':
    default:
      return 'claude';
  }
}

function getInstallLead(host) {
  switch (host) {
    case 'claude':
      return {
        en: 'If you use Claude Code, clone directly into the Claude skills directory:',
        zh: '如果你使用 Claude Code，直接克隆到 Claude skills 目录：',
      };
    case 'codex':
      return {
        en: 'If you use Codex, clone directly into the Codex skills directory:',
        zh: '如果你使用 Codex，直接克隆到 Codex skills 目录：',
      };
    case 'gemini':
      return {
        en: 'If you use Gemini, clone directly into the Gemini skills directory used by your host integration:',
        zh: '如果你使用 Gemini，直接克隆到 Gemini 宿主集成使用的 skills 目录：',
      };
    default:
      return {
        en: `If you use ${titleCase(host)}, clone directly into that host's skills directory:`,
        zh: `如果你使用 ${titleCase(host)}，直接克隆到对应宿主的 skills 目录：`,
      };
  }
}

function renderTemplate(content, variables) {
  return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in variables)) {
      throw new Error(`Unknown template variable: ${key}`);
    }
    return variables[key];
  });
}

function renderFile(templatePath, outputPath, variables) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const rendered = renderTemplate(template, variables);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered, 'utf8');
}

const { host, target, templates, repoHome } = parseArgs(process.argv);
const templateDir = templates || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates');

if (repoHome) {
  renderFile(path.join(templateDir, 'README.repo.md.tmpl'), path.join(target, 'README.md'), {});
  renderFile(path.join(templateDir, 'README_CN.repo.md.tmpl'), path.join(target, 'README_CN.md'), {});
} else {
  const hostDisplay = titleCase(host);
  const skillCommand = `${host}-to-im`;
  const runtimeHome = `~/.${skillCommand}`;
  const verify = getVerifyInstallation(host, skillCommand, runtimeHome);
  const prerequisites = getPrerequisites(host);
  const runtimeNotes = getRuntimeNotes(host);
  const configRuntimeNotes = getConfigRuntimeNotes(host);
  const installLead = getInstallLead(host);

  const variables = {
    HOST: host,
    HOST_DISPLAY: hostDisplay,
    SKILL_COMMAND: skillCommand,
    DEFAULT_RUNTIME: getDefaultRuntime(host),
    RUNTIME_HOME: runtimeHome,
    RUNTIME_OPTIONS_EN: getRuntimeOptions(host),
    RUNTIME_OPTIONS_PLAIN: 'claude | codex | gemini | auto',
    HOST_SKILLS_DIR: getHostSkillsDir(host),
    VERIFY_INSTALLATION_EN: verify.en,
    VERIFY_INSTALLATION_ZH: verify.zh,
    PREREQUISITES_EN: prerequisites.en,
    PREREQUISITES_ZH: prerequisites.zh,
    RUNTIME_NOTES_EN: runtimeNotes,
    CONFIG_RUNTIME_NOTES: configRuntimeNotes,
    INSTALL_LEAD_EN: installLead.en,
    INSTALL_LEAD_ZH: installLead.zh,
  };

  const files = [
    'SKILL.md',
    'README.md',
    'README_CN.md',
    'SECURITY.md',
    'config.env.example',
    path.join('references', 'usage.md'),
    path.join('references', 'troubleshooting.md'),
  ];

  for (const relative of files) {
    renderFile(path.join(templateDir, `${relative}.tmpl`), path.join(target, relative), variables);
  }
}
