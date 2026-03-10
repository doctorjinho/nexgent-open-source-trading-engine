/**
 * Agents Feature Module
 * 
 * This module exports all agent-related components, hooks, and types.
 * 
 * @module features/agents
 */

// Components
export { AgentSwitcher } from './components/agent-switcher/agent-switcher';
export { CreateAgentDialog } from './components/create-agent-dialog/create-agent-dialog';

// Hooks
export {
  useAgents,
  useAgent,
  useCreateAgent,
  useUpdateAgent,
  useDeleteAgent,
} from './hooks/use-agent';
export {
  useAgentBalances,
  useAgentBalance,
} from './hooks/use-agent-balances';
export {
  useAgentTradingConfig,
  useUpdateAgentTradingConfig,
} from './hooks/use-agent-trading-config';
export { useAgentPerformance } from './hooks/use-agent-performance';
export { useAgentBalanceHistory } from './hooks/use-agent-balance-history';
export { useAutoTradePositionTokens } from './hooks/use-auto-trade-position-tokens';

// Types
export type {
  LivePosition,
  PerformanceSummary,
  UseAgentPerformanceReturn,
  BalanceSnapshot,
  BalanceHistoryResponse,
  UseAgentBalanceHistoryReturn,
} from './types/agent.types';

