import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLoadedUnbashConfig, buildEffectiveRules } from "../src/index.ts";
import { FORMAT_COMMAND_DEFAULT_MAX_LENGTH, FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH } from "../src/format.ts";
import { DEFAULT_RULES } from "../src/defaults.ts";

const displayDefaults = {
  commandDisplayMaxLength: FORMAT_COMMAND_DEFAULT_MAX_LENGTH,
  commandDisplayArgMaxLength: FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH,
};

test("validateLoadedUnbashConfig", async (t) => {
  await t.test("accepts valid config with rules", () => {
    const result = validateLoadedUnbashConfig({ enabled: false, rules: { "git": "allow", "curl": "ask" } });
    assert.deepEqual(result.config, { enabled: false, rules: { "git": "allow", "curl": "ask" }, ...displayDefaults });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts valid config with empty rules", () => {
    const result = validateLoadedUnbashConfig({ enabled: true, rules: {} });
    assert.deepEqual(result.config, { enabled: true, rules: {}, ...displayDefaults });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts valid config with no rules field", () => {
    const result = validateLoadedUnbashConfig({ enabled: true });
    assert.deepEqual(result.config, { enabled: true, rules: {}, ...displayDefaults });
    assert.equal(result.warning, undefined);
  });

  await t.test("uses safe fallback for invalid top-level shape", () => {
    const result = validateLoadedUnbashConfig("bad");
    assert.deepEqual(result.config, { enabled: true, rules: {}, ...displayDefaults });
    assert.ok(result.warning);
  });

  await t.test("recovers valid enabled when rules is invalid", () => {
    const result = validateLoadedUnbashConfig({ enabled: false, rules: 42 });
    assert.deepEqual(result.config, { enabled: false, rules: {}, ...displayDefaults });
    assert.ok(result.warning?.includes("rules"));
  });

  await t.test("drops invalid rules entries and keeps valid ones", () => {
    const result = validateLoadedUnbashConfig({
      enabled: true,
      rules: { "git": "allow", "curl": "deny", "ls": 123, "": "allow", "rg": "ask" },
    });
    assert.deepEqual(result.config, {
      enabled: true,
      rules: { "git": "allow", "curl": "deny", "rg": "ask" },
      ...displayDefaults,
    });
    assert.ok(result.warning?.includes("rules"));
  });

  await t.test("accepts deny action in rules", () => {
    const result = validateLoadedUnbashConfig({
      enabled: true,
      rules: { "terraform destroy": "deny", "kubectl delete namespace": "deny", "kubectl delete": "ask" },
    });
    assert.deepEqual(result.config, {
      enabled: true,
      rules: { "terraform destroy": "deny", "kubectl delete namespace": "deny", "kubectl delete": "ask" },
      ...displayDefaults,
    });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts custom display settings", () => {
    const result = validateLoadedUnbashConfig({ enabled: true, rules: {}, commandDisplayMaxLength: 80, commandDisplayArgMaxLength: 30 });
    assert.equal(result.config.commandDisplayMaxLength, 80);
    assert.equal(result.config.commandDisplayArgMaxLength, 30);
    assert.equal(result.warning, undefined);
  });

  await t.test("rejects invalid display settings", () => {
    const result = validateLoadedUnbashConfig({ enabled: true, rules: {}, commandDisplayMaxLength: "big", commandDisplayArgMaxLength: -1 });
    assert.equal(result.config.commandDisplayMaxLength, FORMAT_COMMAND_DEFAULT_MAX_LENGTH);
    assert.equal(result.config.commandDisplayArgMaxLength, FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH);
    assert.ok(result.warning);
  });
});

test("DEFAULT_RULES", async (t) => {
  await t.test("all values are allow, ask, or deny", () => {
    for (const [pattern, action] of Object.entries(DEFAULT_RULES)) {
      assert.ok(
        action === "allow" || action === "ask" || action === "deny",
        `DEFAULT_RULES["${pattern}"] has invalid action "${action}"`,
      );
    }
  });

  await t.test("all patterns are non-empty strings", () => {
    for (const pattern of Object.keys(DEFAULT_RULES)) {
      assert.ok(pattern.trim().length > 0, `DEFAULT_RULES has empty pattern`);
    }
  });
});

test("buildEffectiveRules", async (t) => {
  await t.test("defaults alone when user, project, and session rules are empty", () => {
    const result = buildEffectiveRules({}, {}, {});
    assert.deepEqual(result, DEFAULT_RULES);
  });

  await t.test("user rules are appended after defaults", () => {
    const result = buildEffectiveRules({ "mytool": "allow" }, {}, {});
    assert.equal(result["mytool"], "allow");
    assert.equal(result["cat"], "allow");
  });

  await t.test("user rules override defaults for the same pattern", () => {
    const result = buildEffectiveRules({ "cat": "ask" }, {}, {});
    assert.equal(result["cat"], "ask");
  });

  await t.test("project rules are appended after user rules", () => {
    const result = buildEffectiveRules({}, { "docker": "allow" }, {});
    assert.equal(result["docker"], "allow");
  });

  await t.test("project rules override user rules for the same pattern", () => {
    const result = buildEffectiveRules({ "npm": "ask" }, { "npm": "allow" }, {});
    assert.equal(result["npm"], "allow");
  });

  await t.test("session rules are appended after project rules", () => {
    const result = buildEffectiveRules({}, {}, { "kubectl": "allow" });
    assert.equal(result["kubectl"], "allow");
  });

  await t.test("session rules override project rules for the same pattern", () => {
    const result = buildEffectiveRules({}, { "npm": "ask" }, { "npm": "allow" });
    assert.equal(result["npm"], "allow");
  });

  await t.test("session rules override user rules for the same pattern", () => {
    const result = buildEffectiveRules({ "npm": "ask" }, {}, { "npm": "allow" });
    assert.equal(result["npm"], "allow");
  });

  await t.test("session rules override defaults for the same pattern", () => {
    const result = buildEffectiveRules({}, {}, { "cat": "ask" });
    assert.equal(result["cat"], "ask");
  });

  await t.test("all four layers merge in order (defaults < user < project < session)", () => {
    const result = buildEffectiveRules({ "git": "ask" }, { "git": "allow" }, {});
    assert.equal(result["git"], "allow");
  });

  await t.test("project and session both override user", () => {
    const result = buildEffectiveRules({ "git": "ask" }, { "git": "allow" }, { "curl": "allow" });
    assert.equal(result["git"], "allow");
    assert.equal(result["curl"], "allow");
  });

  await t.test("deny from user layer cannot be overridden by project allow", () => {
    const result = buildEffectiveRules({ "rm": "deny" }, { "rm": "allow" }, {});
    assert.equal(result["rm"], "deny");
  });

  await t.test("deny from user layer cannot be overridden by session allow", () => {
    const result = buildEffectiveRules({ "rm": "deny" }, {}, { "rm": "allow" });
    assert.equal(result["rm"], "deny");
  });

  await t.test("deny from project layer cannot be overridden by session allow", () => {
    const result = buildEffectiveRules({}, { "terraform destroy": "deny" }, { "terraform destroy": "allow" });
    assert.equal(result["terraform destroy"], "deny");
  });

  await t.test("deny from any layer beats allow from all other layers", () => {
    const result = buildEffectiveRules({ "kubectl delete": "allow" }, { "kubectl delete": "allow" }, { "kubectl delete": "deny" });
    assert.equal(result["kubectl delete"], "deny");
  });
});
