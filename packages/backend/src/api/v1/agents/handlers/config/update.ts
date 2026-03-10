/**
 * Update agent trading configuration endpoint
 * 
 * PUT /api/agents/:id/config
 * PATCH /api/agents/:id/config
 * 
 * Updates the trading configuration for an agent.
 * Performs deep merge with existing config.
 */

import { Response } from 'express';
import { prisma } from '@/infrastructure/database/client.js';
import { configService, ConfigServiceError } from '@/domain/trading/config-service.js';
import { agentService, AgentServiceError } from '@/domain/agents/agent-service.js';
import { tradingExecutor, TradingExecutorError } from '@/domain/trading/trading-executor.service.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import type { UpdateTradingConfigRequest, TradingConfigResponse } from './types.js';
import logger from '@/infrastructure/logging/logger.js';
import {
  AUTO_TRADE_SIGNAL_TYPE,
  AUTO_TRADE_SIGNAL_SOURCE,
} from '@/domain/trading/auto-trade-constants.js';
import { evaluateAutoTradeMarketCapGuard } from '@/domain/trading/auto-trade-market-cap-guard.js';
import type { AgentTradingConfig } from '@nexgent/shared';

/** Token shape returned by {@link getImmediateAutoTradeTokens}, includes market-cap bounds. */
type AutoTradeToken = {
  address: string;
  symbol?: string;
  enabled: boolean;
  marketCapMin?: number;
  marketCapMax?: number;
};

/**
 * Create a synthetic signal for immediate auto-trade purchases triggered by config save.
 *
 * These purchases bypass the normal signal pipeline, so we persist a signal record
 * to keep downstream transaction linking (DCA/take-profit/history) consistent.
 */
async function createImmediateAutoTradeSignal(params: {
  userId: string;
  tokenAddress: string;
  tokenSymbol?: string;
}): Promise<number | null> {
  try {
    const signal = await prisma.tradingSignal.create({
      data: {
        tokenAddress: params.tokenAddress.trim(),
        symbol: params.tokenSymbol?.trim() || null,
        signalType: AUTO_TRADE_SIGNAL_TYPE,
        activationReason: 'Auto-trade immediate buy after config save',
        signalStrength: 3,
        source: AUTO_TRADE_SIGNAL_SOURCE,
        userId: params.userId,
      },
    });

    return signal.id;
  } catch (error) {
    logger.warn(
      { tokenAddress: params.tokenAddress, error: error instanceof Error ? error.message : String(error) },
      'Auto-trade immediate signal creation failed'
    );
    return null;
  }
}

/**
 * Determine which tokens should be purchased immediately after config save.
 *
 * Rules:
 * - If global auto-trade transitions off -> on, buy all currently enabled tokens.
 * - If global auto-trade stays on, buy only newly enabled tokens.
 * - If global auto-trade is off after update, buy nothing.
 */
function getImmediateAutoTradeTokens(
  previousConfig: AgentTradingConfig,
  nextConfig: AgentTradingConfig,
): AutoTradeToken[] {
  const previousAutoTrade = previousConfig.autoTrade;
  const nextAutoTrade = nextConfig.autoTrade;

  if (!nextAutoTrade?.enabled) return [];

  const previousEnabled = previousAutoTrade?.enabled ?? false;
  const previousEnabledSet = new Set(
    (previousAutoTrade?.tokens ?? [])
      .filter((token) => token.enabled)
      .map((token) => token.address.trim().toLowerCase()),
  );

  const nextEnabledTokens = (nextAutoTrade.tokens ?? []).filter((token) => token.enabled);

  if (!previousEnabled) {
    return nextEnabledTokens;
  }

  return nextEnabledTokens.filter(
    (token) => !previousEnabledSet.has(token.address.trim().toLowerCase()),
  );
}

/**
 * Update trading configuration for an agent
 * 
 * Params: { id: string }
 * Body: { config: Partial<AgentTradingConfig> | null }
 * Returns: { config: AgentTradingConfig }
 */
export async function updateAgentTradingConfig(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;
    const { config: partialConfig }: UpdateTradingConfigRequest = req.body;

    // Validate ID format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
      });
    }

    // Validate request body
    if (partialConfig === undefined) {
      return res.status(400).json({
        error: 'Config is required in request body',
      });
    }

    // Verify agent exists and belongs to the authenticated user
    const agent = await prisma.agent.findFirst({
      where: {
        id,
        userId: req.user.id, // Ensure user can only update their own agents
      },
      select: {
        id: true,
      },
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
      });
    }

    let finalConfig: AgentTradingConfig | null = null;
    let existingConfig: AgentTradingConfig | null = null;

    if (partialConfig === null) {
      // Reset to defaults
      finalConfig = null;
    } else {
      // Load existing config (already merged with defaults)
      existingConfig = await configService.loadAgentConfig(id);
      
      // Deep merge partial config with existing config
      finalConfig = configService.mergeConfigs(existingConfig, partialConfig);

      // Validate the merged config
      const validationResult = configService.validateConfig(finalConfig);
      if (!validationResult.valid) {
        return res.status(400).json({
          error: 'Invalid trading configuration',
          details: validationResult.errors,
        });
      }
    }

    // Update configuration (service handles DB save and cache invalidation)
    const updatedConfig = await agentService.updateAgentConfig(id, finalConfig);

    // Trigger immediate auto-trade purchases when auto-trade is switched on
    // or when new token tiles are switched on while global auto-trade is already on.
    if (finalConfig !== null && existingConfig) {
      const immediateTokens = getImmediateAutoTradeTokens(existingConfig, updatedConfig);

      for (const token of immediateTokens) {
        try {
          // Enforce per-token market-cap bounds before immediate purchase.
          // If out of range, the 30s market-cap monitor will pick it up later.
          const marketCapGuard = await evaluateAutoTradeMarketCapGuard({
            tokenAddress: token.address.trim(),
            tokenBounds: { marketCapMin: token.marketCapMin, marketCapMax: token.marketCapMax },
          });
          if (!marketCapGuard.allowed) {
            logger.info(
              {
                agentId: id,
                tokenAddress: token.address,
                reason: marketCapGuard.reason,
                marketCap: marketCapGuard.marketCap,
                marketCapMin: token.marketCapMin ?? null,
                marketCapMax: token.marketCapMax ?? null,
              },
              'Auto-trade immediate buy deferred: market-cap out of range, monitor will retry'
            );
            continue;
          }

          const signalId = await createImmediateAutoTradeSignal({
            userId: req.user.id,
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
          });

          await tradingExecutor.executePurchase({
            agentId: id,
            tokenAddress: token.address.trim(),
            tokenSymbol: token.symbol?.trim(),
            signalId: signalId ?? undefined,
          });
        } catch (error) {
          // Config update must not fail if immediate purchase is skipped or fails.
          if (error instanceof TradingExecutorError) {
            logger.warn(
              { agentId: id, tokenAddress: token.address, code: error.code, message: error.message },
              'Auto-trade immediate purchase skipped/failed'
            );
          } else {
            logger.warn(
              { agentId: id, tokenAddress: token.address, error: error instanceof Error ? error.message : String(error) },
              'Auto-trade immediate purchase failed with unexpected error'
            );
          }
        }
      }
    }

    const response: TradingConfigResponse = {
      config: updatedConfig,
    };

    res.json(response);
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Update agent trading config error');
    
    // Handle service errors
    if (error instanceof AgentServiceError) {
      if (error.code === 'AGENT_NOT_FOUND') {
        return res.status(404).json({
          error: error.message,
        });
      }
      return res.status(400).json({
        error: error.message,
        code: error.code,
      });
    }
    
    // Handle config service errors
    if (error instanceof ConfigServiceError) {
      return res.status(400).json({
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }

    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

