import type { Command } from "unbash";

/** The action assigned to a matched command rule. */
export type RuleAction = "allow" | "ask" | "deny";

/** A concrete command node together with the source string its positions refer to. */
export interface CommandRef {
  node: Command;
  source: string;
}
