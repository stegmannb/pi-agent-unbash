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

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

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

/** Load project-level unbash config from .pi/settings.json in the given directory. */
function loadProjectConfig(cwd: string): LoadedConfigResult | null {
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(projectSettingsPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(projectSettingsPath, "utf-8");
    const parsed = JSON.parse(data);
    const result = getUnbashConfigFromSettings(parsed);
    return result;
  } catch (e) {
    return {
      config: { ...SAFE_FALLBACK_CONFIG },
      warning: "Failed to parse project .pi/settings.json; using safe fallback.",
    };
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

export function getUnbashConfigFromSettings(input: unknown): LoadedConfigResult {
  if (!input || typeof input !== "object") {
    return { config: DEFAULT_CONFIG };
  }

  const settings = input as Record<string, unknown>;

  if (!Object.hasOwn(settings, "unbash")) {
    return { config: DEFAULT_CONFIG };
  }

  return validateLoadedUnbashConfig(settings.unbash);
}

function loadConfig(): LoadedConfigResult {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(data);
      return getUnbashConfigFromSettings(parsed);
    } catch (e) {
      return {
        config: { ...SAFE_FALLBACK_CONFIG },
        warning: "Failed to parse settings.json; using safe fallback (enabled=true, rules={}).",
      };
    }
  }
  return { config: DEFAULT_CONFIG };
}

function saveConfig(config: UnbashConfig) {
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });

    let settings: any = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }

    // Only save user rules, never the merged effective set
    settings.unbash = {
      enabled: config.enabled,
      rules: config.rules,
      ...(config.commandDisplayMaxLength !== FORMAT_COMMAND_DEFAULT_MAX_LENGTH && { commandDisplayMaxLength: config.commandDisplayMaxLength }),
      ...(config.commandDisplayArgMaxLength !== FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH && { commandDisplayArgMaxLength: config.commandDisplayArgMaxLength }),
    };

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save unbash config to settings.json", e);
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

  if (configWarning) {
    console.warn(`[pi-unbash] ${configWarning}`);
  }

  function setUnbashStatus(ctx: { ui: { setStatus: (key: string, text: string) => void; theme: { fg: (color: string, text: string) => string } } }, enabled: boolean, cfg?: UnbashConfig) {
    if (enabled) {
      const totalRules = Object.keys(DEFAULT_RULES).length + Object.keys(cfg?.rules ?? {}).length;
      ctx.ui.setStatus("unbash", ctx.ui.theme.fg("accent", `🛡️  Unbash: ${totalRules} rules`));
    } else {
      ctx.ui.setStatus("unbash", "");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    setUnbashStatus(ctx, config.enabled, config);
  });

  pi.registerCommand("unbash-enable", {
    description: "Enable pi-unbash command approval",
    handler: async (_args, ctx) => {
      if (config.enabled) {
        ctx.ui.notify("pi-unbash is already enabled", "info");
        return;
      }
      config.enabled = true;
      saveConfig(config);
      setUnbashStatus(ctx, true, config);
      ctx.ui.notify("pi-unbash enabled", "info");
    },
  });

  pi.registerCommand("unbash-disable", {
    description: "Disable pi-unbash command approval",
    handler: async (_args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify("pi-unbash is already disabled", "info");
        return;
      }
      config.enabled = false;
      saveConfig(config);
      setUnbashStatus(ctx, false, config);
      ctx.ui.notify("pi-unbash disabled", "warning");
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
        config.enabled = !config.enabled;
        saveConfig(config);
        ctx.ui.notify(`pi-unbash is now ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
      } else if (action === "list") {
        const defaultLines = Object.entries(DEFAULT_RULES)
          .map(([pattern, act]) => `  ${pattern}: ${act}`)
          .join("\n");

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

        ctx.ui.notify(
          `pi-unbash: ${config.enabled ? "ENABLED" : "DISABLED"}\n\nDefault rules:\n${defaultLines}\n\nUser rules (global):\n${userLines}\n\nProject rules:\n${projectLines}\n\nSession rules:\n${sessionLines}`,
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

    if (!config.enabled) return;
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

    // Load project-level config from ctx.cwd/.pi/settings.json
    const projectResult = loadProjectConfig(ctx.cwd);
    const projectRules = projectResult?.config.rules ?? {};
    if (projectResult?.warning && ctx.hasUI) {
      ctx.ui.notify(`[pi-unbash] ${projectResult.warning}`, "warning");
    }

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
    const alwaysLabel = `Always allow ${uniqueBaseNames.join(", ")} (this session)`;

    pi.events.emit("nudge", { body: "Command needs approval" });
    const choice = await ctx.ui.select(
      buildApprovalPrompt(allCommands, unauthorizedCommands, {
        maxLength: config.commandDisplayMaxLength,
        argMaxLength: config.commandDisplayArgMaxLength,
      }),
      ["Allow", alwaysLabel, "Reject"]
    );

    if (choice === alwaysLabel) {
      for (const name of uniqueBaseNames) {
        sessionRules[name] = "allow";
      }
      return;
    }

    if (choice !== "Allow") {
      return { block: true, reason: "User denied execution." };
    }
  });
}
