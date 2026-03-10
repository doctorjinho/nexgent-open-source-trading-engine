/**
 * Hook that returns the set of token addresses with open positions for an agent.
 *
 * Used by AutoTradeSection to derive monitoring state: a token that is enabled
 * for auto-trade but absent from this set is "waiting" / "monitoring".
 */

import { useQuery } from '@tanstack/react-query';
import { AgentsService } from '@/infrastructure/api/services/agents.service';

const agentsService = new AgentsService();

/**
 * Fetch open position token addresses for an agent.
 *
 * @param agentId - Agent ID (skip query when undefined)
 * @returns Set of normalized (lowercase) token addresses with open positions
 */
export function useAutoTradePositionTokens(agentId: string | undefined): Set<string> {
  const { data } = useQuery({
    queryKey: ['autoTradePositionTokens', agentId],
    queryFn: async () => {
      const positions = await agentsService.getPositions(agentId!);
      return positions.map((p) => (p.tokenAddress as string).toLowerCase());
    },
    enabled: !!agentId,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  return new Set(data ?? []);
}
