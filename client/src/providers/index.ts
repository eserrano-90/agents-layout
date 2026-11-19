/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `client/src/providers/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The client composition imports from here rather than reaching into each
 * provider directory directly.
 */

export { claudeProvider } from './claude/claude.js';
export { copyHookScript } from './claude/claudeHookInstaller.js';
