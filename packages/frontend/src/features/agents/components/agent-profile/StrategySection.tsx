'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Form } from '@/shared/components/ui/form';
import { Button } from '@/shared/components/ui/button';
import { AlertCircle, Check, Download, FolderInput } from 'lucide-react';
import { useToast } from '@/shared/hooks/use-toast';
import { useUpdateAgentTradingConfig } from '@/features/agents';
import { useUnsavedChanges } from '@/features/agents/contexts/unsaved-changes.context';
import { LoadingSpinner } from '@/shared/components';
import { agentTradingConfigSchema, type AgentTradingConfigFormValues } from './trading-config-form-schema';
import { PurchaseAndPositionSection } from './PurchaseAndPositionSection';
import { StopLossSection } from './StopLossSection';
import { StaleTradeSection } from './StaleTradeSection';
import { DCASection } from './DCASection';
import { TakeProfitSection } from './TakeProfitSection';
import { SignalsSection } from './SignalsSection';
import { RiskManagementSection } from './RiskManagementSection';
import { AutoTradeSection } from './AutoTradeSection';
import { LoadFromAgentDialog } from './LoadFromAgentDialog';
import { downloadTradingConfigJson } from '../../utils/trading-config-export';
import type { AgentTradingConfig } from '@nexgent/shared';

/** Optional signal metric keys; undefined means "no bound". We send null when cleared so the backend receives the key and can clear the value. */
const OPTIONAL_SIGNAL_METRIC_KEYS = [
  'marketCapMin', 'marketCapMax', 'liquidityMin', 'liquidityMax', 'holderCountMin', 'holderCountMax',
] as const;
/** Per-token optional metric keys on AutoTradeTokenConfig; same null-for-clear convention. */
const OPTIONAL_AUTO_TRADE_TOKEN_METRIC_KEYS = ['marketCapMin', 'marketCapMax'] as const;

/**
 * Normalize auto-trade shape for the form.
 * Per-token market-cap bounds are preserved as-is (null → undefined handled by Zod).
 */
function normalizeAutoTradeConfig(config: AgentTradingConfig): AgentTradingConfig {
  const autoTrade = config.autoTrade;
  if (!autoTrade) {
    return {
      ...config,
      autoTrade: { enabled: false, tokens: [] },
    };
  }

  const tokens = Array.isArray(autoTrade.tokens)
    ? autoTrade.tokens.map((t) => ({
        ...t,
        marketCapMin: t.marketCapMin ?? undefined,
        marketCapMax: t.marketCapMax ?? undefined,
      }))
    : [];

  return {
    ...config,
    autoTrade: {
      enabled: autoTrade.enabled ?? false,
      tokens,
    },
  };
}

/** Default max slippage (5%) when not set. Used so the form always has a value for required maxPriceImpact. */
const DEFAULT_MAX_PRICE_IMPACT = 0.05;

/**
 * Normalize config for the strategy form: auto-trade + ensure maxPriceImpact is set (required field).
 */
function normalizeConfigForForm(config: AgentTradingConfig): AgentTradingConfig {
  const normalized = normalizeAutoTradeConfig(config);
  const limits = normalized.purchaseLimits;
  if (limits && limits.maxPriceImpact == null) {
    return {
      ...normalized,
      purchaseLimits: { ...limits, maxPriceImpact: DEFAULT_MAX_PRICE_IMPACT },
    };
  }
  return normalized;
}

function prepareTradingConfigPayload(values: AgentTradingConfigFormValues): Partial<AgentTradingConfig> {
  const payload = JSON.parse(JSON.stringify(values)) as AgentTradingConfig;
  const signals = payload.signals;
  if (signals) {
    for (const key of OPTIONAL_SIGNAL_METRIC_KEYS) {
      if (signals[key] === undefined) {
        (signals as unknown as Record<string, unknown>)[key] = null;
      }
    }
  }

  const autoTrade = payload.autoTrade;
  if (autoTrade?.tokens) {
    for (const token of autoTrade.tokens) {
      const raw = token as unknown as Record<string, unknown>;
      for (const key of OPTIONAL_AUTO_TRADE_TOKEN_METRIC_KEYS) {
        if (raw[key] === undefined) {
          raw[key] = null;
        }
      }
    }
  }

  // Derive purchase limits from position calculator
  if (payload.purchaseLimits && payload.positionCalculator) {
    const { positionSizes, solBalanceThresholds } = payload.positionCalculator;
    if (positionSizes) {
      const { small, medium, large } = positionSizes;
      const derivedMax = Math.max(
        small?.max ?? 0,
        medium?.max ?? 0,
        large?.max ?? 0
      );
      payload.purchaseLimits.maxPurchasePerToken = derivedMax > 0 ? derivedMax : 1;
    }
    // Derive minimumAgentBalance from Small threshold (minimum to trade = minimum to keep in reserve)
    if (solBalanceThresholds?.minimum != null) {
      payload.purchaseLimits.minimumAgentBalance = solBalanceThresholds.minimum;
    }
  }
  return payload;
}

interface StrategySectionProps {
  agentId: string;
  agentName: string;
  initialConfig: AgentTradingConfig;
}

const FORM_ID = 'strategy';

/**
 * Strategy Section Component
 *
 * Contains the trading configuration form with tabs for different sections.
 * Uses explicit Save button; registers with UnsavedChangesContext for navigation guard.
 */
export function StrategySection({ agentId, agentName, initialConfig }: StrategySectionProps) {
  const { toast } = useToast();
  const updateConfigMutation = useUpdateAgentTradingConfig();
  const unsavedContext = useUnsavedChanges();
  const [activeTab, setActiveTab] = React.useState('purchase');
  const [saveStatus, setSaveStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loadDialogOpen, setLoadDialogOpen] = React.useState(false);
  const lastSavedJson = React.useRef<string>(JSON.stringify(initialConfig));

  const form = useForm<AgentTradingConfigFormValues>({
    resolver: zodResolver(agentTradingConfigSchema),
    defaultValues: normalizeConfigForForm(initialConfig),
    mode: 'onChange',
  });

  const isDirty = form.formState.isDirty;
  const isValid = form.formState.isValid;

  // Sync when initialConfig changes (e.g. agent switch)
  React.useEffect(() => {
    form.reset(normalizeConfigForForm(initialConfig));
    lastSavedJson.current = JSON.stringify(initialConfig);
  }, [agentId, initialConfig, form]);

  // Register with unsaved changes context
  React.useEffect(() => {
    if (!unsavedContext) return;

    const save = async (): Promise<boolean> => {
      if (!form.formState.isDirty) return true;
      const valid = await form.trigger();
      if (!valid) return false;
      try {
        const values = form.getValues();
        const data = prepareTradingConfigPayload(values);
        const updatedConfig = await updateConfigMutation.mutateAsync({ agentId, data });
        form.reset(updatedConfig);
        lastSavedJson.current = JSON.stringify(updatedConfig);
        return true;
      } catch {
        return false;
      }
    };

    unsavedContext.registerForm(FORM_ID, {
      isDirty: () => form.formState.isDirty,
      save,
    });
    return () => unsavedContext.unregisterForm(FORM_ID);
  }, [unsavedContext, agentId, form, updateConfigMutation]);

  // Report dirty state changes
  React.useEffect(() => {
    unsavedContext?.updateFormDirty(FORM_ID, isDirty);
  }, [unsavedContext, isDirty]);

  const handleSave = async () => {
    if (!isDirty || !isValid || updateConfigMutation.isPending) return;
    setSaveStatus('saving');
    try {
      const values = form.getValues();
      const data = prepareTradingConfigPayload(values);
      const updatedConfig = await updateConfigMutation.mutateAsync({ agentId, data });
      form.reset(updatedConfig);
      lastSavedJson.current = JSON.stringify(updatedConfig);
      setSaveStatus('saved');
      unsavedContext?.updateFormDirty(FORM_ID, false);
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (error) {
      setSaveStatus('error');
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: error instanceof Error ? error.message : 'Failed to save. Please try again.',
      });
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const handleExportConfig = () => {
    downloadTradingConfigJson(initialConfig, agentName);
  };

  const handleLoadFromAgent = (config: AgentTradingConfig) => {
    form.reset(normalizeConfigForForm(config));
  };

  // Tab configuration
  const tabOptions = [
    { value: 'purchase', label: 'Purchase & Position' },
    { value: 'auto-trade', label: 'Auto Trade' },
    { value: 'signals', label: 'Signals' },
    { value: 'risk-management', label: 'Risk Management' },
    { value: 'stop-loss', label: 'Stop Loss' },
    { value: 'take-profit', label: 'Take-Profit' },
    { value: 'dca', label: 'DCA' },
    { value: 'stale-trade', label: 'Stale Trade' },
  ];

  const currentTabLabel = tabOptions.find(opt => opt.value === activeTab)?.label || 'Purchase & Position';

  const isSaving = updateConfigMutation.isPending;
  const canSave = isDirty && isValid && !isSaving;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>Trading Strategy</CardTitle>
            <CardDescription>
              Configure your agent's trading strategy settings including purchase limits, stop loss, and position sizing.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Button size="sm" variant="outline" onClick={handleExportConfig} title="Export config to JSON" className="w-full sm:w-auto">
              <Download className="h-4 w-4 mr-1" />
              Export
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLoadDialogOpen(true)} title="Load config from another agent" className="w-full sm:w-auto">
              <FolderInput className="h-4 w-4 mr-1" />
              Load from Agent
            </Button>
            {canSave && (
              <Button size="sm" onClick={handleSave} disabled={isSaving} className="w-full sm:w-auto">
                {saveStatus === 'saving' && <LoadingSpinner size="sm" className="mr-1" />}
                Save Changes
              </Button>
            )}
            {saveStatus === 'saving' && !canSave && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoadingSpinner size="sm" />
                <span>Saving...</span>
              </div>
            )}
            {saveStatus === 'saved' && (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <Check className="h-4 w-4" />
                <span>Saved</span>
              </div>
            )}
            {saveStatus === 'error' && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                <span>Save failed</span>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form className="space-y-6">
            {/* Validation errors - show prominently at top */}
            {Object.keys(form.formState.errors).length > 0 && (
              <Alert variant="destructive" className="border-2">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <strong>Fix the errors below before saving.</strong> Scroll down to find fields with validation issues (e.g. DCA levels order, required values).
                </AlertDescription>
              </Alert>
            )}

            {/* Mobile: Dropdown Select */}
            <div className="md:hidden">
              <Select value={activeTab} onValueChange={setActiveTab}>
                <SelectTrigger className="w-full">
                  <SelectValue>{currentTabLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tabOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Desktop: Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full hidden md:block">
              <TabsList className="w-auto">
                <TabsTrigger value="purchase">Purchase & Position</TabsTrigger>
                <TabsTrigger value="auto-trade">Auto Trade</TabsTrigger>
                <TabsTrigger value="signals">Signals</TabsTrigger>
                <TabsTrigger value="risk-management">Risk Management</TabsTrigger>
                <TabsTrigger value="stop-loss">Stop Loss</TabsTrigger>
                <TabsTrigger value="take-profit">Take-Profit</TabsTrigger>
                <TabsTrigger value="dca">DCA</TabsTrigger>
                <TabsTrigger value="stale-trade">Stale Trade</TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Tab Content */}
            <div className="space-y-4 mt-4">
              {activeTab === 'purchase' && <PurchaseAndPositionSection />}
              {activeTab === 'auto-trade' && <AutoTradeSection agentId={agentId} />}
              {activeTab === 'signals' && <SignalsSection />}
              {activeTab === 'risk-management' && <RiskManagementSection />}
              {activeTab === 'stop-loss' && <StopLossSection />}
              {activeTab === 'take-profit' && <TakeProfitSection />}
              {activeTab === 'dca' && <DCASection />}
              {activeTab === 'stale-trade' && <StaleTradeSection />}
            </div>

          </form>
        </Form>
      </CardContent>

      <LoadFromAgentDialog
        open={loadDialogOpen}
        onOpenChange={setLoadDialogOpen}
        currentAgentId={agentId}
        onLoadConfig={handleLoadFromAgent}
        hasUnsavedChanges={isDirty}
      />
    </Card>
  );
}
