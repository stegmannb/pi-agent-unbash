import type { RuleAction } from "./types.ts";

export const DEFAULT_RULES: Record<string, RuleAction> = {
  // Basic read-only utilities
  "cat": "allow",
  "cd": "allow",
  "echo": "allow",
  "find": "allow",
  "grep": "allow",
  "head": "allow",
  "ls": "allow",
  "pwd": "allow",
  "rg": "allow",
  "sort": "allow",
  "tail": "allow",
  "true": "allow",
  "uniq": "allow",
  "wc": "allow",
  // Path utilities
  "basename": "allow",
  "dirname": "allow",
  "realpath": "allow",
  // System info
  "date": "allow",
  "file": "allow",
  "stat": "allow",
  "uname": "allow",
  "whoami": "allow",
  // Tool discovery
  "type": "allow",
  "which": "allow",
  // Read-only git
  "git blame": "allow",
  "git branch --show-current": "allow",
  "git diff": "allow",
  "git log": "allow",
  "git show": "allow",
  "git status": "allow",
};
