# Spec Delta

## Purpose

Defines the client that runs next to the agent tool, observes sessions on the developer's machine, and delivers them to a configured server as normalized events. The client renders nothing.

## ADDED Requirements

### Requirement: Client is configured with a server address and token
The client SHALL send events to the server address and token given by command-line options, environment variables or its configuration file, in that order of precedence, and SHALL refuse to start when no server address can be resolved.

#### Scenario: Address from environment
- **WHEN** the client starts with `PIXEL_AGENTS_URL` and `PIXEL_AGENTS_TOKEN` set and no command-line options
- **THEN** it delivers events to that address using that token

#### Scenario: Command line overrides environment
- **WHEN** both an environment address and a `--server` option are present
- **THEN** the client uses the `--server` value

#### Scenario: Nothing configured
- **WHEN** the client is started in client-only mode with no server address from any source
- **THEN** it exits with a non-zero status and a message naming the missing setting

### Requirement: Client receives hook events locally
The client SHALL accept hook events from the agent tool's hook script on a loopback-only endpoint, and the hook script SHALL return to the agent tool without waiting for delivery to the remote server.

#### Scenario: Hook fires while the server is unreachable
- **WHEN** the agent tool fires a hook and the remote server cannot be reached
- **THEN** the hook script exits successfully within its normal time budget and the event is queued by the client

#### Scenario: Hook endpoint is not reachable from other machines
- **WHEN** another machine attempts to post to the client's hook endpoint
- **THEN** the connection is refused

### Requirement: Client normalizes tool-specific data before sending
The client SHALL translate hook payloads and transcript records into the normalized event set, including display status text and activity kind, so that no tool-specific payload is required by the server.

#### Scenario: Tool start
- **WHEN** the agent tool starts reading a file
- **THEN** the client emits a tool-start event carrying the tool name, a human-readable status such as "Reading main.ts", and activity "reading"

#### Scenario: Unrecognized hook event
- **WHEN** the agent tool fires a hook event the client does not map
- **THEN** the client emits nothing for it and continues running

### Requirement: Client derives transcript-only information
The client SHALL watch session transcripts on its own machine and emit events for information that hooks do not provide: token usage, model, turn completion, sub-agent tool activity, and team metadata.

#### Scenario: Token usage appears in the transcript
- **WHEN** a transcript record reports usage for an assistant message
- **THEN** the client emits a token-usage event with the input and output token counts of that record

#### Scenario: Partial line
- **WHEN** a transcript line is only partly written at the moment the client reads it
- **THEN** the client emits nothing for it until the line is complete and then emits it exactly once

### Requirement: Client discovers sessions without hooks
When hooks are not installed or not delivering, the client SHALL discover active sessions from transcripts and emit the same event kinds as in hook mode, so the server needs no separate mode.

#### Scenario: Hooks disabled
- **WHEN** hooks are disabled and a new session starts in the watched project
- **THEN** the client emits a session-start event followed by tool and turn events derived from the transcript

#### Scenario: Watch scope
- **WHEN** "watch all sessions" is off and a session starts in a different project
- **THEN** the client emits nothing for that session

### Requirement: Client reports session replacement and end
The client SHALL detect when a session is replaced by a new one and when a session ends or goes stale, and SHALL report each as an event.

#### Scenario: Clear
- **WHEN** the user clears a session and the agent tool starts a new transcript for it
- **THEN** the client emits one session-replaced event linking the old session to the new one

#### Scenario: Stale session
- **WHEN** a discovered session produces no data for longer than the stale threshold
- **THEN** the client emits a session-end event for it

### Requirement: Client reports team membership
The client SHALL detect teammates of a lead session and emit them as sessions that name their team, their teammate name and the lead session, and SHALL end them when they leave the team.

#### Scenario: Inline teammate spawned
- **WHEN** a lead session with a team spawns a background teammate
- **THEN** the client emits a session-start event for the teammate that references the lead session and team name

#### Scenario: Teammate removed from the team
- **WHEN** the team's membership no longer lists a teammate
- **THEN** the client emits a session-end event for that teammate

### Requirement: Client manages hook installation on its own machine
Installing and removing the agent tool's hooks SHALL be performed only by the client, on the machine where the client runs.

#### Scenario: Enable hooks
- **WHEN** hooks are enabled for a client
- **THEN** that client registers its hook script in the local agent-tool settings and no other machine's settings change

#### Scenario: Client stops
- **WHEN** a client shuts down cleanly
- **THEN** hook invocations that follow exit successfully without delaying the agent tool

### Requirement: Delivery survives outages within a bounded buffer
The client SHALL queue events while the server is unreachable, retry with backoff, deliver queued events in order on recovery, and bound the queue so memory use stays limited.

#### Scenario: Short outage
- **WHEN** the server is unreachable for a few seconds and then recovers
- **THEN** all events from the outage are delivered in their original order

#### Scenario: Queue overflow
- **WHEN** the outage outlasts the queue limit
- **THEN** the client drops the oldest events and, on recovery, sends a full session snapshot before resuming

### Requirement: Client limits what leaves the machine
The client SHALL send only the fields defined by the ingest contract and SHALL NOT send raw tool inputs, tool outputs, prompt text or transcript content.

#### Scenario: Shell command with a secret
- **WHEN** the agent tool runs a shell command whose arguments contain a secret
- **THEN** the emitted event carries only the truncated status text the office displays and no separate copy of the command or its output

### Requirement: Client failures never disturb the agent tool
Errors in the client or in delivery SHALL NOT cause the agent tool's hooks to fail, block or print output.

#### Scenario: Rejected token
- **WHEN** the server rejects the client's token
- **THEN** the client logs the rejection, keeps running, and hook invocations still exit successfully
