export interface AgentTeam {
  readonly teamName: string;
  readonly leadSessionId: string;
  readonly members: string[];
  readonly usesTmux?: boolean;
}

export function createAgentTeam(
  teamName: string,
  leadSessionId: string,
  members: string[] = [],
  usesTmux?: boolean,
): AgentTeam {
  return { teamName, leadSessionId, members, usesTmux };
}
