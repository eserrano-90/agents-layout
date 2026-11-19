export interface Session {
  readonly sessionId: string;
  readonly projectDir?: string;
  readonly startedAt: number;
  agentId?: number;
  transcriptPath?: string;
}

export function createSession(
  sessionId: string,
  opts?: { projectDir?: string; transcriptPath?: string; agentId?: number },
): Session {
  return {
    sessionId,
    projectDir: opts?.projectDir,
    transcriptPath: opts?.transcriptPath,
    startedAt: Date.now(),
    agentId: opts?.agentId,
  };
}
