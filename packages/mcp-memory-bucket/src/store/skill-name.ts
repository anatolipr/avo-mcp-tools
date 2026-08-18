// Per the agentskills.io spec: 1-64 chars, lowercase alphanumeric + hyphens,
// no leading/trailing hyphen, no consecutive hyphens.
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_PATTERN.test(name);
}

export function assertValidSkillName(name: string): void {
  if (!isValidSkillName(name)) {
    throw new Error(
      `invalid skill name "${name}": must be 1-64 chars, lowercase letters/numbers/hyphens only, no leading/trailing/consecutive hyphens`
    );
  }
}
