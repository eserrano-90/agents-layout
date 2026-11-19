# Spec Delta

## Purpose

Defines how the server keeps track of the clients feeding it: which agents belong to which client, how state is reconciled when a client reconnects, and what happens to a client's agents when it goes away.

## ADDED Requirements

### Requirement: Agents are attributed to the client that reported them
The server SHALL identify an agent by the pair of client and session, so sessions from different clients never collide and events from one client cannot affect another client's agents.

#### Scenario: Same session identifier from two clients
- **WHEN** two clients each report a session with the same session identifier
- **THEN** the office shows two separate characters, each updated only by its own client's events

#### Scenario: Cross-client event
- **WHEN** client A sends a tool-start event for a session that only client B has reported
- **THEN** client B's character is unchanged

### Requirement: Clients signal liveness
A client SHALL signal the server at a regular interval while it runs, and the server SHALL treat a client as disconnected when no request has arrived from it within the documented timeout.

#### Scenario: Idle but alive
- **WHEN** a client has no session activity for several minutes but keeps signaling
- **THEN** its agents remain in the office

#### Scenario: Client vanishes
- **WHEN** a client's machine goes offline and the timeout elapses
- **THEN** the server removes that client's agents with the normal despawn effect

### Requirement: Clean shutdown removes agents immediately
When a client shuts down cleanly it SHALL tell the server, and the server SHALL remove that client's agents without waiting for the liveness timeout.

#### Scenario: Client stopped by the user
- **WHEN** the user stops a client with an interrupt signal
- **THEN** its agents leave the office within a second

### Requirement: Reconnect reconciles with a session snapshot
On connecting, and whenever the server asks for it, a client SHALL send a snapshot of its currently live sessions, and the server SHALL make that client's agents match the snapshot.

#### Scenario: Server restarted
- **WHEN** the server restarts while a client has two live sessions
- **THEN** after the client's next snapshot the office shows exactly those two sessions for that client

#### Scenario: Session ended during an outage
- **WHEN** a session ends while the server is unreachable and the client later reconnects
- **THEN** the snapshot omits that session and the server removes its character

#### Scenario: Seat and appearance survive reconciliation
- **WHEN** a session present before a server restart appears again in the client's snapshot
- **THEN** its character keeps the seat and appearance it had before the restart

### Requirement: Restored agents wait for their client
After a restart the server SHALL NOT show persisted agents as live until their client has confirmed them, and SHALL discard persisted agents whose client does not return within the liveness timeout.

#### Scenario: Client never returns
- **WHEN** the server restarts and a previously known client does not reconnect within the timeout
- **THEN** that client's persisted agents are discarded and never appear in the office

### Requirement: The office shows which client an agent belongs to
When more than one client is connected, the office SHALL show each agent's client label alongside its existing label; with a single client the labels SHALL be unchanged from today.

#### Scenario: Two clients connected
- **WHEN** clients labelled "ana-laptop" and "ci-runner" each have an active session
- **THEN** each character's label includes its client's label

#### Scenario: Single client
- **WHEN** only one client is connected
- **THEN** character labels show no client label

### Requirement: Client tokens can be issued and revoked
An operator SHALL be able to issue a token bound to a client label, list issued tokens without revealing their secrets, and revoke a token.

#### Scenario: Issue
- **WHEN** an operator issues a token for the label "ana-laptop"
- **THEN** the token secret is shown once and the server stores only a non-reversible form of it

#### Scenario: Revoke while connected
- **WHEN** an operator revokes the token of a connected client
- **THEN** that client's next request is rejected and its agents are removed once the liveness timeout elapses
