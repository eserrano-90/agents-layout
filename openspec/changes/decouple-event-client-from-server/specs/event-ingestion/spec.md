# Spec Delta

## Purpose

Defines how the server accepts normalized agent events from emitting clients and turns them into office state, without depending on the emitting machine's filesystem or on any specific agent tool.

## ADDED Requirements

### Requirement: Ingest endpoint accepts normalized event batches
The server SHALL expose an ingest endpoint that accepts a batch of normalized agent events from a client and applies them to agent state in the order given within the batch.

#### Scenario: Valid batch is applied
- **WHEN** an authenticated client sends a batch containing a session start followed by a tool start for the same session
- **THEN** the server creates an agent for that session and shows it as active with the tool's status text

#### Scenario: Empty batch is accepted
- **WHEN** an authenticated client sends a batch with no events
- **THEN** the server responds with success and changes no agent state

### Requirement: Ingest requests are authenticated per client
The server SHALL accept ingest requests only when they carry a token that is registered for a client, and SHALL attribute every accepted event to the client that owns that token.

#### Scenario: Missing or unknown token
- **WHEN** an ingest request arrives without a token or with a token that is not registered
- **THEN** the server rejects it as unauthorized and changes no agent state

#### Scenario: Token decides the client identity
- **WHEN** a request authenticated with client A's token declares client B's identity in its body
- **THEN** the server rejects the request and changes no agent state

#### Scenario: Revoked token
- **WHEN** a client's token is revoked and that client sends another batch
- **THEN** the server rejects it as unauthorized

### Requirement: Ingest payloads are validated against the published contract
The server SHALL validate every ingest request against the published ingest contract and SHALL reject requests that do not conform, without applying any event from the rejected request.

#### Scenario: Malformed event
- **WHEN** a batch contains an event with an unknown kind or a missing required field
- **THEN** the server rejects the whole batch with a client error that names the offending event index

#### Scenario: Oversized request
- **WHEN** a request body exceeds the documented size limit
- **THEN** the server rejects it and changes no agent state

### Requirement: Ingest contract is versioned
Every ingest request SHALL declare the contract version it was built for, and the server SHALL reject versions it does not support with an error that states the supported versions.

#### Scenario: Unsupported version
- **WHEN** a client sends a batch declaring a contract version the server does not support
- **THEN** the server rejects it and the response lists the versions it supports

### Requirement: Duplicate and out-of-order batches do not corrupt state
The server SHALL ignore a batch it has already applied from the same client and SHALL apply batches from one client in the sequence the client assigned.

#### Scenario: Retried batch
- **WHEN** a client resends a batch the server already applied because the first response was lost
- **THEN** the server responds with success and does not apply the events a second time

#### Scenario: Gap in sequence
- **WHEN** a client's batch arrives with a sequence number that skips ahead of the last applied one
- **THEN** the server responds asking that client for a full session snapshot and does not apply the batch

### Requirement: Server state derives only from ingested events
The server SHALL build and update agent state exclusively from ingested events and browser messages, and SHALL NOT read transcripts, team configuration, or agent-tool settings from its own filesystem.

#### Scenario: Server on a machine with no agent tool installed
- **WHEN** the server runs with a home directory that contains no agent-tool data and a remote client sends events for an active session
- **THEN** the office shows that session's character with its status text, tool activity, token usage and model

#### Scenario: Paths in events are opaque
- **WHEN** an event carries a working-directory or transcript path that does not exist on the server's machine
- **THEN** the server uses it only as a label and does not attempt to open it

### Requirement: Status and activity come from the event
The server SHALL display the status text and choose the reading or typing animation from fields carried by the event, and SHALL NOT need to know tool names of any specific agent tool.

#### Scenario: Unknown tool name
- **WHEN** a tool-start event names a tool the server has never seen, with status text "Indexing repo" and activity "reading"
- **THEN** the character shows "Indexing repo" and plays the reading animation

### Requirement: Token usage, model and team membership arrive as events
The server SHALL update an agent's token totals, model name and team membership from dedicated events, and SHALL feed token usage events into the daily usage totals.

#### Scenario: Token usage event
- **WHEN** a token-usage event reports 1,200 input and 300 output tokens for a session
- **THEN** that agent's totals increase by those amounts and the daily usage total reflects them

#### Scenario: Teammate session
- **WHEN** a session-start event declares a team name, a teammate name and the lead's session
- **THEN** the server shows that agent as a teammate linked to the lead's character

### Requirement: Session replacement keeps the same character
When a client reports that a session was replaced by a new one (for example after a clear), the server SHALL keep the existing character, seat and appearance and continue it under the new session.

#### Scenario: Clear in a tracked session
- **WHEN** a client sends a session-replaced event naming an existing session and its successor
- **THEN** the same character remains at the same seat, its tool activity is cleared, and later events for the successor session apply to it

### Requirement: Rejected or failing ingest never crashes the server
The server SHALL keep serving browsers and other clients when an ingest request is rejected or fails while being applied.

#### Scenario: One client sends garbage
- **WHEN** one client repeatedly sends invalid batches while another sends valid ones
- **THEN** the valid client's agents keep updating and connected browsers stay connected
