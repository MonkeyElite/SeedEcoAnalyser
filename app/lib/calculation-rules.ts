export type CalculationRules = {
  manualTimeWeight: number;
  automaticTimeWeight: number;
  laborCostMultiplier: number;
  machineCostMultiplier: number;
  byproductCreditMultiplier: number;
  skillSpeedMultiplier: number;
};

export const DEFAULT_CALCULATION_RULES: CalculationRules = {
  manualTimeWeight: 1,
  automaticTimeWeight: 1,
  laborCostMultiplier: 1,
  machineCostMultiplier: 1,
  byproductCreditMultiplier: 1,
  skillSpeedMultiplier: 1,
};

export function sanitizeCalculationRules(value?: Partial<CalculationRules> | null): CalculationRules {
  const number = (candidate: unknown, fallback: number, maximum = 10) => {
    const parsed = typeof candidate === "number" ? candidate : Number(candidate);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(0, parsed)) : fallback;
  };
  return {
    manualTimeWeight: number(value?.manualTimeWeight, DEFAULT_CALCULATION_RULES.manualTimeWeight, 5),
    automaticTimeWeight: number(value?.automaticTimeWeight, DEFAULT_CALCULATION_RULES.automaticTimeWeight, 5),
    laborCostMultiplier: number(value?.laborCostMultiplier, DEFAULT_CALCULATION_RULES.laborCostMultiplier),
    machineCostMultiplier: number(value?.machineCostMultiplier, DEFAULT_CALCULATION_RULES.machineCostMultiplier),
    byproductCreditMultiplier: number(value?.byproductCreditMultiplier, DEFAULT_CALCULATION_RULES.byproductCreditMultiplier),
    skillSpeedMultiplier: number(value?.skillSpeedMultiplier, DEFAULT_CALCULATION_RULES.skillSpeedMultiplier, 2),
  };
}

export function calculationRulesAreDefault(rules: CalculationRules): boolean {
  return (Object.keys(DEFAULT_CALCULATION_RULES) as Array<keyof CalculationRules>)
    .every((key) => Math.abs(rules[key] - DEFAULT_CALCULATION_RULES[key]) < 1e-9);
}
