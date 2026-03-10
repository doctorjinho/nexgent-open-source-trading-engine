/**
 * Auto-Trade Market Cap Monitor
 *
 * Runs every 30 seconds and monitors auto-trade tokens that are enabled but
 * don't yet have open positions. When a token's market cap enters its configured
 * range (or has no bounds), the monitor triggers a purchase.
 *
 * This complements the reconciliation manager (10-min safety net) by providing
 * faster reaction to market cap changes. Tokens with market-cap bounds are
 * handled exclusively by this monitor; the reconciliation manager skips them.
 *
 * All token addresses across agents are batched into a single Jupiter API call
 * per cycle to avoid rate limiting.
 */

import { prisma } from '@/infrastructure/database/client.js';
import { redisAgentService } from '@/infrastructure/cache/redis-agent-service.js';
import { idempotencyService } from '@/infrastructure/cache/idempotency-service.js';
import { configService } from './config-service.js';
import { AgentRepository } from '@/infrastructure/database/repositories/agent.repository.js';
import { tradingExecutor, TradingExecutorError } from './trading-executor.service.js';
import { hasAutoTradeMarketCapBounds } from './auto-trade-market-cap-guard.js';
import { fetchTokenMetricsBatch } from '@/infrastructure/external/jupiter/index.js';
import type { TokenMetrics } from '@/infrastructure/external/jupiter/index.js';
import {
  AUTO_TRADE_SIGNAL_TYPE,
  AUTO_TRADE_SIGNAL_SOURCE,
  EXPECTED_AUTO_TRADE_SKIP_CODES,
} from './auto-trade-constants.js';
import logger from '@/infrastructure/logging/logger.js';

const MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const MONITOR_LOCK_TTL_SECONDS = 25; // Shorter than interval to allow re-evaluation
const MONITOR_IDEMPOTENCY_PREFIX = 'auto-trade-mcap-monitor';

/** A token that needs market-cap monitoring before auto-trade purchase. */
interface MonitoredToken {
  agentId: string;
  walletAddress: string;
  tokenAddress: string;
  originalTokenAddress: string;
  tokenSymbol?: string;
  marketCapMin?: number;
  marketCapMax?: number;
}

/**
 * Create a synthetic signal record for monitor-triggered purchases.
 *
 * Preserves the signal → position linkage used by DCA/take-profit history.
 */
async function createMonitorAutoTradeSignal(params: {
  agentId: string;
  tokenAddress: string;
  tokenSymbol?: string;
}): Promise<number | null> {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: params.agentId },
      select: { userId: true },
    });
    if (!agent) return null;

    const signal = await prisma.tradingSignal.create({
      data: {
        tokenAddress: params.tokenAddress.trim(),
        symbol: params.tokenSymbol?.trim() || null,
        signalType: AUTO_TRADE_SIGNAL_TYPE,
        activationReason: 'Auto-trade market-cap monitor entry',
        signalStrength: 3,
        source: AUTO_TRADE_SIGNAL_SOURCE,
        userId: agent.userId,
      },
    });
    return signal.id;
  } catch (error) {
    logger.warn(
      { agentId: params.agentId, tokenAddress: params.tokenAddress, error: error instanceof Error ? error.message : String(error) },
      'Auto-trade monitor signal creation failed; continuing without signal link'
    );
    return null;
  }
}

/**
 * Background service that monitors auto-trade tokens awaiting market-cap entry.
 */
class AutoTradeMarketCapMonitor {
  private interval: NodeJS.Timeout | null = null;
  private readonly agentRepo = new AgentRepository();

  /** Start the monitor loop (idempotent). */
  initialize(): void {
    if (this.interval) return;

    this.interval = setInterval(() => {
      this.runCycle().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Auto-trade market-cap monitor cycle failed'
        );
      });
    }, MONITOR_INTERVAL_MS);

    logger.info({ intervalMs: MONITOR_INTERVAL_MS }, 'Auto-trade market-cap monitor initialized');
  }

  /** Stop the monitor loop for clean shutdown. */
  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('Auto-trade market-cap monitor shut down');
    }
  }

  /** Run one full monitoring cycle across all active agents. */
  private async runCycle(): Promise<void> {
    const monitored = await this.collectMonitoredTokens();
    if (monitored.length === 0) return;

    // Deduplicate token addresses for a single batch API call
    const uniqueAddresses = [...new Set(monitored.map((t) => t.originalTokenAddress))];

    const metricsMap = await fetchTokenMetricsBatch(uniqueAddresses);

    logger.debug(
      { monitoredCount: monitored.length, uniqueTokens: uniqueAddresses.length },
      'Auto-trade market-cap monitor cycle running'
    );

    for (const token of monitored) {
      await this.evaluateAndExecute(token, metricsMap);
    }
  }

  /**
   * Collect all auto-trade tokens across active agents that are enabled but
   * don't have an open position. These are the tokens that need monitoring.
   */
  private async collectMonitoredTokens(): Promise<MonitoredToken[]> {
    const activeAgentIds = await redisAgentService.getActiveAgentIds();
    if (activeAgentIds.length === 0) return [];

    const monitored: MonitoredToken[] = [];

    for (const agentId of activeAgentIds) {
      try {
        const config = await configService.loadAgentConfig(agentId);
        if (!config.autoTrade?.enabled) continue;

        const enabledTokens = (config.autoTrade.tokens ?? []).filter((t) => t.enabled);
        if (enabledTokens.length === 0) continue;

        const tradingMode = await redisAgentService.getTradingMode(agentId);
        const wallet = await this.agentRepo.findWalletByAgentId(agentId, tradingMode);
        if (!wallet?.walletAddress) continue;

        // Find which enabled tokens already have an open position
        const existingPositions = await prisma.agentPosition.findMany({
          where: {
            agentId,
            walletAddress: wallet.walletAddress,
            tokenAddress: {
              in: enabledTokens.map((t) => t.address.trim().toLowerCase()),
              mode: 'insensitive',
            },
          },
          select: { tokenAddress: true },
        });
        const positionTokens = new Set(existingPositions.map((p) => p.tokenAddress.toLowerCase()));

        for (const token of enabledTokens) {
          const normalized = token.address.trim().toLowerCase();
          if (positionTokens.has(normalized)) continue;

          monitored.push({
            agentId,
            walletAddress: wallet.walletAddress,
            tokenAddress: normalized,
            originalTokenAddress: token.address.trim(),
            tokenSymbol: token.symbol,
            marketCapMin: token.marketCapMin,
            marketCapMax: token.marketCapMax,
          });
        }
      } catch (error) {
        logger.warn(
          { agentId, error: error instanceof Error ? error.message : String(error) },
          'Auto-trade market-cap monitor skipped agent due to error'
        );
      }
    }

    return monitored;
  }

  /**
   * Evaluate a single monitored token against its market-cap bounds and
   * execute a purchase if conditions are met.
   */
  private async evaluateAndExecute(
    token: MonitoredToken,
    metricsMap: Map<string, TokenMetrics | null>,
  ): Promise<void> {
    const { agentId, walletAddress, tokenAddress, originalTokenAddress, tokenSymbol, marketCapMin, marketCapMax } = token;
    const idempotencyKey = `${MONITOR_IDEMPOTENCY_PREFIX}:${agentId}:${tokenAddress}`;

    const canProceed = await idempotencyService.checkAndSet(idempotencyKey, MONITOR_LOCK_TTL_SECONDS);
    if (!canProceed) return;

    const hasBounds = hasAutoTradeMarketCapBounds({ marketCapMin, marketCapMax });

    if (hasBounds) {
      const metrics = metricsMap.get(originalTokenAddress);
      const marketCap = metrics?.mcap ?? null;

      // Fail-closed: if bounds are set but metrics are unavailable, skip
      if (marketCap == null) {
        logger.debug(
          { agentId, tokenAddress, reason: 'market_cap_unavailable' },
          'Auto-trade monitor skipped: metrics unavailable'
        );
        return;
      }

      if (marketCapMin != null && marketCap < marketCapMin) {
        logger.debug(
          { agentId, tokenAddress, marketCap, marketCapMin },
          'Auto-trade monitor: market cap below min, will retry next cycle'
        );
        return;
      }

      if (marketCapMax != null && marketCap > marketCapMax) {
        logger.debug(
          { agentId, tokenAddress, marketCap, marketCapMax },
          'Auto-trade monitor: market cap above max, will retry next cycle'
        );
        return;
      }

      logger.info(
        { agentId, tokenAddress, marketCap, marketCapMin: marketCapMin ?? null, marketCapMax: marketCapMax ?? null },
        'Auto-trade monitor: market cap in range, executing purchase'
      );
    }

    try {
      const signalId = await createMonitorAutoTradeSignal({
        agentId,
        tokenAddress: originalTokenAddress,
        tokenSymbol,
      });

      const result = await tradingExecutor.executePurchase({
        agentId,
        walletAddress,
        tokenAddress: originalTokenAddress,
        tokenSymbol: tokenSymbol?.trim() || undefined,
        signalId: signalId ?? undefined,
      });

      logger.info(
        {
          agentId,
          walletAddress,
          tokenAddress,
          transactionId: result.transactionId,
          positionId: result.positionId,
        },
        'Auto-trade monitor opened position'
      );
    } catch (error) {
      if (error instanceof TradingExecutorError && error.code && EXPECTED_AUTO_TRADE_SKIP_CODES.has(error.code)) {
        logger.info(
          { agentId, tokenAddress, code: error.code, reason: error.message },
          'Auto-trade monitor purchase skipped by execution guardrail'
        );
        return;
      }

      logger.warn(
        { agentId, tokenAddress, error: error instanceof Error ? error.message : String(error) },
        'Auto-trade monitor failed to open position'
      );
    }
  }
}

const autoTradeMarketCapMonitor = new AutoTradeMarketCapMonitor();

/** Start the market-cap monitor. Called once at app bootstrap. */
export function initializeAutoTradeMarketCapMonitor(): void {
  autoTradeMarketCapMonitor.initialize();
}

/** Stop the market-cap monitor for clean process exit. */
export function shutdownAutoTradeMarketCapMonitor(): void {
  autoTradeMarketCapMonitor.shutdown();
}
