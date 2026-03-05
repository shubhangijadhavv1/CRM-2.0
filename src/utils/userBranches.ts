/**
 * Effective branches for a user: branches[] if set and non-empty, else [branch], else [].
 * Used for branch-scoped visibility (admin, team-lead, team).
 */
export function getBranchesForUser(user: { branch?: string; branches?: string[] } | null): string[] {
  if (!user) return [];
  const branches = user.branches;
  if (Array.isArray(branches) && branches.length > 0) return branches.filter(Boolean);
  const single = user.branch?.trim();
  return single ? [single] : [];
}

/** Check if the user has access to the given branch (for task/assignee scope). */
export function userCanAccessBranch(
  me: { branch?: string; branches?: string[] } | null,
  targetBranch: string | undefined
): boolean {
  if (!targetBranch) return true;
  const mine = getBranchesForUser(me);
  return mine.length === 0 || mine.includes(targetBranch);
}
