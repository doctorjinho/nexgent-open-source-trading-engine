/**
 * Agents API Service
 * 
 * Handles all agent-related API calls.
 * 
 * @module infrastructure/api/services
 */

import { apiClient } from '../client/api-client';
import { extractErrorFromResponse } from '../client/error-handler';
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from '@/shared/types/api.types';
import type { AgentTradingConfig } from '@nexgent/shared';

/**
 * Agents API Service
 * 
 * Provides type-safe methods for interacting with agent endpoints.
 * 
 * @example
 * ```ts
 * const agentsService = new AgentsService();
 * const agents = await agentsService.getAgents();
 * const agent = await agentsService.getAgent('agent-123');
 * ```
 */
export class AgentsService {
  /**
   * Fetch all agents
   * 
   * @param userId - Optional user ID to filter agents
   * @returns Promise resolving to array of agents
   * @throws Error if request fails
   * 
   * @example
   * ```ts
   * const agents = await agentsService.getAgents('user-123');
   * ```
   */
  async getAgents(userId?: string): Promise<Agent[]> {
    const url = userId ? `/api/v1/agents?userId=${userId}` : '/api/v1/agents';
    const response = await apiClient.get(url);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch agents');
    }

    const data = await response.json();
    // Handle different response formats
    return Array.isArray(data) ? data : data.agents || [];
  }

  /**
   * Fetch a single agent by ID
   * 
   * @param agentId - Agent ID
   * @returns Promise resolving to agent
   * @throws Error if request fails
   * 
   * @example
   * ```ts
   * const agent = await agentsService.getAgent('agent-123');
   * ```
   */
  async getAgent(agentId: string): Promise<Agent> {
    const response = await apiClient.get(`/api/v1/agents/${agentId}`);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch agent');
    }

    return response.json();
  }

  /**
   * Create a new agent
   * 
   * @param agentData - Agent creation data
   * @returns Promise resolving to created agent
   * @throws Error if creation fails
   * 
   * @example
   * ```ts
   * const agent = await agentsService.createAgent({
   *   name: 'Trading Bot',
   *   tradingMode: 'simulation',
   * });
   * ```
   */
  async createAgent(agentData: CreateAgentRequest): Promise<Agent> {
    const response = await apiClient.post('/api/v1/agents', agentData);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to create agent');
    }

    return response.json();
  }

  /**
   * Update an existing agent
   * 
   * @param agentId - Agent ID
   * @param agentData - Agent update data
   * @returns Promise resolving to updated agent
   * @throws Error if update fails
   * 
   * @example
   * ```ts
   * const agent = await agentsService.updateAgent('agent-123', {
   *   name: 'Updated Name',
   * });
   * ```
   */
  async updateAgent(
    agentId: string,
    agentData: UpdateAgentRequest
  ): Promise<Agent> {
    const response = await apiClient.put(`/api/v1/agents/${agentId}`, agentData);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to update agent');
    }

    return response.json();
  }

  /**
   * Delete an agent
   * 
   * @param agentId - Agent ID
   * @returns Promise resolving when deletion is complete
   * @throws Error if deletion fails
   * 
   * @example
   * ```ts
   * await agentsService.deleteAgent('agent-123');
   * ```
   */
  async deleteAgent(agentId: string): Promise<void> {
    const response = await apiClient.delete(`/api/v1/agents/${agentId}`);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to delete agent');
    }
  }

  /**
   * Fetch agent trading configuration
   * 
   * @param agentId - Agent ID
   * @returns Promise resolving to agent trading configuration
   * @throws Error if request fails
   * 
   * @example
   * ```ts
   * const config = await agentsService.getTradingConfig('agent-123');
   * ```
   */
  async getTradingConfig(agentId: string): Promise<AgentTradingConfig> {
    const response = await apiClient.get(`/api/v1/agents/${agentId}/config`);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch trading configuration');
    }

    const data = await response.json();
    return data.config;
  }

  /**
   * Update agent trading configuration
   * 
   * @param agentId - Agent ID
   * @param config - Partial trading configuration to update
   * @returns Promise resolving to updated agent trading configuration
   * @throws Error if update fails
   * 
   * @example
   * ```ts
   * const updatedConfig = await agentsService.updateTradingConfig('agent-123', {
   *   purchaseLimits: {
   *     maxPurchasePerToken: 3.0
   *   }
   * });
   * ```
   */
  async updateTradingConfig(
    agentId: string,
    config: Partial<AgentTradingConfig>
  ): Promise<AgentTradingConfig> {
    const response = await apiClient.put(`/api/v1/agents/${agentId}/config`, {
      config,
    });

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to update trading configuration');
    }

    const data = await response.json();
    return data.config;
  }

  /**
   * Fetch agent performance metrics
   * 
   * @param agentId - Agent ID
   * @param timeframe - Timeframe for performance metrics ('24h' or 'all')
   * @param walletAddress - Optional wallet address to filter by trading mode
   * @returns Promise resolving to performance summary
   * @throws Error if request fails
   * 
   * @example
   * ```ts
   * const performance = await agentsService.getAgentPerformance('agent-123', 'all', 'wallet-address');
   * ```
   */
  async getAgentPerformance(
    agentId: string,
    timeframe: '24h' | 'all' = 'all',
    walletAddress?: string
  ): Promise<import('@/features/agents/types/agent.types').PerformanceSummary> {
    const params = new URLSearchParams({ timeframe });
    if (walletAddress) {
      params.append('walletAddress', walletAddress);
    }
    const response = await apiClient.get(`/api/v1/agents/${agentId}/performance?${params.toString()}`);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch performance metrics');
    }

    return response.json();
  }

  /**
   * Fetch agent balance history snapshots
   * 
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address (required)
   * @param timeframe - Timeframe for snapshots ('24h' for hourly, 'all' for daily)
   * @returns Promise resolving to balance history response
   * @throws Error if request fails
   * 
   * @example
   * ```ts
   * const balanceHistory = await agentsService.getAgentBalanceHistory('agent-123', 'wallet-address', 'all');
   * ```
   */
  /**
   * Fetch open positions for an agent.
   *
   * @param agentId - Agent ID
   * @returns Promise resolving to array of open positions
   * @throws Error if request fails
   */
  async getPositions(agentId: string): Promise<Array<{ tokenAddress: string; [key: string]: unknown }>> {
    const response = await apiClient.get(`/api/v1/agents/${agentId}/positions`);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch positions');
    }

    const data = await response.json();
    return Array.isArray(data) ? data : data.positions || [];
  }

  async getAgentBalanceHistory(
    agentId: string,
    walletAddress: string,
    timeframe: '24h' | 'all' = 'all'
  ): Promise<import('@/features/agents/types/agent.types').BalanceHistoryResponse> {
    const params = new URLSearchParams({
      walletAddress,
      timeframe,
    });
    const response = await apiClient.get(`/api/v1/agents/${agentId}/balance-history?${params.toString()}`);

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch balance history');
    }

    return response.json();
  }
}

/**
 * Default agents service instance
 * 
 * @example
 * ```ts
 * import { agentsService } from '@/infrastructure/api/services/agents.service';
 * const agents = await agentsService.getAgents();
 * ```
 */
export const agentsService = new AgentsService();
