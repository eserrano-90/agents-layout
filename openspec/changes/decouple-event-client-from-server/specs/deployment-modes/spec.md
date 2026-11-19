# Spec Delta

## Purpose

Defines the ways Pixel Agents can be run — all-in-one on a single machine, as a server only, or as a client only — and what each mode starts, exposes and guarantees.

## ADDED Requirements

### Requirement: All-in-one mode preserves today's behavior
Running the command with no mode SHALL start a server and a co-located client in one process, wired together automatically, with no token or address configuration required from the user.

#### Scenario: Zero-configuration start
- **WHEN** a user runs the command with no arguments on a machine with the agent tool
- **THEN** the office is served on the default port and sessions on that machine appear as characters, as before this change

#### Scenario: Existing options
- **WHEN** a user runs the command with `--port` and `--host`
- **THEN** both options behave as before this change

### Requirement: Server-only mode
The `server` mode SHALL start ingestion, state, browser channel and the office UI, and SHALL NOT observe agent sessions, install hooks or read agent-tool data on its own machine.

#### Scenario: Agent tool running on the server's machine
- **WHEN** server-only mode runs on a machine where an agent session is also active and no client is running there
- **THEN** no character appears for that session and the local agent-tool settings are not modified

#### Scenario: Remote client connects
- **WHEN** a client on another machine sends events with a valid token
- **THEN** its sessions appear in the office served by this server

### Requirement: Client-only mode
The `client` mode SHALL start only the emitter, SHALL serve no office UI, and SHALL deliver to the configured server.

#### Scenario: No UI port
- **WHEN** client-only mode is running
- **THEN** requesting the office page from that process fails and only the loopback hook endpoint is listening

#### Scenario: Server unreachable at start
- **WHEN** client-only mode starts and the server cannot be reached
- **THEN** the client keeps running, retries, and delivers once the server is reachable

### Requirement: Client-only settings are shown only when a co-located client exists
The office UI SHALL offer the hooks and watch-all-sessions toggles only when the server has a co-located client, and those toggles SHALL act on that client alone.

#### Scenario: All-in-one mode
- **WHEN** a user turns hooks off in the settings of an all-in-one instance
- **THEN** hooks are uninstalled on that machine, as before this change

#### Scenario: Server-only mode
- **WHEN** a user opens settings on a server-only instance
- **THEN** the hooks and watch-all-sessions toggles are not shown

### Requirement: Network exposure is explicit
The server SHALL listen on loopback unless a host is given explicitly, and SHALL print a warning naming the unauthenticated surfaces when it is bound to a non-loopback address.

#### Scenario: Default bind
- **WHEN** the server starts with no host option
- **THEN** it is reachable only from the same machine

#### Scenario: Bound to all interfaces
- **WHEN** the server starts with a non-loopback host
- **THEN** startup output warns that the office UI is reachable without authentication

### Requirement: Client and server are independently replaceable
A client and a server SHALL interoperate whenever they share a supported ingest contract version, regardless of package version, and a third party SHALL be able to build a conforming client from the published contract alone.

#### Scenario: Newer server, older client
- **WHEN** a server that supports contract versions 1 and 2 receives events from a client built for version 1
- **THEN** the client's sessions appear in the office

#### Scenario: Third-party emitter
- **WHEN** a program that is not the bundled client posts contract-conforming batches with a valid token
- **THEN** its sessions appear in the office
