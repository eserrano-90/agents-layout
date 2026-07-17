# Data Model: Server Hexagonal Refactor

## Domain Entities

### Agent

The central domain entity. Represents an AI agent session tracked in the office.

```
Agent {
  id: number
  sessionId: string
  status: AgentStatus
  projectDir: string
  folderName?: string
  
  // Tool tracking
  activeTools: Map<ToolId, ToolInvocation>
  backgroundToolIds: Set<ToolId>       // run_in_background tools
  activeSubagents: Map<ToolId, SubagentSet>  // parent tool → child tools
  
  // Permissions
  isWaiting: boolean
  permissionSent: boolean
  pendingClear: boolean
  
  // Hook correlation
  hookDelivered: boolean
  hooksOnly: boolean                    // no transcript file
  currentHookToolId?: ToolId
  currentHookToolName?: string
  
  // Token usage
  inputTokens: number
  outputTokens: number
  model?: string
  
  // Team membership
  teamName?: string
  agentName?: string
  isTeamLead?: boolean
  leadAgentId?: number
  teamUsesTmux?: boolean
  
  // Transcript tracking
  lastDataAt: EpochMs
  linesProcessed: number
  
  // Diagnostics
  providerId: string
}
```

#### State Transitions

```
                  ┌──────────┐
                  │  IDLE    │ ◄────────────────────────┐
                  └────┬─────┘                          │
                       │ toolStart / JSONL tool_use     │
                       ▼                                │
                  ┌──────────┐     turnEnd /             │
           ┌─────►│ WORKING  │ ─── turn_duration ────────┘
           │      └────┬─────┘
           │           │ permission timer expires
           │           ▼
           │      ┌────────────┐
           │      │ PERMISSION │
           │      └─────┬──────┘
           │            │ data resumes / permission granted
           │            ▼
           │       ┌──────────┐
           └───────│ WORKING  │
                   └──────────┘
```

### AgentStatus

Value object describing agent visibility in the office.

```
AgentStatus = 'idle' | 'working' | 'waiting' | 'permissionRequested'
```

### ToolInvocation

Value object tracking a single tool call.

```
ToolInvocation {
  toolId: string
  toolName: string
  status: string          // display text (e.g. "Reading foo.ts")
  startTime: EpochMs
  isBackground: boolean
  isSubagentSpawn: boolean
}
```

### HookEvent

Canonical normalized event from any CLI provider's hook system.

```
HookEvent {
  kind: 'sessionStart' | 'sessionEnd' | 'toolStart' | 'toolEnd'
      | 'subagentStart' | 'subagentEnd' | 'subagentTurnEnd'
      | 'permissionRequest' | 'progress' | 'turnEnd'
  sessionId: string
  providerId: string
  timestamp: EpochMs
  
  // Kind-specific fields
  toolName?: string
  toolInput?: Record<string, unknown>
  source?: string          // 'clear' | 'resume' | 'unknown'
  reason?: string          // 'completed' | 'exit' | 'logout'
  transcriptPath?: string
  cwd?: string
  awaitingInput?: boolean
}
```

### Session

Maps an external CLI session to an agent identity.

```
Session {
  sessionId: string
  agentId: number
  transcriptPath?: string   // undefined for hooks-only providers
  projectDir?: string
  createdAt: EpochMs
}
```

### AgentTeam

Team membership for Agent Teams feature.

```
AgentTeam {
  teamName: string
  members: Array<{
    agentId: number
    agentName?: string
    role: 'lead' | 'teammate'
    usesTmux: boolean
  }>
}
```

---

## Application Service Data Flow

### HookEvent → Agent lifecycle

```
Hook HTTP POST
    │
    ▼
HookRoutingService.route(providerId, rawEvent)
    │
    ├─► HookProvider.normalizeHookEvent(rawEvent) → AgentEvent | null
    │
    ▼
switch (event.kind) {
    sessionStart  → SessionManagementService.startSession()
    sessionEnd    → SessionManagementService.endSession()
    toolStart     → AgentLifecycleService.onToolStart()
    toolEnd       → AgentLifecycleService.onToolEnd()
    subagentStart → AgentLifecycleService.onSubagentStart()
    subagentEnd   → AgentLifecycleService.onSubagentEnd()
    permissionRequest → AgentLifecycleService.onPermissionRequest()
    turnEnd       → AgentLifecycleService.onTurnEnd()
}
    │
    ▼
BroadcastService.emit(message)
```

### JSONL Transcript → Agent state

```
FileWatcher.poll(agentId)
    │
    ▼
TranscriptProcessingService.processLine(line, agentId)
    │
    ├─► JSON.parse(line)
    ├─► extract team metadata → AgentLifecycleService.updateTeam()
    ├─► extract token usage  → DailyUsageTracker.record()
    ├─► extract tool_use     → AgentLifecycleService.onToolStart()
    ├─► extract tool_result  → AgentLifecycleService.onToolEnd()
    ├─► extract turn_duration → AgentLifecycleService.onTurnEnd()
    ▼
BroadcastService.emit(message)
```

### File scanning → Agent creation

```
FileScanningService.scanProject(projectDir)
    │
    ├─► FileWatcher.listFiles(pattern)
    ├─► DismissalTracker.isDismissed(file)
    │
    ▼
AgentLifecycleService.createExternalAgent(params)
    │
    ├─► AgentPersistence.save(agent)
    ├─► FileWatcher.watch(file, callback)
    ▼
BroadcastService.emit(agentCreated)
```

---

## Infrastructure Adapters and Their Managed State

### ScannerInfrastructure (replaces 5 Maps + 2 Sets currently in AgentRuntime)

```
ScannerInfrastructure {
  // Active file watchers
  fileWatchers: Map<AgentId, FileWatcherHandle>
  pollingTimers: Map<AgentId, TimerHandle>
  jsonlPollTimers: Map<AgentId, TimerHandle>
  
  // Timer Maps
  waitingTimers: Map<AgentId, TimerHandle>
  permissionTimers: Map<AgentId, TimerHandle>
  
  // Known files
  knownJsonlFiles: Set<string>
  
  // Scanner timers
  projectScanner: TimerHandle | null
  externalScanner: TimerHandle | null
  staleChecker: TimerHandle | null
  
  // Configuration refs
  watchAllSessions: boolean
  hooksEnabled: boolean
}
```

This single object replaces 15+ individual Map/Set refs and is injected into any service that needs file watching or timer capabilities.
