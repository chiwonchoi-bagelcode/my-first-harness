import { readdir, readFile } from "node:fs/promises";

export async function loadSkills(skillManager: any) {
  const skillNames = await readdir(".my-first-harness/skills");

  for (const skillName of skillNames) {
    const instructions = await readFile(
      `.my-first-harness/skills/${skillName}/SKILL.md`,
      "utf8",
    );

    skillManager.register({
      name: skillName,
      instructions,
    });
  }
}
