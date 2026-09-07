import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";

export async function loadSkills(skillManager: any, paths: HarnessPaths) {
  const skills = new Map<string, string>();

  // Load project skills last so they override user skills with the same name.
  for (const directory of [paths.userSkillsDirectory, paths.projectSkillsDirectory]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const instructions = await readFile(join(directory, entry.name, "SKILL.md"), "utf8");
      skills.set(entry.name, instructions);
    }
  }

  for (const [name, instructions] of skills) {
    skillManager.register({ name, instructions });
  }
}
