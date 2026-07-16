# Quickstart: Validate VS Code Extension Removal

Runnable validation guide proving the removal is complete and the standalone CLI is intact. Run from repo root after implementation. Each block is a gate; all must be green. Maps to `contracts/removal-verification.contract.md` (V*) and `contracts/standalone-cli.contract.md` (C*).

## Prerequisites

```bash
npm install          # root + workspaces
```

## Gate 1 — No VS Code source remains (V1)

```bash
test ! -d adapters/ && echo "OK: adapters/ removed" || echo "FAIL: adapters/ still present"

grep -rn "from 'vscode'\|from \"vscode\"\|import type \* as vscode" server/src core/src webview-ui/src \
  && echo "FAIL: vscode imports remain" || echo "OK: no vscode imports"

grep -rn "acquireVsCodeApi\|WebviewViewProvider\|PostMessageTransport\|TerminalAdapter\|migrateVsCodeState" \
  server/src core/src webview-ui/src \
  && echo "FAIL: VS Code symbols remain" || echo "OK: no VS Code symbols"
```

**Expected**: all three print `OK`.

## Gate 2 — Build produces standalone artifacts only (V2, V3, C1)

```bash
npm run compile
ls dist/cli.js dist/hooks/claude-hook.js && ls -d dist/webview dist/assets   # expect present
test ! -f dist/extension.js && echo "OK: no extension bundle" || echo "FAIL: extension.js emitted"
```

**Expected**: `dist/cli.js`, `dist/hooks/claude-hook.js`, `dist/webview/`, `dist/assets/` present; `dist/extension.js` absent; `compile` exits 0 (implies `check-types` + `lint` passed).

## Gate 3 — package.json is npm-only (V2)

```bash
node -e "const p=require('./package.json'); const bad=['main','contributes','extensionKind','activationEvents'].filter(k=>k in p); const eng=p.engines&&p.engines.vscode?['engines.vscode']:[]; const scr=['vscode:prepublish','build:extension'].filter(k=>p.scripts&&k in p.scripts); const dev=['@types/vscode','@vscode/test-electron'].filter(k=>p.devDependencies&&k in p.devDependencies); const all=[...bad,...eng,...scr,...dev]; if(all.length){console.error('FAIL: leftover VS Code metadata:',all);process.exit(1)} if(!(p.bin&&p.bin['pixel-agents'])){console.error('FAIL: bin.pixel-agents missing');process.exit(1)} console.log('OK: package.json npm-only, bin intact')"
```

**Expected**: `OK: package.json npm-only, bin intact`.

## Gate 4 — Protocol & provider frozen (C3, C6)

```bash
npm run asyncapi:generate
git diff --exit-code core/src/messages.ts && echo "OK: no protocol drift" || echo "FAIL: messages.ts drifted"
git diff --stat core/ server/src/providers/    # expect: no output (unchanged)
```

**Expected**: no drift; `core/` and `server/src/providers/` show no changes from this feature.

## Gate 5 — Tests green, no VS Code paths (V4)

```bash
npm run test:server
npm run test:webview
grep -rln "fixtures/pixel-agents\|helpers/launch" e2e/tests \
  && echo "FAIL: Electron fixture still referenced" || echo "OK: e2e on standalone only"
npm run e2e:inventory
git diff --exit-code e2e/README.md && echo "OK: inventory in sync" || echo "FAIL: inventory drift"
npm run e2e
```

**Expected**: server + webview + e2e suites pass; no spec references the Electron fixture; inventory has zero drift.

## Gate 6 — Standalone CLI runs end-to-end (C1, C2, C4, C5)

```bash
node dist/cli.js --port 3199 &
CLI_PID=$!
sleep 3
curl -s http://localhost:3199/api/health   # expect {"ok":true,"version":...,"port":3199,"pid":...}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3199/   # expect 200 (SPA served)
test -f ~/.pixel-agents/server.json && echo "OK: server discovery written"
kill $CLI_PID
```

**Expected**: health JSON returns `ok:true`; SPA responds `200`; `server.json` present.

## Gate 7 — Docs & governance consistent (V5)

```bash
test -f README.md && test -f CHANGELOG.md && echo "OK: README + CHANGELOG exist"
grep -qi "npx pixel-agents" CHANGELOG.md && echo "OK: discontinuation points to CLI" || echo "FAIL: no CLI pointer"
grep -n "2.0.0" .specify/memory/constitution.md | head -1   # expect version line
grep -rin "VS Code extension\|\.vsix\|WebviewViewProvider" CLAUDE.md README.md \
  | grep -vi "discontinued\|no longer\|historical" \
  && echo "REVIEW: check remaining VS Code mentions are historical only" || echo "OK: docs single-surface"
```

**Expected**: README + CHANGELOG exist; CHANGELOG points to `npx pixel-agents`; constitution at 2.0.0; remaining VS Code mentions (if any) are historical/discontinuation context only.

## Done

All gates green ⇒ removal complete, standalone CLI intact, governance and docs consistent. Proceed to `/speckit-tasks`.
