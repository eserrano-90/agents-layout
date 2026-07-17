export interface Session {
  readonly sessionId: string;
  readonly projectDir?: string;
  readonly jsonlFile?: string;
  readonly startedAt: number;
  agentId?: number;
  transcriptPath?: string;
}

export function createSession(
  sessionId: string,
  opts?: { projectDir?: string; jsonlFile?: string; agentId?: number },
): Session {
  return {
    sessionId,
    projectDir: opts?.projectDir,
    jsonlFile: opts?.jsonlFile,
    startedAt: Date.now(),
    agentId: opts?.agentId,
  };
}
