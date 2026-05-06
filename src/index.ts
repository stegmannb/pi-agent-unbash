import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { parse as parseBash } from "unbash";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { extractAllCommandsFromAST } from "./extract.ts";
import { getCommandName, resolveCommandAction } from "./resolve.ts";
import { formatCommand, FORMAT_COMMAND_DEFAULT_MAX_LENGTH, FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH } from "./format.ts";
import { buildApprovalPrompt } from "./prompt.ts";
import { DEFAULT_RULES } from "./defaults.ts";
import type { RuleAction } from "./types.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const GLOBAL_CONFIG_PATH = path.join(AGENT_DIR, "unbash.json");

interface UnbashConfig {
  enabled: boolean;
  rules: Record<string, RuleAction>;
  commandDisplayMaxLength: number;
  commandDisplayArgMaxLength: number;
}

interface LoadedConfigResult {
  config: UnbashConfig;
  warning?: string;
}

const DEFAULT_CONFIG: UnbashConfig = {
  enabled: true,
  rules: {},
  commandDisplayMaxLength: FORMAT_COMMAND_DEFAULT_MAX_LENGTH,
  commandDisplayArgMaxLength: FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH,
};

const SAFE_FALLBACK_CONFIG: UnbashConfig = {
  enabled: true,
  rules: {},
  commandDisplayMaxLength: FORMAT_COMMAND_DEFAULT_MAX_LENGTH,
  commandDisplayArgMaxLength: FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH,
};

/**
 * Merge default, user, project, and session rules. Later layers win for
 * "allow" and "ask". "deny" is a veto: any layer that sets a key to "deny"
 * wins unconditionally, regardless of what other layers say for that key.
 */
export function buildEffectiveRules(
  userRules: Record<string, RuleAction>,
  projectRules: Record<string, RuleAction>,
  sessionRules: Record<string, RuleAction>,
): Record<string, RuleAction> {
  const merged = { ...DEFAULT_RULES, ...userRules, ...projectRules, ...sessionRules };

  // Re-apply deny from every layer so no later layer can override a veto.
  for (const layer of [DEFAULT_RULES, userRules, projectRules, sessionRules]) {
    for (const [key, action] of Object.entries(layer)) {
      if (action === "deny") merged[key] = "deny";
    }
  }

  return merged;
}

/** Load project-level unbash config from .pi/unbash.json in the given directory. */
function loadProjectConfig(cwd: string): LoadedConfigResult | null {
  const projectConfigPath = path.join(cwd, ".pi", "unbash.json");
  if (!fs.existsSync(projectConfigPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(projectConfigPath, "utf-8");
    const parsed = JSON.parse(data);
    return validateLoadedUnbashConfig(parsed);
  } catch (e) {
    return {
      config: { ...SAFE_FALLBACK_CONFIG },
      warning: "Failed to parse project .pi/unbash.json; using safe fallback.",
    };
  }
}

/**
 * Returns true if `filePath` is writable by the current process.
 * If the file does not yet exist, checks whether its parent directory is writable.
 * Used to detect read-only configs (e.g. Nix-store symlinks) and hide the
 * "Allow globally" option when it would always fail.
 */
function isConfigWritable(filePath: string): boolean {
  if (fs.existsSync(filePath)) {
    // File already exists (may be a read-only Nix-store symlink).
    // Only the file itself determines writeability; a writable parent
    // directory does NOT help because we cannot overwrite through a
    // read-only symlink by creating a new file at the same path.
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  // File does not exist yet — check whether we can create it.
  try {
    fs.accessSync(path.dirname(filePath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds a single rule to a config file (project or global).
 * Creates the file if it does not yet exist.
 * Preserves all other existing config values.
 */
function saveRuleToConfig(configPath: string, commandName: string, action: RuleAction): void {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let existing: Partial<UnbashConfig> = {};
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const result = validateLoadedUnbashConfig(raw);
      existing = result.config;
    }
    const updated = {
      ...existing,
      rules: { ...(existing.rules ?? {}), [commandName]: action },
    };
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  } catch (e) {
    console.error(`Failed to save rule to ${configPath}`, e);
  }
}

export function validateLoadedUnbashConfig(input: unknown): LoadedConfigResult {
  if (!input || typeof input !== "object") {
    return {
      config: { ...SAFE_FALLBACK_CONFIG },
      warning: "Invalid unbash config shape; using safe fallback (enabled=true, rules={}).",
    };
  }

  const cfg = input as Record<string, unknown>;
  const warnings: string[] = [];

  let enabled = SAFE_FALLBACK_CONFIG.enabled;
  if (typeof cfg.enabled === "boolean") {
    enabled = cfg.enabled;
  } else if (cfg.enabled !== undefined) {
    warnings.push("enabled must be a boolean");
  }

  let rules: Record<string, RuleAction> = {};
  if (cfg.rules !== undefined) {
    if (cfg.rules && typeof cfg.rules === "object" && !Array.isArray(cfg.rules)) {
      const validRules: Record<string, RuleAction> = {};
      let hasInvalid = false;
      for (const [key, value] of Object.entries(cfg.rules as Record<string, unknown>)) {
        if (typeof key === "string" && key.trim().length > 0 && (value === "allow" || value === "ask" || value === "deny")) {
          validRules[key] = value;
        } else {
          hasInvalid = true;
        }
      }
      if (hasInvalid) {
        warnings.push('rules must be an object mapping non-empty strings to "allow", "ask", or "deny"');
      }
      rules = validRules;
    } else {
      warnings.push('rules must be an object mapping non-empty strings to "allow", "ask", or "deny"');
    }
  }

  let commandDisplayMaxLength = SAFE_FALLBACK_CONFIG.commandDisplayMaxLength;
  if (typeof cfg.commandDisplayMaxLength === "number" && cfg.commandDisplayMaxLength > 0) {
    commandDisplayMaxLength = cfg.commandDisplayMaxLength;
  } else if (cfg.commandDisplayMaxLength !== undefined) {
    warnings.push("commandDisplayMaxLength must be a positive number");
  }

  let commandDisplayArgMaxLength = SAFE_FALLBACK_CONFIG.commandDisplayArgMaxLength;
  if (typeof cfg.commandDisplayArgMaxLength === "number" && cfg.commandDisplayArgMaxLength > 0) {
    commandDisplayArgMaxLength = cfg.commandDisplayArgMaxLength;
  } else if (cfg.commandDisplayArgMaxLength !== undefined) {
    warnings.push("commandDisplayArgMaxLength must be a positive number");
  }

  if (warnings.length > 0) {
    return {
      config: { enabled, rules, commandDisplayMaxLength, commandDisplayArgMaxLength },
      warning: `Invalid unbash config fields (${warnings.join("; ")}); using safe values for invalid fields.`,
    };
  }

  return { config: { enabled, rules, commandDisplayMaxLength, commandDisplayArgMaxLength } };
}

function loadConfig(): LoadedConfigResult {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const data = fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(data);
      return validateLoadedUnbashConfig(parsed);
    } catch (e) {
      return {
        config: { ...SAFE_FALLBACK_CONFIG },
        warning: "Failed to parse unbash.json; using safe fallback (enabled=true, rules={}).",
      };
    }
  }
  return { config: DEFAULT_CONFIG };
}

function saveConfig(config: UnbashConfig) {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    // Only save user rules, never the merged effective set
    const toSave: Record<string, unknown> = {
      enabled: config.enabled,
      rules: config.rules,
      ...(config.commandDisplayMaxLength !== FORMAT_COMMAND_DEFAULT_MAX_LENGTH && { commandDisplayMaxLength: config.commandDisplayMaxLength }),
      ...(config.commandDisplayArgMaxLength !== FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH && { commandDisplayArgMaxLength: config.commandDisplayArgMaxLength }),
    };
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(toSave, null, 2) + "\n", "utf-8");
  } catch (e) {
    console.error("Failed to save unbash config to unbash.json", e);
  }
}

export function parseUnbashArgs(args: string): { action: string; target: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "", target: "" };

  const [action = "", ...targetParts] = trimmed.split(/\s+/);
  const target = targetParts.join(" ").trim();

  return { action, target };
}

export default function (pi: ExtensionAPI) {
  const loaded = loadConfig();
  let config = loaded.config;
  let configWarning = loaded.warning;
  const sessionRules: Record<string, RuleAction> = {};

  // Session-only enabled override — null means "use config.enabled", like sandbox's userDisabled.
  let sessionEnabled: boolean | null = null;

  function isEnabled(): boolean {
    return sessionEnabled !== null ? sessionEnabled : config.enabled;
  }

  if (configWarning) {
    console.warn(`[pi-unbash] ${configWarning}`);
  }

  function setUnbashStatus(ctx: { ui: { setStatus: (key: string, text: string) => void; theme: { fg: (color: string, text: string) => string } } }, enabled: boolean, cfg?: UnbashConfig) {
    if (enabled) {
      const totalRules = Object.keys(DEFAULT_RULES).length + Object.keys(cfg?.rules ?? {}).length;
      ctx.ui.setStatus("unbash", ctx.ui.theme.fg("accent", `🛡️  Unbash: ${totalRules} rules`));
    } else {
      ctx.ui.setStatus("unbash", "🛡️ Unbash: off");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const enabled = isEnabled();
    setUnbashStatus(ctx, enabled, config);
    if (sessionEnabled === false) {
      ctx.ui.notify("Unbash disabled (user override active)", "warning");
    }
  });

  pi.registerCommand("unbash-enable", {
    description: "Enable pi-unbash command approval for this session",
    handler: async (_args, ctx) => {
      if (isEnabled()) {
        ctx.ui.notify("Unbash is already enabled", "info");
        return;
      }
      sessionEnabled = true;
      setUnbashStatus(ctx, true, config);
      ctx.ui.notify("Unbash enabled (this session only)", "info");
    },
  });

  pi.registerCommand("unbash-disable", {
    description: "Disable pi-unbash command approval for this session",
    handler: async (_args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("Unbash is already disabled", "info");
        return;
      }
      sessionEnabled = false;
      setUnbashStatus(ctx, false, config);
      ctx.ui.notify("Unbash disabled (this session only)", "warning");
    },
  });

  // Settings Management Command
  pi.registerCommand("unbash", {
    description: "Manage pi-unbash security settings",
    handler: async (args, ctx) => {
      if (configWarning && ctx.hasUI) {
        ctx.ui.notify(`[pi-unbash] ${configWarning}`, "warning");
        configWarning = undefined;
      }

      const { action, target } = parseUnbashArgs(args);

      if (action === "allow" && target) {
        config.rules[target] = "allow";
        saveConfig(config);
        ctx.ui.notify(`'${target}' added to allowed commands.`, "info");
      } else if (action === "toggle") {
        sessionEnabled = !isEnabled();
        setUnbashStatus(ctx, isEnabled(), config);
        ctx.ui.notify(`Unbash is now ${isEnabled() ? "ENABLED" : "DISABLED"} (this session only)`, "info");
      } else if (action === "list") {
        const defaultLines = Object.entries(DEFAULT_RULES)
          .map(([pattern, act]) => `  ${pattern}: ${act}`)
          .join("\n");

        const globalWritable = isConfigWritable(GLOBAL_CONFIG_PATH);
        const userLines = Object.entries(config.rules).length > 0
          ? Object.entries(config.rules).map(([pattern, act]) => `  ${pattern}: ${act}`).join("\n")
          : "  (none)";

        // Load project rules for display
        const projectResult = loadProjectConfig(ctx.cwd);
        const projectRules = projectResult?.config.rules ?? {};
        const projectLines = Object.entries(projectRules).length > 0
          ? Object.entries(projectRules).map(([pattern, act]) => `  ${pattern}: ${act}`).join("\n")
          : "  (none)";

        const sessionLines = Object.entries(sessionRules).length > 0
          ? Object.entries(sessionRules).map(([pattern, act]) => `  ${pattern}: ${act}`).join("\n")
          : "  (none)";

        const readOnlyNote = globalWritable ? "" : "\n⚠️  Global config is read-only (managed by Nix)";

        const projectEnabled = projectResult?.config.enabled;
        const projectEnabledNote = projectEnabled === false ? " (disabled by project config)" : "";

        ctx.ui.notify(
          `pi-unbash: ${isEnabled() ? "ENABLED" : "DISABLED"}${projectEnabledNote}${readOnlyNote}\n\nGlobal config: ${GLOBAL_CONFIG_PATH}\nProject config: ${path.join(ctx.cwd, ".pi", "unbash.json")}\n\nDefault rules:\n${defaultLines}\n\nGlobal rules:\n${userLines}\n\nProject rules:\n${projectLines}\n\nSession rules:\n${sessionLines}`,
          "info"
        );
      } else {
        ctx.ui.notify("Usage: /unbash <allow|toggle|list> [command]", "warning");
      }
    }
  });

  // The core interception hook
  pi.on("tool_call", async (event, ctx) => {
    if (configWarning && ctx.hasUI) {
      ctx.ui.notify(`[pi-unbash] ${configWarning}`, "warning");
      configWarning = undefined;
    }

    if (!isEnabled()) return;
    if (!isToolCallEventType("bash", event)) return;

    const rawCmd = event.input.command;
    if (!rawCmd || rawCmd.trim() === "") return;

    let ast;
    try {
      ast = parseBash(rawCmd);
    } catch (e) {
      if (!ctx.hasUI) {
        return { block: true, reason: "Failed to parse bash AST. Command rejected for safety." };
      }

      pi.events.emit("nudge", { body: "Command needs approval" });
      const confirmed = await ctx.ui.confirm(
        "⚠️ Could Not Parse Command Safely",
        "\nAllow anyway?"
      );

      if (!confirmed) {
        return { block: true, reason: "User denied unparseable command." };
      }

      return;
    }

    if (Array.isArray(ast.errors) && ast.errors.length > 0) {
      if (!ctx.hasUI) {
        return { block: true, reason: "Bash AST contains parse errors. Command rejected for safety." };
      }

      const firstError = ast.errors[0] ?? { message: "unknown parse error", pos: -1 };
      pi.events.emit("nudge", { body: "Command needs approval" });
      const confirmed = await ctx.ui.confirm(
        "⚠️ Command Parsed With Errors",
        `\nFirst error: ${firstError.message} at ${firstError.pos}\n\nAllow anyway?`
      );

      if (!confirmed) {
        return { block: true, reason: "User denied command with parse errors." };
      }

      return;
    }

    const allCommands = extractAllCommandsFromAST(ast, rawCmd);

    if (allCommands.length === 0) return;

    // Load project-level config from ctx.cwd/.pi/unbash.json
    const projectResult = loadProjectConfig(ctx.cwd);
    if (projectResult?.warning && ctx.hasUI) {
      ctx.ui.notify(`[pi-unbash] ${projectResult.warning}`, "warning");
    }

    // If project config explicitly disables unbash, skip interception
    if (projectResult?.config.enabled === false) return;

    const projectRules = projectResult?.config.rules ?? {};

    const effectiveRules = buildEffectiveRules(config.rules, projectRules, sessionRules);

    const commandActions = allCommands.map(cmd => ({ cmd, action: resolveCommandAction(cmd, effectiveRules) }));

    const deniedCommands = commandActions.filter(({ action }) => action === "deny").map(({ cmd }) => cmd);

    if (deniedCommands.length > 0) {
      return {
        block: true,
        reason: `Commands [${deniedCommands.map(c => formatCommand(c, { maxLength: config.commandDisplayMaxLength, argMaxLength: config.commandDisplayArgMaxLength })).join(", ")}] are explicitly denied by policy.`
      };
    }

    const unauthorizedCommands = commandActions.filter(({ action }) => action !== "allow").map(({ cmd }) => cmd);

    if (unauthorizedCommands.length === 0) {
      return;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Commands [${unauthorizedCommands.map(c => formatCommand(c, { maxLength: config.commandDisplayMaxLength, argMaxLength: config.commandDisplayArgMaxLength })).join(", ")}] require UI confirmation.`
      };
    }

    const uniqueBaseNames = Array.from(new Set(unauthorizedCommands.map(getCommandName)));
    const projectConfigPath = path.join(ctx.cwd, ".pi", "unbash.json");
    const globalWritable = isConfigWritable(GLOBAL_CONFIG_PATH);

    const approvalOptions = [
      "Allow (once)",
      `Always allow (this session)`,
      "Allow for this project  \u2192  .pi/unbash.json",
      ...(globalWritable ? ["Allow globally  \u2192  unbash.json"] : []),
      "Reject",
    ];

    pi.events.emit("nudge", { body: "Command needs approval" });
    const choice = await ctx.ui.select(
      buildApprovalPrompt(allCommands, unauthorizedCommands, {
        maxLength: config.commandDisplayMaxLength,
        argMaxLength: config.commandDisplayArgMaxLength,
      }),
      approvalOptions
    );

    if (choice?.startsWith("Always allow (this session)")) {
      for (const name of uniqueBaseNames) {
        sessionRules[name] = "allow";
      }
      return;
    }

    if (choice?.startsWith("Allow for this project")) {
      for (const name of uniqueBaseNames) {
        saveRuleToConfig(projectConfigPath, name, "allow");
        sessionRules[name] = "allow";
      }
      return;
    }

    if (globalWritable && choice?.startsWith("Allow globally")) {
      for (const name of uniqueBaseNames) {
        saveRuleToConfig(GLOBAL_CONFIG_PATH, name, "allow");
        sessionRules[name] = "allow";
      }
      return;
    }

    if (!choice || choice === "Reject" || !choice.startsWith("Allow")) {
      return { block: true, reason: "User denied execution." };
    }
    // "Allow (once)" — fall through, command executes this time only
  });
}
