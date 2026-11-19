/**
 * TeamProvider: optional extension on the client's HookProvider for CLIs that support the
 * Lead + Teammates pattern (Claude Agent Teams today; hypothetical future CLIs).
 *
 * Semantic-level interface: the host asks *what* (who's on this team? what
 * metadata does this session have?) rather than *how* (what's the sidecar file
 * path? what's the JSON field name?). Providers choose their own storage
 * (filesystem, API, database) and expose only the queries.
 *
 * Providers without team support simply don't set `HookProvider.team`. No team-
 * gated code runs for them -- no stubs, no dead branches.
 */
export interface TeamProvider {
  /** CLI identifier (e.g. 'claude', 'codex'). Used for logging. */
  providerId: string;

  /** Find all teammate transcripts belonging to a given lead session.
   *  Provider chooses how to discover them (filesystem scan, API call, cache).
   *  The returned `jsonlPath` is an opaque transcript handle the caller hands
   *  back to adoption code; the `teammateName` identifies which team member it is. */
  discoverTeammates(
    projectDir: string,
    leadSessionId: string,
  ): Array<{ jsonlPath: string; teammateName: string }>;

  /** Get the currently-active member names of a team. Source of truth for team membership.
   *  Returns the Set of names, or null if the team can't be read (team dissolved / no data).
   *
   *  Claude reads `~/.claude/teams/<teamName>/config.json`'s `members[].name` array.
   *  Providers using API-driven team stores implement without a file path. */
  getTeamMembers(teamName: string): Set<string> | null;
}
