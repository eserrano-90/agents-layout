export interface ToolInvocation {
  readonly toolId: string;
  readonly toolName: string;
  readonly status: string;
  readonly startedAt: number;
}

export function createToolInvocation(
  toolId: string,
  toolName: string,
  status: string,
  startedAt: number,
): ToolInvocation {
  return { toolId, toolName, status, startedAt };
}
