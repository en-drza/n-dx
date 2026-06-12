/**
 * Antigravity integration — auto-configures skills when `ndx init`
 * is run.
 *
 * This module is called by cli.js during init (unless --no-antigravity is passed).
 * It writes:
 *   1. `ANTIGRAVITY.md` — project instructions generated from the assistant asset layer
 *   2. `.gemini/antigravity/skills/` — workflow skill files (overwritten on each init)
 *
 * Skill content is sourced from `assistant-assets/` — the vendor-neutral
 * canonical location.  Skill writing is delegated to the shared
 * `writeVendorSkills()` function.
 *
 * @module n-dx/antigravity-integration
 */

import { join, resolve } from "path";
import { writeFileSync } from "fs";
import {
  getSkillNames,
  writeVendorSkills,
  renderAntigravityMd,
} from "./assistant-assets.js";

// ── ANTIGRAVITY.md writing ───────────────────────────────────────────────────────────

/**
 * Write `ANTIGRAVITY.md` to the project root.
 *
 * The content is generated from the shared assistant asset layer so that it
 * stays in sync with the manifest's skill and MCP definitions automatically.
 *
 * @param {string} dir  Absolute project root directory
 * @returns {{ written: boolean, path: string }}
 */
function writeAntigravityMd(dir) {
  const agentsPath = join(dir, "ANTIGRAVITY.md");
  const content = renderAntigravityMd();
  writeFileSync(agentsPath, content);
  return { written: true, path: agentsPath };
}

// ── Skill writing ──────────────────────────────────────────────────────────────

/**
 * Write all skill files via the canonical vendor-neutral writer.
 */
function writeSkills(dir) {
  return writeVendorSkills("antigravity", dir);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full Antigravity integration setup.
 *
 * @param {string} dir  Project root directory
 * @returns {{ skills: object, agents: object }}
 */
export function setupAntigravityIntegration(dir) {
  const absDir = resolve(dir);

  const skills = writeSkills(absDir);
  const agents = writeAntigravityMd(absDir);

  return { skills, agents };
}
