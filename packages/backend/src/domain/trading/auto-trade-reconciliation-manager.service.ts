/**
 * Auto-Trade Reconciliation Manager
 *
 * Periodically verifies that enabled auto-trade tokens have active positions.
 * If a token is enabled for auto-trade but no open position exists, this manager
 * attempts to open one (subject to market-cap policy and normal trade guardrails).
 *
 * Tokens with per-token market-cap bounds are skipped here and handled by the
 * faster-cadence AutoTradeMarketCapMonitor (30s). This manager acts as a 10-min
 * safety net for tokens without bounds.
 */

import { prisma } from '@/infrastructure/database/client.js';
import { redisAgentService } from '@/infrastructure/cache/redis-agent-service.js';
import { idempotencyService } from '@/infrastructure/cache/idempotency-service.js';
import { configService } from './config-service.js';
import { AgentRepository } from '@/infrastructure/database/repositories/agent.repository.js';
import { tradingExecutor, TradingExecutorError } from './trading-executor.service.js';
import { evaluateAutoTradeMarketCapGuard, hasAutoTradeMarketCapBounds } from './auto-trade-market-cap-guard.js';
import type { TokenMarketCapBounds } from './auto-trade-market-cap-guard.js';
import { EXPECTED_AUTO_TRADE_SKIP_CODES } from './auto-trade-constants.js';
import logger from '@/infrastructure/logging/logger.js';

const RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const RECONCILE_LOCK_TTL_SECONDS = 8 * 60; // Shorter than interval to avoid deadlocks
const RECONCILE_IDEMPOTENCY_PREFIX = 'auto-trade-reconcile';

/**
 * Background manager that periodically reconciles missing auto-trade positions.
 */
export class AutoTradeReconciliationManager {
  private interval: NodeJS.Timeout | null = null;
  private readonly agentRepo = new AgentRepository();

  /**
   * Start reconciliation loop (idempotent).
   */
  initialize(): void {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      this.runCycle().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Auto-trade reconciliation cycle failed'
        );
      });
    }, RECONCILE_INTERVAL_MS);

    logger.info({ intervalMs: RECONCILE_INTERVAL_MS }, 'Auto-trade reconciliation manager initialized');
  }

  /** Stop the periodic reconciliation loop and allow a clean process exit. */
  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('Auto-trade reconciliation manager shut down');
    }
  }

  /**
   * Run one full reconciliation cycle across active agents.
   */
  private async runCycle(): Promise<void> {
    const activeAgentIds = await redisAgentService.getActiveAgentIds();
    if (activeAgentIds.length === 0) {
      return;
    }

    for (const agentId of activeAgentIds) {
      await this.reconcileAgent(agentId);
    }
  }

  /**
   * Reconcile missing auto-trade positions for a single agent.
   */
  private async reconcileAgent(agentId: string): Promise<void> {
    try {
      const config = await configService.loadAgentConfig(agentId);
      if (!config.autoTrade?.enabled) {
        return;
      }

      const enabledTokens = (config.autoTrade.tokens ?? []).filter((token) => token.enabled);
      if (enabledTokens.length === 0) {
        return;
      }

      const tradingMode = await redisAgentService.getTradingMode(agentId);
      const wallet = await this.agentRepo.findWalletByAgentId(agentId, tradingMode);
      if (!wallet?.walletAddress) {
        logger.warn({ agentId, tradingMode }, 'Auto-trade reconciliation skipped: active wallet not found');
        return;
      }

      for (const token of enabledTokens) {
        // Tokens with market-cap bounds are handled by the 30s market-cap monitor.
        // Reconciliation only covers tokens without bounds as a 10-min safety net.
        if (hasAutoTradeMarketCapBounds(token)) continue;

        await this.reconcileToken({
          agentId,
          walletAddress: wallet.walletAddress,
          tokenAddress: token.address,
          tokenSymbol: token.symbol,
          tokenBounds: token,
        });
      }
    } catch (error) {
      logger.warn(
        { agentId, error: error instanceof Error ? error.message : String(error) },
        'Auto-trade reconciliation skipped for agent due to error'
      );
    }
  }

  /**
   * Reconcile a single token for an agent wallet.
   */
  private async reconcileToken(params: {
    agentId: string;
    walletAddress: string;
    tokenAddress: string;
    tokenSymbol?: string;
    tokenBounds: TokenMarketCapBounds;
  }): Promise<void> {
    const { agentId, walletAddress, tokenAddress, tokenSymbol, tokenBounds } = params;
    const normalizedToken = tokenAddress.trim().toLowerCase();
    const idempotencyKey = `${RECONCILE_IDEMPOTENCY_PREFIX}:${agentId}:${walletAddress}:${normalizedToken}`;

    const canProceed = await idempotencyService.checkAndSet(idempotencyKey, RECONCILE_LOCK_TTL_SECONDS);
    if (!canProceed) {
      return;
    }

    // If there is already an active position for this token, nothing to do.
    const existingPosition = await prisma.agentPosition.findFirst({
      where: {
        agentId,
        walletAddress,
        tokenAddress: {
          equals: normalizedToken,
          mode: 'insensitive',
        },
      },
      select: { id: true },
    });
    if (existingPosition) {
      return;
    }

    // Enforce per-token auto-trade market-cap policy before trying to open a position.
    const marketCapGuard = await evaluateAutoTradeMarketCapGuard({
      tokenAddress: normalizedToken,
      tokenBounds,
    });
    if (!marketCapGuard.allowed) {
      logger.info({
        agentId,
        walletAddress,
        tokenAddress: normalizedToken,
        reason: marketCapGuard.reason,
        marketCap: marketCapGuard.marketCap,
        marketCapMin: tokenBounds.marketCapMin ?? null,
        marketCapMax: tokenBounds.marketCapMax ?? null,
      }, 'Auto-trade reconciliation skipped by market-cap policy');
      return;
    }

    try {
      const result = await tradingExecutor.executePurchase({
        agentId,
        walletAddress,
        tokenAddress: normalizedToken,
        tokenSymbol: tokenSymbol?.trim() || undefined,
      });

      logger.info({
        agentId,
        walletAddress,
        tokenAddress: normalizedToken,
        transactionId: result.transactionId,
        positionId: result.positionId,
      }, 'Auto-trade reconciliation opened missing position');
    } catch (error) {
      if (error instanceof TradingExecutorError && error.code && EXPECTED_AUTO_TRADE_SKIP_CODES.has(error.code)) {
        logger.info({
          agentId,
          walletAddress,
          tokenAddress: normalizedToken,
          code: error.code,
          reason: error.message,
        }, 'Auto-trade reconciliation skipped by execution guardrail');
        return;
      }

      logger.warn({
        agentId,
        walletAddress,
        tokenAddress: normalizedToken,
        error: error instanceof Error ? error.message : String(error),
      }, 'Auto-trade reconciliation failed to open missing position');
    }
  }
}

const autoTradeReconciliationManager = new AutoTradeReconciliationManager();

/**
 * Initialize periodic auto-trade reconciliation.
 */
export function initializeAutoTradeReconciliationManager(): void {
  autoTradeReconciliationManager.initialize();
}

/** Stop the reconciliation loop for clean process exit. */
export function shutdownAutoTradeReconciliationManager(): void {
  autoTradeReconciliationManager.shutdown();
}

