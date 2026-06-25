# AgentBridge v2 Architecture Design

> Reconstructed from the Claude + Codex architecture discussion on 2026-03-22, then updated with the follow-up review.

## 1. Current Problems

### Architecture problems

- The current daemon uses a single logical Claude attachment, so a newer Claude connection replaces the older one.
- There is no room or session isolation model, so all traffic is routed through one global path.
- Routing is effectively one-to-one and global rather than scoped to a room, session, or explicit target.
- Daemon responsibilities are overloaded: message routing, Codex lifecycle management, TUI or proxy management, and bridge state all live in the same process boundary.
- The current structure does not scale cleanly to multiple agent types or multiple concurrent agent pairs.

### Known limitations in the current implementation

- Only `agentMessage` is forwarded today.
- Intermediate runtime events such as `commandExecution`, `fileChange`, and similar low-level events are not forwarded.
- Only one active Codex thread is supported.
- Only one Claude foreground connection is supported, and a newer connection replaces the older one.
- The current reply flow assumes a single implicit destination rather than explicit room-based or agent-based routing.

### v2 goals derived from the roadmap

- Room-aware and multi-agent filtering that extends the lightweight v1 single-bridge filtering model into a formal multi-agent system.
- Third-agent integration such as Gemini.
- Explicit addressing with `@codex:` / `@claude:` style targeting.
- Policy-backed coordination that prevents uncontrolled back-and-forth loops across rooms and agents.
- Multi-session support for multiple Claude and Codex instances at the same time.
- Multi-agent collaboration patterns that build on top of v1 role-aware collaboration and become formalized within the v2 routing and policy model.

## 2. Core Change

The current daemon is both a message router and a runtime manager. That coupling is the structural reason the system does not scale cleanly to multiple agents, multiple rooms, or multiple concurrent sessions. In v2, the daemon becomes a pure message router.

Its responsibility is reduced to three things:

- Agent registration and authentication
- Room and assignment-state management
- Message and lifecycle-event routing

Everything else moves out of the daemon boundary:

- Agent runtime lifecycle management moves to adapters or external supervisors.
- Runtime-specific concerns such as Codex app-server management and TUI proxy management move out of the daemon.
- Pairing logic, semantic routing, and turn coordination belong to the policy layer rather than the core router.

The guiding principle is to keep the daemon minimal, generic, and agent-agnostic. New agent types should be added by implementing adapters, not by expanding daemon-specific logic. The daemon manages communication topology, not agent runtime internals.

The next chapter shows the resulting high-level architecture.

## 3. Architecture Overview

```text
┌────────────────────────────────────────────────────────────┐
│                     AgentBridge Daemon                     │
│                    (Pure Message Router)                   │
│                                                            │
│  Agent Registry              Room Manager                  │
│  ┌──────────────────┐        ┌──────────────────────────┐  │
│  │ ag-1: claude     │        │ room-A: [ag-1, ag-2]     │  │
│  │ ag-2: codex      │        │ room-B: [ag-3, ag-4]     │  │
│  │ ag-3: claude     │        └──────────────────────────┘  │
│  │ ag-4: codex      │        Unassigned state: [ag-5]      │
│  │ ag-5: gemini     │        assignmentState=unassigned     │
│  └──────────────────┘                                       │
│                                                            │
│  Control WS :4502      Management API :4503                │
└──────────┬──────────────┬──────────────┬──────────────┬─────┘
           │              │              │              │
      ┌────▼────┐    ┌────▼─────┐   ┌────▼────┐   ┌────▼─────┐
      │bridge.ts│    │codex-    │   │bridge.ts│   │gemini-   │
      │(Claude) │    │adapter   │   │(Claude) │   │adapter   │
      │ ag-1    │    │ ag-2     │   │ ag-3    │   │ ag-5     │
      └────┬────┘    └────┬─────┘   └────┬────┘   └────┬─────┘
           │              │              │              │
      Claude #1      Codex #1       Claude #2       Gemini #1
```

The high-level architecture consists of a pure-routing daemon, a registry of connected agents, a room manager, and a set of runtime-specific adapters.

### Component inventory

| Component | Description |
|-----------|-------------|
| **Daemon** | Pure message router that does not directly manage any agent runtime. |
| **Agent Registry** | Tracks the identity, type, state, and declared capabilities of all connected agents. |
| **Room Manager** | Manages room creation, membership changes, and message-routing scope. |
| **Claude bridge / adapter** | Connects to Claude Code through MCP stdio and registers with the daemon as an agent. |
| **Codex adapter** | Independent process that manages its own Codex app-server and registers with the daemon as an agent. |
| **Other adapters** | Adapters such as Gemini that also connect to the daemon as independent processes. |

At a high level:

- Adapters connect to the daemon over the control protocol.
- The daemon tracks agents, rooms, and assignment state centrally.
- Messages are routed through the daemon rather than directly between runtimes.
- Unassigned agents are visible to the system but are not routable as a shared room.
- Multiple room-scoped groups can coexist without interfering with one another.

This architecture makes the following properties explicit:

- Each agent type has an independent adapter process.
- Multiple agent pairs or groups can run at the same time.
- Communication is scoped by room rather than by one global attachment.
- Unassigned is an assignment state, not a room entity.
- The daemon no longer directly owns Codex lifecycle management.

## 4. Core Concepts

| Concept | Description |
|---------|-------------|
| **Agent** | The logical participant connected to the daemon, represented in the system through an adapter. An agent has both a stable identity layer and a current connection layer. It is the basic unit of room membership, assignment state, and policy decisions. |
| **Room** | A communication scope rather than a process, thread, or runtime instance. A room limits communication to a defined set of members. It is a logical collaboration unit that can support one-to-one or multi-agent work. A room is not the owner of agent lifecycle; it is only part of the communication topology. |
| **Unassigned state** | An assignment state, not a room. Newly connected agents begin in the unassigned state until user action or policy assigns them to a room. Unassigned agents are visible to the system, but they must not receive messages merely because they share that state. This state exists for discovery and assignment, not for communication. |
| **Policy** | A decision layer independent from the core router. A policy may decide whether to auto-pair, require invite acceptance, enable turn-based coordination, or apply semantic routing. Policies may read system state and propose actions, but they must not change the fundamental responsibility boundary of the core router. Policies are pluggable and should not hardcode agent-specific logic into the daemon. |
| **Adapter** | The bridge layer between a concrete agent runtime and the AgentBridge control plane. An adapter maps runtime-specific input and output into shared AgentBridge semantics. It may contain runtime-specific behavior, but that behavior does not belong in the daemon. Different agent types may use different adapters while still appearing to the daemon as the same abstract agent model. |

### Room membership model

- An agent may belong to multiple rooms at the same time.
- An agent may also have one default room used as the implicit collaboration context when no explicit target is chosen.
- Room membership is always an explicit relationship. It must not be inferred from agent type, runtime type, or shared unassigned state.
- Invitation and joining are the semantic basis for establishing room membership, even though the protocol details are defined later.
- Invitation should default to requiring acceptance as a semantic rule. Any automatic acceptance belongs to policy behavior rather than to the room concept itself.
- A room may define role semantics such as owner, member, and observer.
- An observer may be allowed to see room state or message flow, but whether an observer can speak or invite others is a later protocol and permission decision.
- A default room is a context-selection concept, not an exclusivity constraint.

### Concept boundaries

- Agent is the participant.
- Adapter is the bridge layer.
- Room is a communication scope, not a process, thread, or runtime instance.
- Unassigned is an assignment state, not a room.
- Policy is the decision layer; the router remains responsible for routing.
- The daemon carries these abstractions as the core router rather than as a runtime manager.

## 5. Protocol Design

The v2 control protocol must be explicit about versioning, authentication, identity, recovery, delivery semantics, and routing metadata. This section defines the connection layer first, then the routing layer, then the cross-cutting protocol requirements.

### 5.1 Version Negotiation, Handshake, and Auth

Every adapter connection begins with explicit protocol negotiation and authentication. Version and capability declaration are part of the handshake itself rather than implicit assumptions made after connection.

```typescript
// Handshake request
{
  type: "handshake",
  protocolVersion: "2.0",
  agentType: "claude" | "codex" | "gemini" | string,
  name?: string,
  capabilities: {
    canReceiveMessages: boolean,
    canStreamIntermediateEvents?: boolean,
    supportsExplicitAddressing?: boolean,
    supportsOfflineQueue?: boolean,
    supportsTurnControl?: boolean,
    [key: string]: unknown
  },
  authToken: "local-random-token"
}

// Handshake success
{
  type: "handshake_ok",
  protocolVersion: "2.0",
  negotiatedVersion: "2.0",
  acceptedCapabilities: {
    canReceiveMessages: true,
    supportsExplicitAddressing: true
  }
}

// Handshake failure: auth
{
  type: "error",
  code: "AUTH_FAILED",
  message: "Authentication failed.",
  retryable: false
}

// Handshake failure: version
{
  type: "error",
  code: "PROTOCOL_VERSION_UNSUPPORTED",
  message: "Unsupported protocol version.",
  retryable: false,
  details: { supportedVersions: ["2.0"] }
}
```

Handshake rules:

- Every connection must declare a protocol version explicitly.
- Version negotiation happens before registration or resume.
- Capability declaration is descriptive and is used for routing or policy decisions, but it does not grant permissions by itself.
- A daemon-generated local token is required for both fresh connections and resumed connections.
- Authentication determines whether a process may connect to the daemon. It does not by itself decide room-level permissions.

### 5.2 Agent Identity, Registration, and Resume

After a successful handshake, an agent either registers as a new logical participant or resumes an existing logical identity. The protocol distinguishes stable logical identity from the current live session.

```typescript
// New agent registration
{
  type: "agent_register",
  protocolVersion: "2.0",
  agentType: "claude" | "codex" | "gemini" | string,
  name?: string,
  capabilities: {
    canReceiveMessages: true
  }
}

// Registration success
{
  type: "agent_registered",
  protocolVersion: "2.0",
  agentId: "ag-7",
  sessionId: "sess-21",
  resumeToken: "rtok-...",
  assignmentState: "unassigned"
}

// Resume an existing logical identity
{
  type: "agent_resume",
  protocolVersion: "2.0",
  agentId: "ag-7",
  resumeToken: "rtok-...",
  capabilities: {
    canReceiveMessages: true
  }
}

// Resume success
{
  type: "agent_resumed",
  protocolVersion: "2.0",
  agentId: "ag-7",
  sessionId: "sess-22",
  assignmentState: "assigned",
  rooms: ["room-3"],
  defaultRoomId: "room-3"
}

// Resume failure
{
  type: "error",
  code: "RESUME_TOKEN_INVALID",
  message: "Resume token is invalid or expired.",
  retryable: false
}
```

Identity and resume rules:

- A logical agent identity remains stable across reconnects, while the live session identity is tied to the current connection.
- Fresh registration creates a new logical identity and a new live session.
- Resume rebinds an existing logical identity to a new live session.
- Resume should restore room memberships, assignment state, default routing context, and any pending deliveries supported by the implementation.
- If resume fails, the daemon should reject the resume attempt rather than silently converting it into a fresh registration.
- If a conflicting live session already exists, the daemon must define whether the new connection is rejected or replaces the older live session.

### 5.3 Heartbeat

Heartbeat exists to detect stale sessions, distinguish temporary silence from dead connections, and trigger offline semantics when a live session is no longer healthy.

```typescript
{ type: "ping", timestamp: 1713 }
{ type: "pong", timestamp: 1713 }

// Example timeout result
{
  type: "agent_offline",
  agentId: "ag-7",
  reason: "heartbeat_timeout"
}
```

Heartbeat rules:

- Both the daemon and adapters must support periodic heartbeat.
- A missed heartbeat should transition the live session from healthy to suspect and then to offline after timeout.
- Heartbeat timeout invalidates the current live session but does not necessarily invalidate the underlying logical identity.
- Once a heartbeat timeout marks a session offline, the agent may reconnect later through the resume flow if its resume credential is still valid.
- Heartbeat behavior should be symmetric unless the implementation documents a deliberate asymmetric policy.

### 5.4 Room Management

Room management defines how logical collaboration scopes are created, joined, updated, and listed at the protocol layer. Unassigned remains an assignment state rather than a room, so room operations always act on explicit room entities.

```typescript
{ type: "room_create", name?: "Review Pair" }                      // -> { roomId: "room-3" }
{ type: "room_join", roomId: "room-3" }                            // join self
{ type: "room_invite", roomId: "room-3", agentId: "ag-5" }        // invite another agent
{ type: "room_invite_accept", roomId: "room-3" }
{ type: "room_invite_decline", roomId: "room-3", reason?: "busy" }
{ type: "room_leave", roomId: "room-3" }
{ type: "room_set_default", roomId: "room-3" }
{ type: "room_list" }
{ type: "agent_list" }
```

Room management rules:

- Room membership is explicit and must be created through room operations rather than inferred implicitly.
- An agent may belong to multiple rooms, but it may have at most one default room at a time.
- Invite acceptance is the default semantic rule for establishing membership. Policy may later automate acceptance in specific modes.
- Role metadata such as owner, member, and observer may exist in room state, but this section keeps permissions minimal and descriptive.
- Unassigned is not a room and must never appear as a routable room target.
- Room and agent listing responses should include enough metadata for user interfaces and policies to make assignment decisions.

### 5.5 Message Envelope

The message envelope defines logical message identity, routing scope, delivery semantics, acknowledgment behavior, and explicit addressing.

```typescript
type DeliveryMode = "online_only" | "store_if_offline";

// Broadcast within a room
{
  type: "message",
  protocolVersion: "2.0",
  roomId: "room-3",
  messageId: "msg-123",
  traceId: "trace-abc",
  idempotencyKey: "idem-456",
  from: {
    agentId: "ag-2",
    sessionId: "sess-22",
    agentType: "codex",
    name: "Codex"
  },
  content: "Please review the patch.",
  timestamp: 1711,
  deliveryMode: "online_only",
  ack: { requested: true }
}

// Targeted delivery within or alongside room scope
{
  type: "message",
  protocolVersion: "2.0",
  roomId: "room-3",
  messageId: "msg-124",
  traceId: "trace-abd",
  idempotencyKey: "idem-457",
  from: {
    agentId: "ag-1",
    sessionId: "sess-30",
    agentType: "claude",
    name: "Claude"
  },
  to: {
    agentIds: ["ag-2"]
  },
  mentions: ["ag-2"],
  content: "@codex: focus on the failing test.",
  timestamp: 1712,
  deliveryMode: "store_if_offline",
  ack: { requested: true }
}

// Acknowledgment
{
  type: "message_ack",
  protocolVersion: "2.0",
  messageId: "msg-124",
  traceId: "trace-abd",
  roomId: "room-3",
  fromAgentId: "ag-2",
  status: "accepted" | "delivered" | "queued" | "dropped" | "failed",
  timestamp: 1713
}
```

Message envelope rules:

- `messageId` identifies one logical message.
- `traceId` correlates routing, policy decisions, adapter logs, acknowledgments, and downstream runtime behavior.
- `idempotencyKey` prevents duplicate logical delivery across retries or reconnects.
- `roomId` defines the primary routing scope even when explicit targets are present.
- `to` narrows the recipient set, while `mentions` carry informational or workflow-significant targeting semantics.
- `deliveryMode` must be explicit for every message.
- `ack.requested` allows the sender to request structured delivery confirmation.

### 5.6 Event Notifications

Event notifications communicate state changes in presence, room state, and assignment state. They are control-plane notifications, not ordinary conversation messages.

```typescript
{ type: "agent_online", agentId: "ag-5", sessionId: "sess-30", agentType: "gemini", name: "Gemini" }
{ type: "agent_offline", agentId: "ag-5", reason: "heartbeat_timeout" | "disconnect" | "process_exit" }
{ type: "room_updated", roomId: "room-3", members: [...] }
{ type: "assignment_updated", agentId: "ag-5", assignmentState: "unassigned" | "assigned" }
```

Event notification rules:

- Presence events such as `agent_online` and `agent_offline` describe availability changes for agents.
- Room and assignment events describe topology changes rather than message deliveries.
- Event audience should be explicit: some events go to all connected agents, while others may go only to affected agents or room members.
- Events must remain semantically distinct from ordinary user or agent messages.

### 5.7 Error Model

Errors must be machine-readable, stable, and correlatable to the operation that failed. Human-readable text is useful for debugging but is secondary to structured error semantics.

```typescript
{
  type: "error",
  protocolVersion: "2.0",
  code:
    | "AUTH_FAILED"
    | "PROTOCOL_VERSION_UNSUPPORTED"
    | "CAPABILITY_DECLARATION_INVALID"
    | "RESUME_TOKEN_INVALID"
    | "ROOM_NOT_FOUND"
    | "ROOM_INVITE_REQUIRES_ACCEPT"
    | "AGENT_NOT_FOUND"
    | "DELIVERY_FAILED"
    | "MESSAGE_DUPLICATE"
    | "INVALID_REQUEST",
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
}
```

Error model rules:

- Every error must carry a stable machine-readable error code.
- Errors may be session-fatal or request-scoped depending on their category.
- `retryable` indicates whether the caller may safely retry the failed operation.
- `details` may carry structured context such as supported versions, target identifiers, or validation failures.
- The canonical error code set should live in one place in the protocol documentation.

### 5.8 Observability Requirements

The protocol must carry enough metadata to correlate requests, messages, events, acknowledgments, and errors across daemon and adapter boundaries.

Required identifiers:

- `messageId`
- `traceId`
- `roomId`
- `fromAgentId`

Recommended additional fields:

- `sessionId`
- `deliveryMode`
- target identifiers such as explicit recipient agent IDs
- policy decision metadata such as `policyName` and `decisionReason`

Observability requirements:

- Daemon logs and adapter logs must be correlatable through shared identifiers.
- One logical message should be traceable across send, route, acknowledge, and failure paths.
- Requests, responses, events, acknowledgments, and errors should all participate in the same correlation model.
- Observability data exists to support debugging, replay analysis, delivery troubleshooting, and multi-agent coordination visibility.

## 6. User Experience Flow

This section describes representative flows from the user perspective. It explains what the user sees when agents appear, get assigned, communicate, and recover from interruptions, without restating protocol details.

1. **Simple pairing flow**
   The user starts Claude Code and then starts Codex. Both appear in the system, initially unassigned. The user, or a simple pairing policy, assigns the two agents into the same room. Once assigned, communication is scoped to that room rather than to one global bridge attachment.

2. **Multiple pairs flow**
   The user starts a second Claude and a second Codex instance. The newly started agents appear independently and do not disrupt the first room. The user can create a second room for them, resulting in two concurrent collaboration groups that coexist without interfering with each other.

3. **Multi-room context flow**
   An agent may participate in more than one room. When the user replies without an explicit target, the system resolves the action through the current chat context or the agent's default room. The user experience should preserve an implicit working context without hiding the fact that multiple rooms exist.

4. **Unassigned discovery flow**
   When a new agent comes online, the user can see that it exists and that it is still unassigned. Unassigned status is discoverable and manageable, but it does not act as a shared communication room. The user must still assign the agent, or let a policy assign it, before conversation begins.

5. **Failure or interruption flow**
   If an agent disconnects or times out, the user should see a state change rather than a collapse of the entire system. Existing rooms remain meaningful as collaboration scopes even when one participant is temporarily unavailable. If the agent later reconnects, the experience should feel like a continuation rather than a brand-new unrelated interaction.

## 7. MCP Tool Changes

V2 expands the MCP surface from one reply primitive into a small set of user-facing control tools. The tools expose collaboration operations rather than raw transport details.

| Tool | Purpose |
|------|---------|
| `reply(chat_id, text)` | Backward-compatible reply. Resolves room by chat binding, then `defaultRoomId` as fallback. |
| `agents()` | List online agents, their assignment state, capabilities, and default collaboration context. |
| `rooms()` | List rooms, their members, role summaries, and default-room bindings where relevant. |
| `create_room(name?)` | Create a room. |
| `invite(room_id, agent_id)` | Invite an agent to a room. |
| `accept_invite(room_id)` | Accept an invite. |
| `decline_invite(room_id, reason?)` | Decline an invite. |
| `leave(room_id)` | Leave a room. |
| `set_default_room(room_id)` | Set the implicit destination for future replies. |

Tool design principles:

- Tools should expose user-facing collaboration controls, not low-level protocol mechanics.
- The tool set should remain minimal and composable.
- Single-room flows should remain simple, while multi-room flows should remain explicit.
- Existing reply-driven workflows should continue to work with minimal user friction.

## 8. Adapter Independence

Adapters isolate runtime-specific concerns from the daemon. The daemon sees a uniform control-plane contract, while each adapter handles the behavior of its own runtime.

### 8.1 Adapter Responsibilities

- An adapter owns the integration with a specific runtime.
- An adapter translates runtime-specific input and output into AgentBridge protocol semantics.
- An adapter receives routed messages from the daemon and turns runtime output into protocol messages or events.
- An adapter may start and manage its own runtime process or runtime connection.
- An adapter is responsible for reporting runtime state back into the control plane.
- Multiple adapters may run independently, and one adapter's failure should not collapse unrelated rooms or unrelated adapters.
- Examples include the Claude bridge or adapter, the Codex adapter, and adapters for additional runtimes such as Gemini.

### 8.2 Runtime-Specific Constraints

Different runtimes do not behave like a generic message bus. Some are turn-based, stateful, or effectively serial, which means the adapter must absorb runtime-specific execution constraints instead of pushing them into the daemon.

- Codex is effectively turn-based and serial from the adapter perspective.
- A Codex adapter must manage input sequencing rather than blindly injecting concurrent work.
- A Codex adapter must provide backpressure when the runtime cannot accept more work immediately.
- A Codex adapter may need local inbox or queue semantics to absorb routed messages safely.
- Runtime-specific execution policy belongs in the adapter, not in the daemon.
- Future adapters such as Gemini may have different constraints, and the architecture should allow those differences without changing the daemon abstraction.

## 9. Operational Loop

The architecture is not complete unless the local runtime loop is operationally closed. This section defines how the system starts, supervises, discovers, cleans up, and enforces resource limits outside the protocol itself.

### 9.1 Startup and Supervision

- A daemon instance must be startable in a way that preserves the simple local "just works" workflow.
- Adapters may be started by a lightweight launcher in simple mode or explicitly by local tooling in multi-agent mode.
- Adapter restart behavior should use bounded backoff rather than unbounded respawn.
- The daemon should not implicitly regain full runtime-supervisor responsibility unless that scope is reintroduced intentionally.

### 9.2 Daemon Discovery and Token Distribution

- Adapters need a deterministic way to discover the local daemon endpoint.
- Environment variables may override the default local endpoint when an explicit deployment or debugging path is needed.
- Discovery metadata should include endpoint information, daemon identity, and enough context to retrieve or validate the local auth token.
- Discovery metadata may be stored in a local metadata file owned by the current user.
- A resumed adapter also needs access to its local recovery metadata without turning discovery into an ad hoc protocol extension.
- Discovery metadata and token references must remain private to the local user account.
- If a token is stored through a local token file, that file should be restricted to mode `600` or an equivalent user-private permission model.
- Auth tokens should rotate when the daemon restarts.

### 9.3 Port Allocation and Stale Cleanup

- Adapter-owned runtime ports such as app-server and proxy ports should be allocated under an explicit local policy.
- Port ownership should be attributable to a specific adapter instance or live session.
- Local PID files may be used to detect whether a previously recorded daemon or adapter process is still alive.
- Startup logic should detect stale adapter processes and stale metadata before claiming or reusing a port.
- Cleanup must distinguish a stale orphan from a live conflicting process before taking destructive action.
- Shutdown should release owned ports and clear stale local metadata.

### 9.4 Resource Limits

- The system should cap adapters per daemon or per workspace.
- The system should bound queued messages per agent and per room.
- The system should cap room membership size when needed to avoid unbounded fan-out within a single collaboration scope.
- Logs should be bounded by size or retention policy.
- CPU, memory, background process count, and port consumption should all have explicit local limits.
- The design should distinguish soft warnings from hard rejection of new work or new adapters.

## 10. Pairing Policy Layer

The policy layer is where assignment and routing decisions are made without polluting the core router boundary. Policies can read system state and recommend actions, but they do not replace protocol validation or router enforcement.

### Policy role

- Policies evaluate agent state, room state, assignment state, capabilities, and incoming context.
- Policies propose actions such as pairing, requiring acceptance, selecting default context, or constraining turn flow.
- Policies remain pluggable and should not hardcode agent-specific logic into the daemon core.
- The router remains responsible for validation and execution of any resulting action.

### Policy interface

Inputs to a policy may include:

- current agent registry view
- room state
- assignment state
- incoming event or message context
- declared capability metadata

Outputs from a policy may include:

- propose pairing two or more agents
- require manual acceptance
- set or change default room context
- recommend explicit target routing
- suppress, defer, or reject an otherwise ambiguous action

### Built-in policies

- **AutoPairPolicy**: pairs compatible agents in simple mode without introducing ambiguity in complex multi-room cases.
- **ManualAssignmentPolicy**: conservative default policy that requires explicit user action for assignment.
- **SemanticRoutePolicy**: recommends targets based on intent or context but does not replace explicit addressing.
- **TurnCoordinationPolicy**: constrains alternating turns and reduces runaway loops between agents.

The policy layer is also the natural place to carry forward the collaboration patterns introduced in v1. In v1, role-aware collaboration and thinking patterns are applied only to the single-bridge path. In v2, the same concepts can evolve into room-aware, multi-agent collaboration policies built on top of explicit identity and routing.

### Policy constraints

- Policies may suggest actions but must not bypass authorization or protocol validation.
- Policy failure should not break baseline routing behavior.
- Policy decisions should remain observable and explainable.

## 11. Compatibility and Migration Roadmap

Compatibility is primarily about behavioral continuity, not permanent wire-level compatibility. The migration should preserve the useful single-room path while progressively introducing the abstractions needed for v2.

### Compatibility goals

- Existing single-room reply-driven workflows should continue to feel familiar.
- Simple mode should preserve the current low-friction local experience as much as possible.
- Compatibility layers may be temporary and should not become permanent architectural constraints.

### Five-phase roadmap

| Phase | Core change | Compatibility expectation | Main risk |
|------|-------------|---------------------------|-----------|
| **1. Internal refactor** | Introduce registry, room, session, and assignment abstractions inside the existing implementation. | External behavior stays as close to current behavior as possible. | Internal churn without visible benefit may destabilize the current path. |
| **2. Protocol completion** | Finalize and implement the v2 control protocol with handshake, identity, heartbeat, rooms, messages, errors, and observability. | Old and new paths may temporarily coexist through a shim or compatibility layer. | Running two protocol paths at once increases complexity and drift risk. |
| **3. Room and policy layer** | Enable explicit room behavior, default context handling, and pluggable policy hooks. | Multi-agent workflows become usable without breaking simple mode. | Implicit behavior may conflict with explicit user intent. |
| **4. Persistence and recovery** | Add durable identity, room, and pending-delivery recovery based on SQLite-backed state. | Recovery becomes more reliable instead of best-effort only. | State mismatch, duplicate recovery, and migration bugs become more likely. |
| **5. Advanced capabilities** | Extend the v1 single-bridge experience patterns into formal multi-agent capabilities, including room-aware filtering, policy-backed coordination, richer collaboration patterns, and third-agent integrations such as Gemini. | Advanced features layer on top of a stable multi-agent foundation rather than redefining it. | Higher-level features may leak complexity back into the core abstractions. |

### Compatibility guarantees and non-goals

Retained behaviors:

- Backward-compatible reply flows remain an explicit compatibility target.
- Simple local collaboration remains a first-class path throughout migration.
- Single-room workflows should continue to feel familiar during the migration window.

Temporary compatibility layers:

- Legacy protocol shims may exist during the transition from the current control path to the formal v2 protocol.
- Transitional default behaviors may remain in place while room and policy semantics are being introduced.
- Compatibility helpers may preserve old reply-driven expectations while newer room-aware flows are rolled out.

Behaviors that are not long-term obligations:

- Permanent preservation of every old wire behavior is not a goal.
- The singleton attachment model is not preserved.
- Daemon-owned runtime management is not preserved as a permanent architectural constraint.

## 12. Persistence and Security

Persistence and security define what state survives daemon restart, when that state is written or cleaned up, how recovery proceeds, and what assumptions the local trust model makes.

### 12.1 SQLite Data Model

SQLite is the recommended persistence layer because it provides transactional safety, concurrent access control, schema migration support, and better crash recovery behavior than ad hoc JSON files.

Core persisted entities should include:

- agents
- live session records or resumable session metadata
- rooms
- room memberships
- default-room bindings
- pending deliveries
- resume credentials or equivalent recovery metadata
- optional policy state if any policy requires durable state

Persisted state should focus on logical identity, communication topology, and delivery recovery rather than transient runtime internals.

### 12.2 Write Timing, Cleanup, and Recovery Order

Write timing should be defined for at least these transitions:

- agent registration
- room creation or mutation
- default-room change
- message queueing for offline delivery
- acknowledgment or final delivery outcome
- disconnect or timeout that affects resumable state

Cleanup strategy should define:

- when stale live-session records are removed
- when expired pending deliveries are discarded
- when old resume metadata is invalidated
- when background maintenance such as compaction or vacuuming is appropriate

Recovery order should restore topology before queued traffic. A reasonable order is:

1. logical identities
2. rooms and memberships
3. default-room bindings
4. pending deliveries
5. resumable session metadata

That order avoids replaying messages before the relevant collaboration topology exists again.

### 12.3 Security Notes

- The daemon should generate a random local auth token at startup.
- Both fresh registration and resume require authentication.
- Discovery metadata and token references must be readable only by the local user.
- Structured audit logs should capture room mutations, explicit routing actions, and failed auth or resume attempts.
- The security model is primarily a local single-user trust model. It does not claim to solve stronger cross-host or adversarial deployment scenarios.

## 13. Solving Connection Replacement

The current connection replacement problem exists because the system has one global Claude attachment point. The newest connection wins, and the previous one is displaced. V2 fixes that by replacing singleton attachment with explicit identity and topology.

Root cause:

- one global Claude attachment
- no room-scoped routing model
- no separation between logical identity and live session

V2 resolution:

- replace singleton attachment state with an agent registry
- track live session separately from logical identity
- scope communication by room and explicit routing targets
- keep unassigned agents isolated until they are assigned

```text
Start Claude Code 1  -> registers as ag-1, assignmentState=unassigned
Start Codex 1        -> registers as ag-2, paired into room-1: [ag-1, ag-2]
Start Codex 2        -> registers as ag-3, remains unassigned
Start Claude Code 2  -> registers as ag-4, paired into room-2: [ag-3, ag-4]

Result: two independent collaboration groups can coexist without newer connections replacing older ones.
```

## 14. Next Steps

The next practical steps are:

1. Complete Phase 1 internal refactor so the codebase has registry, room, session, and assignment abstractions without breaking the current path.
2. Converge the protocol design into a formal v2 control protocol draft.
3. Build adapters against that converged protocol surface.
4. Validate the end-to-end architecture and iterate based on implementation findings.
