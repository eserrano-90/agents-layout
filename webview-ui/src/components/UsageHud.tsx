import { useState } from 'react';

import type { DailyUsage } from '../hooks/useExtensionMessages.js';
import { shortenModelName } from '../office/modelLabel.js';

interface UsageHudProps {
  usage: DailyUsage | null;
}

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** USD with cents when small, whole dollars when large. */
function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

/**
 * Top-right heads-up display of today's global token usage and estimated cost,
 * aggregated across all agents. Click to expand a per-model breakdown.
 */
export function UsageHud({ usage }: UsageHudProps) {
  const [expanded, setExpanded] = useState(false);

  if (!usage || usage.inputTokens + usage.outputTokens === 0) return null;

  const totalTokens = usage.inputTokens + usage.outputTokens;

  return (
    <div
      className="absolute top-10 right-10 z-20 pixel-panel p-6 cursor-pointer select-none"
      onClick={() => setExpanded((v) => !v)}
      title="Today's usage across all agents (estimated cost)"
      data-testid="usage-hud"
    >
      <div className="flex items-center gap-8 whitespace-nowrap">
        <span className="text-xs text-text-muted">Today</span>
        <span className="text-sm">{formatTokens(totalTokens)} tok</span>
        <span className="text-sm text-accent">{formatCost(usage.costUsd)}</span>
      </div>
      {expanded && (
        <div className="mt-6 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-12 text-2xs text-text-muted">
            <span>↓ {formatTokens(usage.inputTokens)} in</span>
            <span>↑ {formatTokens(usage.outputTokens)} out</span>
          </div>
          {usage.models.map((m) => (
            <div
              key={m.model}
              className="flex items-center justify-between gap-12 text-2xs whitespace-nowrap"
            >
              <span className="overflow-hidden text-ellipsis">{shortenModelName(m.model)}</span>
              <span className="text-accent">{formatCost(m.costUsd)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
