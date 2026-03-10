/**
 * Auto-Trade Reconciliation Manager Unit Tests
 *
 * Verifies the 10-minute reconciliation logic for opening missing positions.
 */

import { AutoTradeReconciliationManager } from '@/domain/trading/auto-trade-reconciliation-manager.service.js';
import { TradingExecutorError } from '@/domain/trading/trading-executor.service.js';

var mockFindWalletByAgentId = jest.fn();

jest.mock('@/infrastructure/database/client.js', () => ({
  prisma: {
    agentPosition: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('@/infrastructure/cache/redis-agent-service.js', () => ({
  redisAgentService: {
    getActiveAgentIds: jest.fn(),
    getTradingMode: jest.fn(),
  },
}));

jest.mock('@/infrastructure/cache/idempotency-service.js', () => ({
  idempotencyService: {
    checkAndSet: jest.fn(),
  },
}));

jest.mock('@/domain/trading/config-service.js', () => ({
  configService: {
    loadAgentConfig: jest.fn(),
  },
}));

jest.mock('@/infrastructure/database/repositories/agent.repository.js', () => ({
  AgentRepository: jest.fn().mockImplementation(() => ({
    findWalletByAgentId: mockFindWalletByAgentId,
  })),
}));

jest.mock('@/domain/trading/auto-trade-market-cap-guard.js', () => ({
  evaluateAutoTradeMarketCapGuard: jest.fn(),
  hasAutoTradeMarketCapBounds: jest.fn((token: { marketCapMin?: number; marketCapMax?: number }) =>
    token.marketCapMin != null || token.marketCapMax != null
  ),
}));

jest.mock('@/domain/trading/trading-executor.service.js', () => ({
  tradingExecutor: {
    executePurchase: jest.fn(),
  },
  TradingExecutorError: class TradingExecutorError extends Error {
    code?: string;
    details?: Record<string, unknown>;
    constructor(message: string, code?: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
}));

jest.mock('@/infrastructure/logging/logger.js', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('AutoTradeReconciliationManager', () => {
  let mockPrisma: any;
  let mockRedisAgentService: any;
  let mockIdempotencyService: any;
  let mockConfigService: any;
  let mockEvaluateAutoTradeMarketCapGuard: jest.Mock;
  let mockTradingExecutor: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = (await import('@/infrastructure/database/client.js')).prisma;
    mockRedisAgentService = (await import('@/infrastructure/cache/redis-agent-service.js')).redisAgentService;
    mockIdempotencyService = (await import('@/infrastructure/cache/idempotency-service.js')).idempotencyService;
    mockConfigService = (await import('@/domain/trading/config-service.js')).configService;
    mockEvaluateAutoTradeMarketCapGuard = (await import('@/domain/trading/auto-trade-market-cap-guard.js')).evaluateAutoTradeMarketCapGuard as jest.Mock;
    mockTradingExecutor = (await import('@/domain/trading/trading-executor.service.js')).tradingExecutor;
    mockRedisAgentService.getActiveAgentIds.mockResolvedValue(['agent-1']);
    mockRedisAgentService.getTradingMode.mockResolvedValue('simulation');
    mockIdempotencyService.checkAndSet.mockResolvedValue(true);
    // Token without market-cap bounds so reconciliation processes it (tokens with bounds
    // are handled by the 30s market-cap monitor and skipped here).
    mockConfigService.loadAgentConfig.mockResolvedValue({
      autoTrade: {
        enabled: true,
        tokens: [{
          address: 'Token111111111111111111111111111111111111',
          symbol: 'TKN',
          enabled: true,
        }],
      },
    });
    mockPrisma.agentPosition.findFirst.mockResolvedValue(null);
    mockEvaluateAutoTradeMarketCapGuard.mockResolvedValue({
      allowed: true,
      reason: 'market_cap_in_range',
      marketCap: 1_200_000,
    });
    mockFindWalletByAgentId.mockResolvedValue({ walletAddress: 'wallet-1' });
    mockTradingExecutor.executePurchase.mockResolvedValue({
      transactionId: 'tx-1',
      positionId: 'pos-1',
    });
  });

  it('opens missing position when token is enabled and guard allows', async () => {
    const manager = new AutoTradeReconciliationManager();
    // runCycle is intentionally private runtime API; invoke via any for unit testing.
    await (manager as any).runCycle();

    expect(mockTradingExecutor.executePurchase).toHaveBeenCalledWith({
      agentId: 'agent-1',
      walletAddress: 'wallet-1',
      tokenAddress: 'token111111111111111111111111111111111111',
      tokenSymbol: 'TKN',
    });
  });

  it('skips when active position already exists', async () => {
    mockPrisma.agentPosition.findFirst.mockResolvedValueOnce({ id: 'existing-pos' });

    const manager = new AutoTradeReconciliationManager();
    await (manager as any).runCycle();

    expect(mockTradingExecutor.executePurchase).not.toHaveBeenCalled();
  });

  it('skips when market-cap guard blocks token', async () => {
    mockEvaluateAutoTradeMarketCapGuard.mockResolvedValueOnce({
      allowed: false,
      reason: 'market_cap_unavailable',
      marketCap: null,
    });

    const manager = new AutoTradeReconciliationManager();
    await (manager as any).runCycle();

    expect(mockTradingExecutor.executePurchase).not.toHaveBeenCalled();
  });

  it('handles expected executor guardrails without throwing', async () => {
    mockTradingExecutor.executePurchase.mockRejectedValueOnce(
      new TradingExecutorError('insufficient balance', 'INSUFFICIENT_BALANCE')
    );

    const manager = new AutoTradeReconciliationManager();
    await expect((manager as any).runCycle()).resolves.toBeUndefined();
  });
});

