# Changelog

## 2026-07-16

### VS Code Extension Discontinued

The VS Code extension (`pablodelucca.pixel-agents`) is no longer distributed or
maintained. The project now ships exclusively as a standalone CLI.

**What changed**: The `adapters/vscode/` layer, extension build target, VS Code E2E
harness, and all VS Code metadata have been removed. The codebase is now single-surface.

**What to do**: If you installed the VS Code extension, it will continue to work with
its last published version. For ongoing updates and new features, use the standalone CLI:

```bash
npx pixel-agents
```

See [README.md](./README.md) for usage instructions.

*Note: Unpublishing the VS Code Marketplace and Open VSX listings is tracked
externally and is out of scope for this repository.*
