/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

/** JSON Schema (draft 2020-12 subset) for the body of POST /api/ingest. */
export const INGEST_REQUEST_SCHEMA = {
  $id: 'pixel-agents-ingest-request',
  $ref: '#/$defs/IngestRequest',
  $defs: {
    AgentActivityKind: {
      type: 'string',
      enum: ['reading', 'typing'],
    },
    AgentEvent: {
      oneOf: [
        {
          $ref: '#/$defs/SessionStartEvent',
        },
        {
          $ref: '#/$defs/SessionEndEvent',
        },
        {
          $ref: '#/$defs/SessionReplacedEvent',
        },
        {
          $ref: '#/$defs/ToolStartEvent',
        },
        {
          $ref: '#/$defs/ToolEndEvent',
        },
        {
          $ref: '#/$defs/BackgroundToolEndEvent',
        },
        {
          $ref: '#/$defs/TurnEndEvent',
        },
        {
          $ref: '#/$defs/SubagentStartEvent',
        },
        {
          $ref: '#/$defs/SubagentEndEvent',
        },
        {
          $ref: '#/$defs/SubagentTurnEndEvent',
        },
        {
          $ref: '#/$defs/ProgressEvent',
        },
        {
          $ref: '#/$defs/PermissionRequestEvent',
        },
        {
          $ref: '#/$defs/TextOutputEvent',
        },
        {
          $ref: '#/$defs/UserPromptEvent',
        },
        {
          $ref: '#/$defs/TokenUsageEvent',
        },
        {
          $ref: '#/$defs/ModelInfoEvent',
        },
        {
          $ref: '#/$defs/TeamInfoEvent',
        },
      ],
    },
    BackgroundToolEndEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'toolId'],
      properties: {
        kind: {
          const: 'backgroundToolEnd',
        },
        toolId: {
          type: 'string',
        },
      },
    },
    IngestEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'origin', 'ts', 'event'],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        origin: {
          $ref: '#/$defs/IngestEventOrigin',
        },
        ts: {
          type: 'number',
        },
        event: {
          $ref: '#/$defs/AgentEvent',
        },
      },
    },
    IngestEventOrigin: {
      type: 'string',
      enum: ['hook', 'transcript'],
    },
    IngestRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'clientId', 'seq', 'sentAt', 'events'],
      properties: {
        protocolVersion: {
          type: 'integer',
          minimum: 1,
        },
        clientId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        label: {
          type: 'string',
          maxLength: 128,
        },
        seq: {
          type: 'integer',
          minimum: 1,
        },
        sentAt: {
          type: 'number',
        },
        events: {
          type: 'array',
          maxItems: 512,
          items: {
            $ref: '#/$defs/IngestEvent',
          },
        },
        snapshot: {
          $ref: '#/$defs/IngestSnapshot',
        },
        goodbye: {
          type: 'boolean',
        },
      },
    },
    IngestResponse: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: {
        ok: {
          type: 'boolean',
        },
        appliedSeq: {
          type: 'integer',
        },
        resync: {
          type: 'boolean',
        },
        error: {
          type: 'string',
        },
        eventIndex: {
          type: 'integer',
        },
        supportedVersions: {
          type: 'array',
          items: {
            type: 'integer',
          },
        },
      },
    },
    IngestSnapshot: {
      type: 'object',
      additionalProperties: false,
      required: ['sessions'],
      properties: {
        sessions: {
          type: 'array',
          maxItems: 512,
          items: {
            $ref: '#/$defs/IngestSnapshotSession',
          },
        },
      },
    },
    IngestSnapshotSession: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        folderName: {
          type: 'string',
        },
        cwd: {
          type: 'string',
        },
        transcriptPath: {
          type: 'string',
        },
        hooksOnly: {
          type: 'boolean',
        },
        hookDelivered: {
          type: 'boolean',
        },
        team: {
          $ref: '#/$defs/SessionTeam',
        },
      },
    },
    ModelInfoEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'model'],
      properties: {
        kind: {
          const: 'modelInfo',
        },
        model: {
          type: 'string',
        },
      },
    },
    PermissionRequestEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'permissionRequest',
        },
      },
    },
    ProgressEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'progress',
        },
        toolId: {
          type: 'string',
        },
      },
    },
    SessionEndEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'sessionEnd',
        },
        reason: {
          type: 'string',
        },
      },
    },
    SessionReplacedEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'previousSessionId'],
      properties: {
        kind: {
          const: 'sessionReplaced',
        },
        previousSessionId: {
          type: 'string',
        },
        transcriptPath: {
          type: 'string',
        },
      },
    },
    SessionStartEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'sessionStart',
        },
        source: {
          type: 'string',
        },
        folderName: {
          type: 'string',
        },
        cwd: {
          type: 'string',
        },
        transcriptPath: {
          type: 'string',
        },
        hooksOnly: {
          type: 'boolean',
        },
        team: {
          $ref: '#/$defs/SessionTeam',
        },
      },
    },
    SessionTeam: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamName: {
          type: 'string',
        },
        agentName: {
          type: 'string',
        },
        leadSessionId: {
          type: 'string',
        },
        isTeamLead: {
          type: 'boolean',
        },
        usesTmux: {
          type: 'boolean',
        },
      },
    },
    SubagentEndEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'parentToolId', 'toolId'],
      properties: {
        kind: {
          const: 'subagentEnd',
        },
        parentToolId: {
          type: 'string',
        },
        toolId: {
          type: 'string',
        },
      },
    },
    SubagentStartEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'parentToolId', 'toolId', 'toolName', 'statusText', 'permissionExempt'],
      properties: {
        kind: {
          const: 'subagentStart',
        },
        parentToolId: {
          type: 'string',
        },
        toolId: {
          type: 'string',
        },
        toolName: {
          type: 'string',
        },
        statusText: {
          type: 'string',
          maxLength: 256,
        },
        permissionExempt: {
          type: 'boolean',
        },
        runInBackground: {
          type: 'boolean',
        },
      },
    },
    SubagentTurnEndEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'parentToolId', 'reason'],
      properties: {
        kind: {
          const: 'subagentTurnEnd',
        },
        parentToolId: {
          type: 'string',
        },
        reason: {
          $ref: '#/$defs/SubagentTurnEndReason',
        },
        teammateName: {
          type: 'string',
        },
      },
    },
    SubagentTurnEndReason: {
      type: 'string',
      enum: ['idle', 'completed'],
    },
    TeamInfoEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'team'],
      properties: {
        kind: {
          const: 'teamInfo',
        },
        team: {
          $ref: '#/$defs/SessionTeam',
        },
      },
    },
    TextOutputEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'textOutput',
        },
      },
    },
    TokenUsageEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'inputTokens', 'outputTokens'],
      properties: {
        kind: {
          const: 'tokenUsage',
        },
        inputTokens: {
          type: 'integer',
          minimum: 0,
        },
        outputTokens: {
          type: 'integer',
          minimum: 0,
        },
        model: {
          type: 'string',
        },
      },
    },
    ToolEndEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'toolId'],
      properties: {
        kind: {
          const: 'toolEnd',
        },
        toolId: {
          type: 'string',
        },
        backgroundLaunched: {
          type: 'boolean',
        },
      },
    },
    ToolStartEvent: {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'toolId',
        'toolName',
        'statusText',
        'activity',
        'permissionExempt',
        'spawnsSubagent',
      ],
      properties: {
        kind: {
          const: 'toolStart',
        },
        toolId: {
          type: 'string',
        },
        toolName: {
          type: 'string',
        },
        statusText: {
          type: 'string',
          maxLength: 256,
        },
        activity: {
          $ref: '#/$defs/AgentActivityKind',
        },
        permissionExempt: {
          type: 'boolean',
        },
        spawnsSubagent: {
          type: 'boolean',
        },
        spawnsTeammate: {
          type: 'boolean',
        },
        runInBackground: {
          type: 'boolean',
        },
      },
    },
    TurnEndEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'turnEnd',
        },
        awaitingInput: {
          type: 'boolean',
        },
      },
    },
    UserPromptEvent: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          const: 'userPrompt',
        },
      },
    },
  },
} as const;
